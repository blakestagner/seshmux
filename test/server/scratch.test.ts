// scratch.ts: spawn + orphan sweep + owner-exit kill, all hermetic via an
// injected fake daemon (dialFn) — mirrors the fakeDaemon posture in
// routes-term.test.ts. A real tmp SESHMUX_CONFIG_DIR backs the association map so
// the "written before return" and prune semantics are exercised against disk.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let repoDir: string;
let prevConfigDir: string | undefined;

// A fake daemon connection: records spawn/kill calls, serves a scripted list().
function fakeDaemon(opts: {
  ptys: { ptyId: string; cwd: string; tmuxName: string | null; alive: boolean }[];
  spawnPtyId?: string;
}) {
  const spawns: { cwd?: string; args: string[] }[] = [];
  const kills: string[] = [];
  const conn = {
    list: async () => ({ ptys: opts.ptys }),
    spawn: async (params: { cwd?: string; args: string[] }) => {
      spawns.push(params);
      return { ptyId: opts.spawnPtyId ?? 'scratch-new' };
    },
    kill: async (ptyId: string) => {
      kills.push(ptyId);
      return {};
    },
    close: () => {},
  };
  const dialFn = (async () => conn) as never;
  return { conn, spawns, kills, dialFn };
}

async function store() {
  const mod = await import('../../server/lib/scratch-store');
  mod._resetScratchStoreForTest();
  return mod;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'smx-scratch-lib-'));
  repoDir = join(dir, 'repo');
  mkdirSync(repoDir, { recursive: true });
  prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
  process.env.SESHMUX_CONFIG_DIR = dir;
  (await import('../../server/lib/scratch-store'))._resetScratchStoreForTest();
});

afterEach(async () => {
  (await import('../../server/lib/scratch-store'))._resetScratchStoreForTest();
  if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
  else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('startScratchTerminal', () => {
  it('spawns a shell in the OWNER pty cwd (from list(), not any projectPath) and writes the map before returning', async () => {
    const s = await store();
    const { startScratchTerminal } = await import('../../server/lib/scratch');
    const fd = fakeDaemon({
      ptys: [{ ptyId: 'owner-1', cwd: repoDir, tmuxName: null, alive: true }],
      spawnPtyId: 'scratch-1',
    });

    const res = await startScratchTerminal('owner-1', { dialFn: fd.dialFn, shell: () => '/bin/bash' });

    expect(res).toEqual({ ptyId: 'scratch-1', existing: false });
    expect(fd.spawns).toEqual([{ cwd: repoDir, args: ['/bin/bash'] }]); // worktree-correct cwd, bare shell, no tmuxName
    // Map written BEFORE return (edge C) — the record is already on disk.
    const map = await s.readScratchMap();
    expect(map['scratch-1']).toMatchObject({ ownerPtyId: 'owner-1', cwd: repoDir, ownerTmuxName: null });
  });

  it('carries the owner tmux name into the record', async () => {
    await store();
    const { startScratchTerminal } = await import('../../server/lib/scratch');
    const fd = fakeDaemon({
      ptys: [{ ptyId: 'owner-1', cwd: repoDir, tmuxName: 'seshmux-repo-1', alive: true }],
      spawnPtyId: 'scratch-1',
    });
    await startScratchTerminal('owner-1', { dialFn: fd.dialFn, shell: () => '/bin/bash' });
    const map = (await import('../../server/lib/scratch-store')).readScratchMap;
    expect((await map())['scratch-1'].ownerTmuxName).toBe('seshmux-repo-1');
  });

  it('throws a client-fault error when the owner pty is missing/dead (route → 400)', async () => {
    await store();
    const { startScratchTerminal } = await import('../../server/lib/scratch');
    const fd = fakeDaemon({ ptys: [{ ptyId: 'owner-1', cwd: repoDir, tmuxName: null, alive: false }] });
    await expect(startScratchTerminal('owner-1', { dialFn: fd.dialFn, shell: () => '/bin/bash' }))
      .rejects.toThrow('owner session not found: owner-1');
    expect(fd.spawns).toHaveLength(0);
  });

  it('fails closed when the owner cwd no longer exists (decision 1 — never a fallback dir)', async () => {
    await store();
    const { startScratchTerminal } = await import('../../server/lib/scratch');
    const gone = join(dir, 'removed-worktree');
    const fd = fakeDaemon({ ptys: [{ ptyId: 'owner-1', cwd: gone, tmuxName: null, alive: true }] });
    await expect(startScratchTerminal('owner-1', { dialFn: fd.dialFn, shell: () => '/bin/bash' }))
      .rejects.toThrow(`session cwd no longer exists: ${gone}`);
    expect(fd.spawns).toHaveLength(0);
  });

  it('is idempotent per owner — a live existing scratch is returned without spawning', async () => {
    const s = await store();
    await s.addScratch('scratch-1', { ownerPtyId: 'owner-1', ownerTmuxName: null, cwd: repoDir, createdAt: 1 });
    const { startScratchTerminal } = await import('../../server/lib/scratch');
    const fd = fakeDaemon({
      ptys: [
        { ptyId: 'owner-1', cwd: repoDir, tmuxName: null, alive: true },
        { ptyId: 'scratch-1', cwd: repoDir, tmuxName: null, alive: true },
      ],
    });
    const res = await startScratchTerminal('owner-1', { dialFn: fd.dialFn, shell: () => '/bin/bash' });
    expect(res).toEqual({ ptyId: 'scratch-1', existing: true });
    expect(fd.spawns).toHaveLength(0);
  });

  it('re-adopts via tmux name after a daemon restart gave the owner a new ptyId', async () => {
    const s = await store();
    await s.addScratch('scratch-1', { ownerPtyId: 'old-owner', ownerTmuxName: 'seshmux-repo-1', cwd: repoDir, createdAt: 1 });
    const { startScratchTerminal } = await import('../../server/lib/scratch');
    const fd = fakeDaemon({
      ptys: [
        { ptyId: 'new-owner', cwd: repoDir, tmuxName: 'seshmux-repo-1', alive: true },
        { ptyId: 'scratch-1', cwd: repoDir, tmuxName: null, alive: true },
      ],
    });
    const res = await startScratchTerminal('new-owner', { dialFn: fd.dialFn, shell: () => '/bin/bash' });
    expect(res).toEqual({ ptyId: 'scratch-1', existing: true });
    expect(fd.spawns).toHaveLength(0);
  });

  it('prunes a dead scratch hit and spawns fresh', async () => {
    const s = await store();
    await s.addScratch('scratch-dead', { ownerPtyId: 'owner-1', ownerTmuxName: null, cwd: repoDir, createdAt: 1 });
    const { startScratchTerminal } = await import('../../server/lib/scratch');
    const fd = fakeDaemon({
      ptys: [
        { ptyId: 'owner-1', cwd: repoDir, tmuxName: null, alive: true },
        { ptyId: 'scratch-dead', cwd: repoDir, tmuxName: null, alive: false },
      ],
      spawnPtyId: 'scratch-new',
    });
    const res = await startScratchTerminal('owner-1', { dialFn: fd.dialFn, shell: () => '/bin/bash' });
    expect(res).toEqual({ ptyId: 'scratch-new', existing: false });
    expect(fd.spawns).toHaveLength(1);
    const map = await s.readScratchMap();
    expect(map['scratch-dead']).toBeUndefined();
    expect(map['scratch-new']).toBeDefined();
  });
});

describe('sweepOrphanScratch', () => {
  it('kills + prunes a scratch whose owner is gone', async () => {
    const s = await store();
    await s.addScratch('scratch-1', { ownerPtyId: 'owner-gone', ownerTmuxName: null, cwd: repoDir, createdAt: 1 });
    const { sweepOrphanScratch } = await import('../../server/lib/scratch');
    const fd = fakeDaemon({ ptys: [{ ptyId: 'scratch-1', cwd: repoDir, tmuxName: null, alive: true }] });
    const out = await sweepOrphanScratch({ dialFn: fd.dialFn });
    expect(out.killed).toEqual(['scratch-1']);
    expect(fd.kills).toEqual(['scratch-1']);
    expect(await s.readScratchMap()).toEqual({});
  });

  it('refreshes the owner ptyId when a tmux owner came back under a new id', async () => {
    const s = await store();
    await s.addScratch('scratch-1', { ownerPtyId: 'old-owner', ownerTmuxName: 'seshmux-repo-1', cwd: repoDir, createdAt: 1 });
    const { sweepOrphanScratch } = await import('../../server/lib/scratch');
    const fd = fakeDaemon({
      ptys: [
        { ptyId: 'new-owner', cwd: repoDir, tmuxName: 'seshmux-repo-1', alive: true },
        { ptyId: 'scratch-1', cwd: repoDir, tmuxName: null, alive: true },
      ],
    });
    const out = await sweepOrphanScratch({ dialFn: fd.dialFn });
    expect(out).toEqual({ killed: [], pruned: [] });
    expect(fd.kills).toEqual([]); // the live session must NOT be orphan-killed
    expect((await s.readScratchMap())['scratch-1'].ownerPtyId).toBe('new-owner');
  });

  it('prunes a stale entry whose scratch pty is dead (owner alive)', async () => {
    const s = await store();
    await s.addScratch('scratch-dead', { ownerPtyId: 'owner-1', ownerTmuxName: null, cwd: repoDir, createdAt: 1 });
    const { sweepOrphanScratch } = await import('../../server/lib/scratch');
    const fd = fakeDaemon({
      ptys: [
        { ptyId: 'owner-1', cwd: repoDir, tmuxName: null, alive: true },
        { ptyId: 'scratch-dead', cwd: repoDir, tmuxName: null, alive: false },
      ],
    });
    const out = await sweepOrphanScratch({ dialFn: fd.dialFn });
    expect(out.pruned).toEqual(['scratch-dead']);
    expect(fd.kills).toEqual([]);
    expect(await s.readScratchMap()).toEqual({});
  });

  it('is a no-op with no scratch entries (never dials)', async () => {
    await store();
    const { sweepOrphanScratch } = await import('../../server/lib/scratch');
    let dialed = false;
    const dialFn = (async () => { dialed = true; return { list: async () => ({ ptys: [] }), close: () => {} }; }) as never;
    const out = await sweepOrphanScratch({ dialFn });
    expect(out).toEqual({ killed: [], pruned: [] });
    expect(dialed).toBe(false);
  });
});

describe('handleScratchOnExit', () => {
  it('prunes the record when the SCRATCH pty itself exits', async () => {
    const s = await store();
    await s.addScratch('scratch-1', { ownerPtyId: 'owner-1', ownerTmuxName: null, cwd: repoDir, createdAt: 1 });
    const { handleScratchOnExit } = await import('../../server/lib/scratch');
    const fd = fakeDaemon({ ptys: [] });
    await handleScratchOnExit('scratch-1', { dialFn: fd.dialFn });
    expect(await s.readScratchMap()).toEqual({});
    expect(fd.kills).toEqual([]); // no kill cascade for the scratch's own exit
  });

  it('kills + prunes the owner shell when the OWNER pty exits', async () => {
    const s = await store();
    await s.addScratch('scratch-1', { ownerPtyId: 'owner-1', ownerTmuxName: null, cwd: repoDir, createdAt: 1 });
    const { handleScratchOnExit } = await import('../../server/lib/scratch');
    const fd = fakeDaemon({ ptys: [] });
    await handleScratchOnExit('owner-1', { dialFn: fd.dialFn });
    expect(fd.kills).toEqual(['scratch-1']);
    expect(await s.readScratchMap()).toEqual({});
  });

  it('is a no-op for an agent pty that owns no scratch (never dials)', async () => {
    const s = await store();
    await s.addScratch('scratch-1', { ownerPtyId: 'owner-1', ownerTmuxName: null, cwd: repoDir, createdAt: 1 });
    const { handleScratchOnExit } = await import('../../server/lib/scratch');
    let dialed = false;
    const dialFn = (async () => { dialed = true; return { kill: async () => ({}), close: () => {} }; }) as never;
    await handleScratchOnExit('some-other-agent', { dialFn });
    expect(dialed).toBe(false);
    expect(await s.readScratchMap()).toEqual({ 'scratch-1': { ownerPtyId: 'owner-1', ownerTmuxName: null, cwd: repoDir, createdAt: 1 } });
  });
});

describe('defaultShell', () => {
  it('is a generic tool resolution (SHELL / ComSpec), never an agent binary', async () => {
    const { defaultShell } = await import('../../server/lib/scratch');
    const shell = defaultShell();
    expect(typeof shell).toBe('string');
    expect(shell.length).toBeGreaterThan(0);
    if (process.platform !== 'win32') {
      const prev = process.env.SHELL;
      process.env.SHELL = '/bin/zsh';
      expect(defaultShell()).toBe('/bin/zsh');
      if (prev === undefined) delete process.env.SHELL;
      else process.env.SHELL = prev;
    }
  });
});

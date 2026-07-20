// POST/DELETE /api/term/scratch — hermetic via an injected fake daemon (dialFn)
// and a real tmp SESHMUX_CONFIG_DIR backing the association map, mirroring
// routes-term.test.ts's fakeDaemon posture.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import scratchTermRoutes, { type ScratchTermRouteDeps } from '../../server/routes/scratch-term';

let dir: string;
let repoDir: string;
let prevConfigDir: string | undefined;

function makeApp(deps: ScratchTermRouteDeps) {
  const f = Fastify();
  f.register(scratchTermRoutes, deps);
  return f;
}

function fakeDaemon(opts: {
  ptys: { ptyId: string; cwd: string; tmuxName: string | null; alive: boolean }[];
  spawnPtyId?: string;
}) {
  const kills: string[] = [];
  const conn = {
    list: async () => ({ ptys: opts.ptys }),
    spawn: async () => ({ ptyId: opts.spawnPtyId ?? 'scratch-new' }),
    kill: async (ptyId: string) => { kills.push(ptyId); return {}; },
    close: () => {},
  };
  return { dialFn: (async () => conn) as never, kills };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'smx-scratch-route-'));
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

describe('POST /api/term/scratch', () => {
  it('spawns and returns { ptyId, existing:false }', async () => {
    const fd = fakeDaemon({
      ptys: [{ ptyId: 'owner-1', cwd: repoDir, tmuxName: null, alive: true }],
      spawnPtyId: 'scratch-1',
    });
    const f = makeApp({ dialFn: fd.dialFn });
    const res = await f.inject({ method: 'POST', url: '/api/term/scratch', payload: { ownerPtyId: 'owner-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ptyId: 'scratch-1', existing: false });
  });

  it('400s when ownerPtyId is missing', async () => {
    const fd = fakeDaemon({ ptys: [] });
    const f = makeApp({ dialFn: fd.dialFn });
    const res = await f.inject({ method: 'POST', url: '/api/term/scratch', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('ownerPtyId is required');
  });

  it('400s when the owner session is not found (client fault)', async () => {
    const fd = fakeDaemon({ ptys: [{ ptyId: 'owner-1', cwd: repoDir, tmuxName: null, alive: false }] });
    const f = makeApp({ dialFn: fd.dialFn });
    const res = await f.inject({ method: 'POST', url: '/api/term/scratch', payload: { ownerPtyId: 'owner-1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('owner session not found');
  });

  it('400s (fail-closed) when the owner cwd no longer exists', async () => {
    const gone = join(dir, 'removed');
    const fd = fakeDaemon({ ptys: [{ ptyId: 'owner-1', cwd: gone, tmuxName: null, alive: true }] });
    const f = makeApp({ dialFn: fd.dialFn });
    const res = await f.inject({ method: 'POST', url: '/api/term/scratch', payload: { ownerPtyId: 'owner-1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('cwd no longer exists');
  });

  it('500s on a genuine daemon failure', async () => {
    const dialFn = (async () => { throw new Error('daemon connection closed'); }) as never;
    const f = makeApp({ dialFn });
    const res = await f.inject({ method: 'POST', url: '/api/term/scratch', payload: { ownerPtyId: 'owner-1' } });
    expect(res.statusCode).toBe(500);
  });
});

describe('DELETE /api/term/scratch/:ptyId', () => {
  it('404s (fail closed) when the ptyId is NOT a known scratch — can never kill an agent', async () => {
    const s = await import('../../server/lib/scratch-store');
    s._resetScratchStoreForTest();
    const fd = fakeDaemon({ ptys: [] });
    const f = makeApp({ dialFn: fd.dialFn });
    const res = await f.inject({ method: 'DELETE', url: '/api/term/scratch/agent-pty-1' });
    expect(res.statusCode).toBe(404);
    expect(fd.kills).toEqual([]); // the guard never reached daemon.kill
  });

  it('kills + prunes a known scratch', async () => {
    const s = await import('../../server/lib/scratch-store');
    await s.addScratch('scratch-1', { ownerPtyId: 'owner-1', ownerTmuxName: null, cwd: repoDir, createdAt: 1 });
    const fd = fakeDaemon({ ptys: [] });
    const f = makeApp({ dialFn: fd.dialFn });
    const res = await f.inject({ method: 'DELETE', url: '/api/term/scratch/scratch-1' });
    expect(res.statusCode).toBe(200);
    expect(fd.kills).toEqual(['scratch-1']);
    expect(await s.readScratchMap()).toEqual({});
  });
});

// Stage 5: the restore brain. PURE planReconcile (table-driven) + effectful
// reconcile (fakes injected via RestoreDeps). No real daemon, no real providers.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planReconcile, reconcile, _resetReconcileForTest, type LivePty } from '../../server/lib/restore';
import type { LedgerEntry } from '../../server/lib/live-ledger';

// ---- helpers ---------------------------------------------------------------

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ptyId: 'pty-1',
    tmuxName: null,
    provider: 'claude',
    cwd: '/tmp/repo',
    startedAt: 1000,
    sessionId: 'sess-1',
    ...over,
  };
}

function live(over: Partial<LivePty> = {}): LivePty {
  return { ptyId: 'pty-1', cwd: '/tmp/repo', tmuxName: null, alive: true, ...over };
}

const HOUR = 3600_000;

// ---- planReconcile (pure) --------------------------------------------------

describe('planReconcile', () => {
  it('holder entry live in both lists -> keepLive', () => {
    const e = entry();
    const p = planReconcile([e], [live()], [live()]);
    expect(p.keepLive).toEqual([{ entry: e, live: live() }]);
    expect(p.candidates).toEqual([]);
    expect(p.removeDead).toEqual([]);
  });

  it('holder entry live only in the SECOND list (rehydrate finished between lists) -> keepLive, NOT candidate', () => {
    const e = entry();
    const p = planReconcile([e], [], [live()]);
    expect(p.keepLive).toHaveLength(1);
    expect(p.candidates).toEqual([]);
  });

  it('holder entry absent in BOTH lists -> candidate', () => {
    const e = entry();
    const p = planReconcile([e], [], []);
    expect(p.candidates).toEqual([e]);
    expect(p.keepLive).toEqual([]);
    expect(p.removeDead).toEqual([]);
  });

  it('holder entry present but alive:false in both -> removeDead', () => {
    const e = entry();
    const p = planReconcile([e], [live({ alive: false })], [live({ alive: false })]);
    expect(p.removeDead).toEqual([e]);
    expect(p.keepLive).toEqual([]);
    expect(p.candidates).toEqual([]);
  });

  it('tmux entry whose live ptyId DIFFERS but tmuxName matches -> keepLive carrying the FRESH ptyId (never a candidate)', () => {
    const e = entry({ ptyId: 'old-pty', tmuxName: 'seshmux-repo-1' });
    const freshLive = live({ ptyId: 'fresh-pty', tmuxName: 'seshmux-repo-1' });
    const p = planReconcile([e], [freshLive], [freshLive]);
    expect(p.candidates).toEqual([]);
    expect(p.keepLive).toHaveLength(1);
    expect(p.keepLive[0].entry).toBe(e);
    expect(p.keepLive[0].live.ptyId).toBe('fresh-pty');
  });

  it('server-restart case: everything matches -> empty candidates + removeDead', () => {
    const a = entry({ ptyId: 'a', sessionId: 'sa' });
    const b = entry({ ptyId: 'b', tmuxName: 'seshmux-r-1', sessionId: 'sb' });
    const p = planReconcile(
      [a, b],
      [live({ ptyId: 'a' }), live({ ptyId: 'b', tmuxName: 'seshmux-r-1' })],
      [live({ ptyId: 'a' }), live({ ptyId: 'b', tmuxName: 'seshmux-r-1' })],
    );
    expect(p.candidates).toEqual([]);
    expect(p.removeDead).toEqual([]);
    expect(p.keepLive).toHaveLength(2);
  });
});

// ---- reconcile (effectful, fakes) ------------------------------------------

describe('reconcile', () => {
  let dir: string;
  let prevConfigDir: string | undefined;
  let existingCwd: string;
  let holdersDir: string;

  // module handles rebound per-test after the config dir moves
  let ledger: typeof import('../../server/lib/live-ledger');

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smx-rec-'));
    prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
    process.env.SESHMUX_CONFIG_DIR = dir;
    existingCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'smx-cwd-'));
    holdersDir = path.join(dir, 'holders');
    fs.mkdirSync(holdersDir, { recursive: true });

    ledger = await import('../../server/lib/live-ledger');
    ledger._resetLedgerForTest();
    _resetReconcileForTest();
  });

  afterEach(() => {
    ledger._resetLedgerForTest();
    _resetReconcileForTest();
    if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
    else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
    for (const d of [dir, existingCwd]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  // fake daemon: same conn returns list1 then list2 on successive list() calls
  function makeDial(list1: LivePty[], list2: LivePty[] = list1) {
    let n = 0;
    const conn = {
      list: async () => ({ ptys: n++ === 0 ? list1 : list2 }),
      close: () => {},
    };
    return (async () => conn) as any;
  }

  // fake provider registry: a single project at `existingCwd` and a session
  // table keyed by id -> mtime (absent id = unresumable).
  function makeProviders(sessions: Record<string, number>, projectPath = existingCwd) {
    const provider = {
      id: 'claude' as const,
      scanProjects: async () => [{ id: 'proj', path: projectPath, missing: false }],
      listSessions: async () => Object.entries(sessions).map(([id, mtime]) => ({ id, mtime })),
    };
    return (async () => [provider]) as any;
  }

  // a startSession fake that mimics Stage 3: it addEntry's a fresh ptyId for the
  // resumed session, exactly as the real startSession does.
  function makeStartSession() {
    let n = 0;
    const fn = vi.fn(async (input: any) => {
      const ptyId = `restored-${n++}`;
      await ledger.addEntry({
        ptyId,
        tmuxName: null,
        provider: input.provider,
        cwd: input.projectPath,
        startedAt: 5000,
        sessionId: input.resumeId,
      });
      return { ptyId, tabMeta: { ptyId, provider: input.provider, projectPath: input.projectPath, mode: 'resume', tmux: false } };
    });
    return fn;
  }

  const NOW = 1_000_000_000;
  const baseDeps = () => ({
    now: () => NOW,
    settleMs: 0,
    holdersDir,
    providersFn: makeProviders({ 'sess-1': NOW }),
  });

  it('happy path: one lost holder entry with a fresh, resumable session is re-spawned once; old entry removed', async () => {
    await ledger.addEntry(entry({ ptyId: 'old', cwd: existingCwd, sessionId: 'sess-1' }));
    const startSessionFn = makeStartSession();

    const n = await reconcile({
      ...baseDeps(),
      dialFn: makeDial([]), // absent in both lists -> candidate
      startSessionFn: startSessionFn as any,
    });

    expect(n).toBe(1);
    expect(startSessionFn).toHaveBeenCalledTimes(1);
    expect(startSessionFn.mock.calls[0][0]).toMatchObject({
      projectPath: existingCwd,
      provider: 'claude',
      resumeId: 'sess-1',
    });
    const entries = await ledger.readEntries();
    expect(entries.map((e) => e.ptyId)).not.toContain('old'); // old removed
    expect(entries).toHaveLength(1); // the spawn's own addEntry stands
    expect(entries[0].sessionId).toBe('sess-1');
  });

  it('B3: candidate with no sessionId is dropped, never spawned', async () => {
    await ledger.addEntry(entry({ ptyId: 'old', cwd: existingCwd, sessionId: undefined }));
    const startSessionFn = makeStartSession();

    const n = await reconcile({ ...baseDeps(), dialFn: makeDial([]), startSessionFn: startSessionFn as any });

    expect(n).toBe(0);
    expect(startSessionFn).not.toHaveBeenCalled();
    expect(await ledger.readEntries()).toHaveLength(0); // dropped
  });

  it('C2: cwd ENOENT drops the entry from the ledger', async () => {
    await ledger.addEntry(entry({ ptyId: 'old', cwd: path.join(existingCwd, 'gone'), sessionId: 'sess-1' }));
    const startSessionFn = makeStartSession();

    const n = await reconcile({ ...baseDeps(), dialFn: makeDial([]), startSessionFn: startSessionFn as any });

    expect(n).toBe(0);
    expect(startSessionFn).not.toHaveBeenCalled();
    expect(await ledger.readEntries()).toHaveLength(0);
  });

  it('C2: a non-ENOENT stat error (ENOTDIR) skips but KEEPS the entry', async () => {
    // cwd whose parent is a file -> stat throws ENOTDIR, not ENOENT.
    const asFile = path.join(dir, 'afile');
    fs.writeFileSync(asFile, 'x');
    await ledger.addEntry(entry({ ptyId: 'old', cwd: path.join(asFile, 'child'), sessionId: 'sess-1' }));
    const startSessionFn = makeStartSession();

    const n = await reconcile({ ...baseDeps(), dialFn: makeDial([]), startSessionFn: startSessionFn as any });

    expect(n).toBe(0);
    expect(startSessionFn).not.toHaveBeenCalled();
    expect(await ledger.readEntries()).toHaveLength(1); // kept for a later boot
  });

  it('Edge E: a holder-tier candidate with a live-pid holder json is skipped and kept', async () => {
    await ledger.addEntry(entry({ ptyId: 'wedged', cwd: existingCwd, sessionId: 'sess-1' }));
    fs.writeFileSync(path.join(holdersDir, 'wedged.json'), JSON.stringify({ ptyId: 'wedged', pid: 4242 }));
    const startSessionFn = makeStartSession();

    const n = await reconcile({
      ...baseDeps(),
      dialFn: makeDial([]),
      pidAlive: (pid) => pid === 4242, // wedged holder still alive
      startSessionFn: startSessionFn as any,
    });

    expect(n).toBe(0);
    expect(startSessionFn).not.toHaveBeenCalled();
    expect((await ledger.readEntries()).map((e) => e.ptyId)).toEqual(['wedged']); // kept
  });

  it('Edge E: a holder json whose pid is dead does NOT block the restore', async () => {
    await ledger.addEntry(entry({ ptyId: 'old', cwd: existingCwd, sessionId: 'sess-1' }));
    fs.writeFileSync(path.join(holdersDir, 'old.json'), JSON.stringify({ ptyId: 'old', pid: 4242 }));
    const startSessionFn = makeStartSession();

    const n = await reconcile({
      ...baseDeps(),
      dialFn: makeDial([]),
      pidAlive: () => false, // holder is dead
      startSessionFn: startSessionFn as any,
    });

    expect(n).toBe(1);
  });

  it('Recency: a session older than 48h is dropped, not restored', async () => {
    await ledger.addEntry(entry({ ptyId: 'old', cwd: existingCwd, sessionId: 'sess-1' }));
    const startSessionFn = makeStartSession();

    const n = await reconcile({
      ...baseDeps(),
      providersFn: makeProviders({ 'sess-1': NOW - 49 * HOUR }), // 49h stale
      dialFn: makeDial([]),
      startSessionFn: startSessionFn as any,
    });

    expect(n).toBe(0);
    expect(startSessionFn).not.toHaveBeenCalled();
    expect(await ledger.readEntries()).toHaveLength(0); // dropped
  });

  it('Unresumable: provider reports no such session -> dropped', async () => {
    await ledger.addEntry(entry({ ptyId: 'old', cwd: existingCwd, sessionId: 'sess-1' }));
    const startSessionFn = makeStartSession();

    const n = await reconcile({
      ...baseDeps(),
      providersFn: makeProviders({}), // empty session table
      dialFn: makeDial([]),
      startSessionFn: startSessionFn as any,
    });

    expect(n).toBe(0);
    expect(await ledger.readEntries()).toHaveLength(0);
  });

  it('Volume cap: 12 candidates -> 10 spawned, 2 kept', async () => {
    const sessions: Record<string, number> = {};
    for (let i = 0; i < 12; i++) {
      await ledger.addEntry(entry({ ptyId: `old-${i}`, cwd: existingCwd, sessionId: `s-${i}`, startedAt: 1000 + i }));
      sessions[`s-${i}`] = NOW;
    }
    const startSessionFn = makeStartSession();

    const n = await reconcile({
      ...baseDeps(),
      providersFn: makeProviders(sessions),
      dialFn: makeDial([]),
      maxRestores: 10,
      startSessionFn: startSessionFn as any,
    });

    expect(n).toBe(10);
    expect(startSessionFn).toHaveBeenCalledTimes(10);
    // newest startedAt first: s-11..s-2 restored; s-1 and s-0 kept in the ledger.
    const restoredIds = startSessionFn.mock.calls.map((c: any) => c[0].resumeId);
    expect(restoredIds).toContain('s-11');
    expect(restoredIds).not.toContain('s-0');
    const remaining = await ledger.readEntries();
    const keptOld = remaining.filter((e) => e.ptyId.startsWith('old-'));
    expect(keptOld.map((e) => e.sessionId).sort()).toEqual(['s-0', 's-1']);
  });

  it('Idempotence (B2): a second reconcile() in the same process restores nothing', async () => {
    await ledger.addEntry(entry({ ptyId: 'old', cwd: existingCwd, sessionId: 'sess-1' }));
    const startSessionFn = makeStartSession();
    const deps = { ...baseDeps(), dialFn: makeDial([]), startSessionFn: startSessionFn as any };

    const first = await reconcile(deps);
    const second = await reconcile(deps); // no _resetReconcileForTest between

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(startSessionFn).toHaveBeenCalledTimes(1);
  });

  it('Settle-recheck: an entry present only in list2 is treated as live, not restored', async () => {
    await ledger.addEntry(entry({ ptyId: 'p9', cwd: existingCwd, sessionId: 'sess-1' }));
    const startSessionFn = makeStartSession();

    const n = await reconcile({
      ...baseDeps(),
      dialFn: makeDial([], [live({ ptyId: 'p9', cwd: existingCwd })]), // absent list1, present list2
      startSessionFn: startSessionFn as any,
    });

    expect(n).toBe(0);
    expect(startSessionFn).not.toHaveBeenCalled();
  });

  it('spawn failure: the failed entry is dropped, remaining candidates still processed', async () => {
    await ledger.addEntry(entry({ ptyId: 'old-a', cwd: existingCwd, sessionId: 's-a', startedAt: 2000 }));
    await ledger.addEntry(entry({ ptyId: 'old-b', cwd: existingCwd, sessionId: 's-b', startedAt: 1000 }));

    let n = 0;
    const startSessionFn = vi.fn(async (input: any) => {
      if (n++ === 0) throw new Error('spawn boom'); // newest (s-a) fails
      await ledger.addEntry({ ptyId: 'restored-b', tmuxName: null, provider: input.provider, cwd: input.projectPath, startedAt: 5000, sessionId: input.resumeId });
      return { ptyId: 'restored-b', tabMeta: {} };
    });

    const count = await reconcile({
      ...baseDeps(),
      providersFn: makeProviders({ 's-a': NOW, 's-b': NOW }),
      dialFn: makeDial([]),
      startSessionFn: startSessionFn as any,
    });

    expect(count).toBe(1);
    expect(startSessionFn).toHaveBeenCalledTimes(2);
    const entries = await ledger.readEntries();
    expect(entries.map((e) => e.ptyId)).not.toContain('old-a'); // failed -> dropped
    expect(entries.map((e) => e.ptyId)).not.toContain('old-b'); // succeeded -> old removed
    expect(entries.map((e) => e.ptyId)).toContain('restored-b');
  });

  it('removeDead: an entry matched alive:false is removed and never restored', async () => {
    await ledger.addEntry(entry({ ptyId: 'dead', cwd: existingCwd, sessionId: 'sess-1' }));
    const startSessionFn = makeStartSession();

    const n = await reconcile({
      ...baseDeps(),
      dialFn: makeDial([live({ ptyId: 'dead', alive: false })]),
      startSessionFn: startSessionFn as any,
    });

    expect(n).toBe(0);
    expect(startSessionFn).not.toHaveBeenCalled();
    expect(await ledger.readEntries()).toHaveLength(0);
  });

  it('tmux keepLive refresh: a matched tmux entry gets its ptyId rewritten to the live one', async () => {
    await ledger.addEntry(entry({ ptyId: 'stale', tmuxName: 'seshmux-repo-1', cwd: existingCwd, sessionId: 'sess-1' }));
    const startSessionFn = makeStartSession();

    const n = await reconcile({
      ...baseDeps(),
      dialFn: makeDial([live({ ptyId: 'fresh', tmuxName: 'seshmux-repo-1', cwd: existingCwd })]),
      startSessionFn: startSessionFn as any,
    });

    expect(n).toBe(0);
    const entries = await ledger.readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].ptyId).toBe('fresh'); // refreshed
    expect(entries[0].tmuxName).toBe('seshmux-repo-1');
  });

  it('B2 dedupe: two candidates sharing a sessionId spawn only once', async () => {
    await ledger.addEntry(entry({ ptyId: 'old-a', cwd: existingCwd, sessionId: 'dup', startedAt: 2000 }));
    await ledger.addEntry(entry({ ptyId: 'old-b', cwd: existingCwd, sessionId: 'dup', startedAt: 1000 }));
    const startSessionFn = makeStartSession();

    const n = await reconcile({
      ...baseDeps(),
      providersFn: makeProviders({ dup: NOW }),
      dialFn: makeDial([]),
      startSessionFn: startSessionFn as any,
    });

    expect(n).toBe(1);
    expect(startSessionFn).toHaveBeenCalledTimes(1);
  });
});

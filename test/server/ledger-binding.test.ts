// Stage 4 (§1a): bindSessionFromWatch writes a watch event's sessionId onto the
// newest unbound ledger entry for the same repo + provider. Hermetic — real
// live-ledger against a temp SESHMUX_CONFIG_DIR, the real derivedWorkspaceParent
// canon, and an injected fake provider registry (no chokidar, no real scan).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function seed(entry: Parameters<Awaited<typeof import('../../server/lib/live-ledger')>['addEntry']>[0]) {
  const { addEntry } = await import('../../server/lib/live-ledger');
  await addEntry(entry);
}

// Fake provider registry: scanProjects returns exactly the projects passed in.
function fakeProviders(projects: { id: string; path: string }[]) {
  return async () => [
    {
      id: 'claude' as const,
      scanProjects: async () => projects as any,
    },
  ] as any;
}

describe('bindSessionFromWatch (§1a)', () => {
  let dir: string;
  let prevConfigDir: string | undefined;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seshmux-bind-'));
    prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
    process.env.SESHMUX_CONFIG_DIR = dir;
    const { _resetLedgerForTest } = await import('../../server/lib/live-ledger');
    _resetLedgerForTest();
  });

  afterEach(async () => {
    const { _resetLedgerForTest } = await import('../../server/lib/live-ledger');
    _resetLedgerForTest();
    if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
    else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it('binds the sessionId onto the unbound entry for the project path', async () => {
    await seed({ ptyId: 'p1', tmuxName: null, provider: 'claude', cwd: '/repo/a', startedAt: 1 });
    const { bindSessionFromWatch } = await import('../../server/lib/ledger-binding');
    const { readEntries } = await import('../../server/lib/live-ledger');

    const bound = await bindSessionFromWatch('claude', 'proj-a', 'sess-1', {
      providersFn: fakeProviders([{ id: 'proj-a', path: '/repo/a' }]),
    });

    expect(bound).toBe(true);
    expect((await readEntries())[0].sessionId).toBe('sess-1');
  });

  it('folds a worktree cwd to the parent repo path and still binds', async () => {
    // A recorded worktree cwd folds via the REAL derivedWorkspaceParent
    // (.claude/worktrees/<x>) to the parent repo the projectId names.
    await seed({
      ptyId: 'p1',
      tmuxName: null,
      provider: 'claude',
      cwd: '/repo/a/.claude/worktrees/wt1',
      startedAt: 1,
    });
    const { bindSessionFromWatch } = await import('../../server/lib/ledger-binding');
    const { readEntries } = await import('../../server/lib/live-ledger');

    const bound = await bindSessionFromWatch('claude', 'proj-a', 'sess-wt', {
      providersFn: fakeProviders([{ id: 'proj-a', path: '/repo/a' }]),
    });

    expect(bound).toBe(true);
    expect((await readEntries())[0].sessionId).toBe('sess-wt');
  });

  it('leaves an already-bound ledger untouched (fast-path skip)', async () => {
    await seed({ ptyId: 'p1', tmuxName: null, provider: 'claude', cwd: '/repo/a', startedAt: 1, sessionId: 'old' });
    const { bindSessionFromWatch } = await import('../../server/lib/ledger-binding');
    const { readEntries } = await import('../../server/lib/live-ledger');

    const bound = await bindSessionFromWatch('claude', 'proj-a', 'sess-new', {
      providersFn: fakeProviders([{ id: 'proj-a', path: '/repo/a' }]),
    });

    expect(bound).toBe(false);
    expect((await readEntries())[0].sessionId).toBe('old'); // unchanged
  });

  it('no-ops when the projectId resolves to no known project', async () => {
    await seed({ ptyId: 'p1', tmuxName: null, provider: 'claude', cwd: '/repo/a', startedAt: 1 });
    const { bindSessionFromWatch } = await import('../../server/lib/ledger-binding');
    const { readEntries } = await import('../../server/lib/live-ledger');

    const bound = await bindSessionFromWatch('claude', 'unknown-proj', 'sess-x', {
      providersFn: fakeProviders([{ id: 'proj-a', path: '/repo/a' }]),
    });

    expect(bound).toBe(false);
    expect((await readEntries())[0].sessionId).toBeUndefined(); // still unbound
  });
});

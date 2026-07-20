// Spec 6: GET /api/term/:ptyId/status-explain. Hermetic — getStatusExplain is
// injected (mirrors BridgeRouteDeps injection in test/routes-bridge.test.ts), so
// this never touches the real events-hub/daemon.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import termRoutes, { defaultResolveSessionForCwd, type TermRouteDeps } from '../../server/routes/term';
import type { StatusExplain } from '../../server/events-hub';

function makeApp(deps: TermRouteDeps) {
  const f = Fastify();
  f.register(termRoutes, deps);
  return f;
}

const sampleExplain: StatusExplain = {
  status: 'waiting',
  evidence: {
    status: 'waiting',
    branch: 'prompt-frame',
    matchedPattern: 'Esc to cancel',
    msSinceLastOutput: 0,
    lastFrameWaiting: false,
  },
  hookOverride: null,
  lastLines: ['1. Yes', '2. Yes, and don\'t ask again', '3. No'],
};

describe('GET /api/term/:ptyId/status-explain', () => {
  it('returns the hub evidence for a known ptyId', async () => {
    const f = makeApp({ getStatusExplain: (ptyId) => (ptyId === 'pty-1' ? sampleExplain : null) });
    const res = await f.inject({ method: 'GET', url: '/api/term/pty-1/status-explain' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(sampleExplain);
  });

  it('names the matching manifest pattern in the evidence', async () => {
    const f = makeApp({ getStatusExplain: () => sampleExplain });
    const res = await f.inject({ method: 'GET', url: '/api/term/pty-1/status-explain' });
    expect(res.json().evidence.matchedPattern).toBe('Esc to cancel');
    expect(res.json().evidence.branch).toBe('prompt-frame');
  });

  it('reports whether hook status overrode heuristics', async () => {
    const withOverride: StatusExplain = {
      ...sampleExplain,
      hookOverride: { path: '/config/status/pty-1.json', ageMs: 1200, hookStatus: 'waiting' },
    };
    const f = makeApp({ getStatusExplain: () => withOverride });
    const res = await f.inject({ method: 'GET', url: '/api/term/pty-1/status-explain' });
    expect(res.json().hookOverride).toMatchObject({ hookStatus: 'waiting', ageMs: 1200 });
  });

  it('404s for an unknown/never-classified ptyId', async () => {
    const f = makeApp({ getStatusExplain: () => null });
    const res = await f.inject({ method: 'GET', url: '/api/term/nope/status-explain' });
    expect(res.statusCode).toBe(404);
  });

  it('501s when no getStatusExplain is injected (hub not wired)', async () => {
    const f = makeApp({});
    const res = await f.inject({ method: 'GET', url: '/api/term/pty-1/status-explain' });
    expect(res.statusCode).toBe(501);
  });

  it('includes the last classified lines', async () => {
    const f = makeApp({ getStatusExplain: () => sampleExplain });
    const res = await f.inject({ method: 'GET', url: '/api/term/pty-1/status-explain' });
    expect(res.json().lastLines).toContain('1. Yes');
  });
});

// BUG A part 2 (docs/plans/2026-07-10-subagent-attach-bugs-rootcause.md): on
// reload, GET /api/sessions/live must resolve each live PTY's sessionId (by
// cwd) so the subagent chip gate is satisfied without waiting for a live
// session-new/touch event. resolveSessionForCwd is injected — hermetic, never
// touches the real provider scan/daemon.
describe('GET /api/sessions/live', () => {
  function fakeDaemon(ptys: { ptyId: string; cwd: string; tmuxName: string | null; alive: boolean }[]) {
    return { list: async () => ({ ptys }), close: () => {} };
  }

  it('enriches each live PTY with sessionId resolved by cwd', async () => {
    const f = makeApp({
      dialFn: (async () => fakeDaemon([{ ptyId: 'pty-1', cwd: '/repo/a', tmuxName: null, alive: true }])) as never,
      resolveSessionForCwd: async (cwd) => (cwd === '/repo/a' ? { sessionId: 's1' } : {}),
    });
    const res = await f.inject({ method: 'GET', url: '/api/sessions/live' });
    expect(res.json().live).toEqual([
      { ptyId: 'pty-1', cwd: '/repo/a', tmuxName: null, sessionId: 's1', kind: 'agent' },
    ]);
  });

  it('omits sessionId (not fails) when the resolver finds no match', async () => {
    const f = makeApp({
      dialFn: (async () => fakeDaemon([{ ptyId: 'pty-1', cwd: '/repo/unknown', tmuxName: null, alive: true }])) as never,
      resolveSessionForCwd: async () => ({}),
    });
    const res = await f.inject({ method: 'GET', url: '/api/sessions/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json().live[0].sessionId).toBeUndefined();
  });

  it('filters out dead PTYs before resolving', async () => {
    const calls: string[] = [];
    const f = makeApp({
      dialFn: (async () =>
        fakeDaemon([
          { ptyId: 'pty-1', cwd: '/repo/a', tmuxName: null, alive: false },
          { ptyId: 'pty-2', cwd: '/repo/b', tmuxName: null, alive: true },
        ])) as never,
      resolveSessionForCwd: async (cwd) => {
        calls.push(cwd);
        return {};
      },
    });
    const res = await f.inject({ method: 'GET', url: '/api/sessions/live' });
    expect(res.json().live).toHaveLength(1);
    expect(calls).toEqual(['/repo/b']);
  });

  it('returns empty live list (not an error) when the daemon is unreachable', async () => {
    const f = makeApp({ dialFn: (async () => { throw new Error('ECONNREFUSED'); }) as never });
    const res = await f.inject({ method: 'GET', url: '/api/sessions/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json().live).toEqual([]);
  });
});

// Scratch annotation (scratch-terminal Spec, Stage 3): getLive marks scratch PTYs
// kind:'scratch' + owner fields and SKIPS session-enrichment for them (a rehydrated
// shell must never bind to a real session), while agents still enrich as before.
describe('GET /api/sessions/live — scratch annotation', () => {
  let dir: string;
  let prevConfigDir: string | undefined;

  function fakeDaemon(ptys: { ptyId: string; cwd: string; tmuxName: string | null; alive: boolean }[]) {
    return { list: async () => ({ ptys }), close: () => {} };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'smx-live-scratch-'));
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

  it('marks a scratch PTY kind:scratch with owner fields and no session ids; still enriches the sibling agent', async () => {
    const s = await import('../../server/lib/scratch-store');
    await s.addScratch('scratch-1', { ownerPtyId: 'owner-1', ownerTmuxName: 'seshmux-repo-1', cwd: '/repo/a', createdAt: 1 });

    let resolveCalls = 0;
    const f = makeApp({
      dialFn: (async () => fakeDaemon([
        { ptyId: 'owner-1', cwd: '/repo/a', tmuxName: 'seshmux-repo-1', alive: true },
        { ptyId: 'scratch-1', cwd: '/repo/a', tmuxName: null, alive: true },
      ])) as never,
      resolveSessionForCwd: async () => { resolveCalls++; return { projectId: 'p1', sessionId: 's1' }; },
    });

    const res = await f.inject({ method: 'GET', url: '/api/sessions/live' });
    const live = res.json().live as any[];

    const scratch = live.find((l) => l.ptyId === 'scratch-1');
    expect(scratch).toEqual({
      ptyId: 'scratch-1',
      cwd: '/repo/a',
      tmuxName: null,
      kind: 'scratch',
      ownerPtyId: 'owner-1',
      ownerTmuxName: 'seshmux-repo-1',
    });
    expect(scratch.sessionId).toBeUndefined();
    expect(scratch.projectId).toBeUndefined();

    const agent = live.find((l) => l.ptyId === 'owner-1');
    expect(agent).toMatchObject({ kind: 'agent', sessionId: 's1', projectId: 'p1' });

    // The scratch cwd shares the agent's, so the memoized resolve runs at most once —
    // and NEVER for the scratch's own binding.
    expect(resolveCalls).toBe(1);
  });
});

// A daemon that predates the additive `history` RPC is EXPECTED (the daemon outlives server
// updates by design) and the UI degrades to the ring buffer — so it must NOT be an error
// status: the browser logs any 4xx/5xx as a red console error on a perfectly healthy app.
describe('GET /api/term/:ptyId/history — unsupported is a 200 answer, not a failure', () => {
  it('returns { supported: true, data } when the daemon has the method', async () => {
    const f = makeApp({
      dialFn: (async () => ({ history: async () => ({ data: 'scrollback' }), close: () => {} })) as never,
    });
    const res = await f.inject({ method: 'GET', url: '/api/term/pty-1/history' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ supported: true, data: 'scrollback' });
  });

  it('answers 200 { supported: false } (not 501) when the daemon lacks the method', async () => {
    const f = makeApp({
      dialFn: (async () => ({
        history: async () => { throw new Error('unknown method: history'); },
        close: () => {},
      })) as never,
    });
    const res = await f.inject({ method: 'GET', url: '/api/term/pty-1/history' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ supported: false, data: '' });
  });

  it('still 500s on a genuine daemon failure', async () => {
    const f = makeApp({
      dialFn: (async () => ({
        history: async () => { throw new Error('pty not found'); },
        close: () => {},
      })) as never,
    });
    const res = await f.inject({ method: 'GET', url: '/api/term/pty-1/history' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain('pty not found');
  });
});

// Worktree fold: a PTY running in <repo>/.claude/worktrees/<x> has a cwd that equals
// NO project.path (the scan folds it into the parent), so the resolver must
// canonicalize before matching — and must bind to the session that ran in THIS cwd,
// not the parent repo's newer, unrelated session. Providers are injected (fakes).
describe('defaultResolveSessionForCwd (worktree fold)', () => {
  const repo = '/Users/demo/GitHub/seshmux';
  const wt = `${repo}/.claude/worktrees/agent-a`;
  const projectId = '-Users-demo-GitHub-seshmux';
  const providersFn = (async () => [
    {
      scanProjects: async () => [{ id: projectId, path: repo }],
      listSessions: async () => [
        { id: 'parent-newest', mtime: 100, cwd: repo, branch: 'main' },
        { id: 'wt-sess', mtime: 50, cwd: wt, branch: 'agent/a-1' },
      ],
    },
  ]) as never;

  it('maps a worktree PTY cwd to the parent project and its OWN session (+ branch)', async () => {
    expect(await defaultResolveSessionForCwd(wt, providersFn)).toEqual({
      projectId,
      sessionId: 'wt-sess',
      branch: 'agent/a-1',
    });
  });

  it('a plain repo cwd still resolves to the newest session (+ branch)', async () => {
    expect(await defaultResolveSessionForCwd(repo, providersFn)).toEqual({
      projectId,
      sessionId: 'parent-newest',
      branch: 'main',
    });
  });
});

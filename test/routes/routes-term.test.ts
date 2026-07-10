// Spec 6: GET /api/term/:ptyId/status-explain. Hermetic — getStatusExplain is
// injected (mirrors BridgeRouteDeps injection in test/routes-bridge.test.ts), so
// this never touches the real events-hub/daemon.

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import termRoutes, { type TermRouteDeps } from '../../server/routes/term';
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
      resolveSessionForCwd: async (cwd) => (cwd === '/repo/a' ? 's1' : undefined),
    });
    const res = await f.inject({ method: 'GET', url: '/api/sessions/live' });
    expect(res.json().live).toEqual([{ ptyId: 'pty-1', cwd: '/repo/a', tmuxName: null, sessionId: 's1' }]);
  });

  it('omits sessionId (not fails) when the resolver finds no match', async () => {
    const f = makeApp({
      dialFn: (async () => fakeDaemon([{ ptyId: 'pty-1', cwd: '/repo/unknown', tmuxName: null, alive: true }])) as never,
      resolveSessionForCwd: async () => undefined,
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
        return undefined;
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

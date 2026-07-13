import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import envRoutes from '../../server/routes/env';

describe('GET /api/env — bridge status', () => {
  it('includes bridge registration status from the injected bridgeStatus', async () => {
    const f = Fastify();
    f.register(envRoutes, { bridgeStatus: async () => ({ claude: true, codex: false }) });
    const res = await f.inject({ method: 'GET', url: '/api/env' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bridge).toEqual({
      claude: { registered: true },
      codex: { registered: false },
    });
    // still carries the real detection fields (claude/codex/tmux/rg present).
    expect(body).toHaveProperty('claude');
    expect(body).toHaveProperty('tmux');
    // per-provider command previews (NewSessionModal renders these instead of
    // hardcoding binaries — hard rule 3): every provider gets fresh/continue/hasPlan.
    for (const preview of Object.values(body.commands as Record<string, any>)) {
      expect(preview.fresh).toBeTruthy();
      expect(preview.continue).toBeTruthy();
      expect(preview).toHaveProperty('hasPlan');
    }
    expect(Object.keys(body.commands).length).toBeGreaterThan(0);
    // Task 5 Step 1b: claude reports its teammateMode gate value (undefined
    // is valid — just means "not tmux/iterm2", codex omits the key entirely
    // since it has no TeamSupport).
    expect(body.teams).toHaveProperty('claude');
    expect(body.teams.claude).toHaveProperty('teammateMode');
    expect(body.teams).not.toHaveProperty('codex');
  });

  it('degrades to unregistered when bridgeStatus throws, never 500s', async () => {
    const f = Fastify();
    f.register(envRoutes, { bridgeStatus: async () => { throw new Error('config unreadable'); } });
    const res = await f.inject({ method: 'GET', url: '/api/env' });
    expect(res.statusCode).toBe(200);
    expect(res.json().bridge).toEqual({ claude: { registered: false }, codex: { registered: false } });
  });
});

// The daemon survives server updates (hard rule 4), so it can sit on old code indefinitely
// after `Update & restart`. /api/env carries the comparison so Settings can nudge for a full
// restart. Never nag when either version is unknown (a dev server has no SESHMUX_VERSION).
describe('GET /api/env — daemon staleness', () => {
  const base = { bridgeStatus: async () => ({ claude: false, codex: false }) };

  async function envDaemon(deps: Record<string, unknown>) {
    const f = Fastify();
    f.register(envRoutes, { ...base, ...deps });
    const res = await f.inject({ method: 'GET', url: '/api/env' });
    expect(res.statusCode).toBe(200);
    return res.json().daemon;
  }

  it('reports stale when the daemon version is older than the server version', async () => {
    expect(await envDaemon({ daemonVersion: async () => '0.9.0', serverVersion: () => '0.10.0' })).toEqual({
      version: '0.9.0',
      serverVersion: '0.10.0',
      stale: true,
    });
  });

  it('is not stale when the versions match', async () => {
    const d = await envDaemon({ daemonVersion: async () => '1.2.3', serverVersion: () => '1.2.3' });
    expect(d.stale).toBe(false);
  });

  it('never nags in dev (no server version) or when the daemon is unreachable', async () => {
    expect((await envDaemon({ daemonVersion: async () => '0.1.0', serverVersion: () => '' })).stale).toBe(false);
    expect((await envDaemon({ daemonVersion: async () => null, serverVersion: () => '9.9.9' })).stale).toBe(false);
  });

  it('never 500s when the daemon dial throws', async () => {
    const d = await envDaemon({
      daemonVersion: async () => { throw new Error('ECONNREFUSED'); },
      serverVersion: () => '1.0.0',
    });
    expect(d).toEqual({ version: null, serverVersion: '1.0.0', stale: false });
  });
});

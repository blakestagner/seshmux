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
  });

  it('degrades to unregistered when bridgeStatus throws, never 500s', async () => {
    const f = Fastify();
    f.register(envRoutes, { bridgeStatus: async () => { throw new Error('config unreadable'); } });
    const res = await f.inject({ method: 'GET', url: '/api/env' });
    expect(res.statusCode).toBe(200);
    expect(res.json().bridge).toEqual({ claude: { registered: false }, codex: { registered: false } });
  });
});

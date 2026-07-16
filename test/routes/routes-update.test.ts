import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import updateRoutes, { type UpdateRouteDeps } from '../../server/routes/update';

// Build a fastify app with the update routes and injected deps (no network / npm).
function app(deps: UpdateRouteDeps) {
  const f = Fastify();
  f.register(updateRoutes, deps);
  return f;
}

describe('GET /api/update/check', () => {
  it('returns the update status from the injected checker', async () => {
    const f = app({
      checkUpdate: async () => ({ current: '1.0.0', latest: '1.2.0', updateAvailable: true, installMethod: 'global' }),
      applyUpdate: async () => ({ ok: true, log: '', previous: '1.0.0' }),
    });
    const res = await f.inject({ method: 'GET', url: '/api/update/check' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ latest: '1.2.0', updateAvailable: true });
  });
});

describe('POST /api/update/apply', () => {
  it('applies then fires the injected onApplied callback (restart choreography seam)', async () => {
    let applied: { ok: boolean; previous: string } | null = null;
    const f = app({
      checkUpdate: async () => ({ current: '1.0.0', latest: '1.2.0', updateAvailable: true, installMethod: 'global' }),
      applyUpdate: async () => ({ ok: true, log: 'added 1 package', previous: '1.0.0' }),
      onApplied: async (r) => { applied = { ok: r.ok, previous: r.previous }; },
    });
    const res = await f.inject({ method: 'POST', url: '/api/update/apply' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, log: 'added 1 package' });
    expect(applied).toEqual({ ok: true, previous: '1.0.0' });
  });

  it('does not fire onApplied when the install fails, returns ok:false', async () => {
    let fired = false;
    const f = app({
      checkUpdate: async () => ({ current: '1.0.0', latest: '1.2.0', updateAvailable: true, installMethod: 'global' }),
      applyUpdate: async () => ({ ok: false, log: 'EACCES', previous: '1.0.0' }),
      onApplied: async () => { fired = true; },
    });
    const res = await f.inject({ method: 'POST', url: '/api/update/apply' });
    expect(res.json()).toMatchObject({ ok: false });
    expect(fired).toBe(false); // no restart on a failed install
  });

  it('surfaces an applyUpdate rejection (e.g. npx) as a 4xx, no crash', async () => {
    const f = app({
      checkUpdate: async () => ({ current: '1.0.0', latest: '1.2.0', updateAvailable: true, installMethod: 'npx' }),
      applyUpdate: async () => { throw new Error('cannot self-update an npx invocation'); },
    });
    const res = await f.inject({ method: 'POST', url: '/api/update/apply' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/npx/i);
  });
});

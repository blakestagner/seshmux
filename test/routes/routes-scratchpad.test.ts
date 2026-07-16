import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import scratchpadRoutes from '../../server/routes/scratchpad';

// A real temp repo dir; projectId decodes to a path — inject a resolver so the test controls
// which filesystem path a projectId maps to (avoids depending on a real ~/… repo).
let repo: string;
function makeApp() {
  const f = Fastify();
  f.register(scratchpadRoutes, {
    // resolveRepo: projectId → absolute repo path. Return null to simulate a missing repo.
    resolveRepo: (projectId: string) => (projectId === 'demo' ? repo : null),
  });
  return f;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'scratch-'));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('GET /api/scratchpad/:projectId', () => {
  it('returns empty content before anything is written', async () => {
    const f = makeApp();
    const res = await f.inject({ method: 'GET', url: '/api/scratchpad/demo' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ content: '' });
  });

  it('404s an unknown / unresolvable projectId', async () => {
    const f = makeApp();
    const res = await f.inject({ method: 'GET', url: '/api/scratchpad/unknown' });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /api/scratchpad/:projectId', () => {
  const origin = 'http://127.0.0.1:4700';

  it('writes handoff.md and reads it back', async () => {
    const f = makeApp();
    const put = await f.inject({
      method: 'PUT',
      url: '/api/scratchpad/demo',
      headers: { origin },
      payload: { content: '# notes\nhello from claude' },
    });
    expect(put.statusCode).toBe(200);
    const get = await f.inject({ method: 'GET', url: '/api/scratchpad/demo' });
    expect(get.json().content).toContain('hello from claude');
  });

  it('404s a PUT to an unresolvable projectId (no traversal / no write)', async () => {
    const f = makeApp();
    const res = await f.inject({
      method: 'PUT',
      url: '/api/scratchpad/unknown',
      headers: { origin },
      payload: { content: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a traversal-y projectId that resolves outside a real dir', async () => {
    const f = Fastify();
    // resolver returns a non-existent path (simulating a traversal escape) — route must
    // validate the resolved path is a real directory and refuse.
    f.register(scratchpadRoutes, { resolveRepo: () => '/no/such/dir/anywhere' });
    const res = await f.inject({
      method: 'PUT',
      url: '/api/scratchpad/evil',
      headers: { origin },
      payload: { content: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});


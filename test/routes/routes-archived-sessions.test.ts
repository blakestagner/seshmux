// GET/PUT /api/sessions/archived + the ?archived= filter on the rail's session
// listing (issue #64). Runs against a real archive file in a tmp config dir; the
// providers are stubbed so the listing is deterministic.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sess = (id: string, provider: string, mtime: number) => ({
  id,
  provider,
  projectId: 'proj-a',
  title: id,
  branch: null,
  mtime,
  startedAt: null,
  durationMs: null,
  live: false,
});

// Two providers sharing one project; ids chosen so 'shared' exists in BOTH stores.
const claudeSessions = [sess('c1', 'claude', 500), sess('c2', 'claude', 400), sess('shared', 'claude', 300)];
const codexSessions = [sess('x1', 'codex', 450), sess('shared', 'codex', 250)];

vi.mock('../../server/lib/providers/types', () => ({
  getProviders: async () => [
    { id: 'claude', listSessions: async () => claudeSessions, scanProjects: async () => [] },
    { id: 'codex', listSessions: async () => codexSessions, scanProjects: async () => [] },
  ],
}));

const projectsRoutes = (await import('../../server/routes/projects')).default;
const archivedRoutes = (await import('../../server/routes/archived-sessions')).default;
const { _resetArchivedStoreForTest } = await import('../../server/lib/archived-sessions');

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smx-archived-route-'));
  prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
  process.env.SESHMUX_CONFIG_DIR = dir;
  _resetArchivedStoreForTest();
});

afterEach(() => {
  _resetArchivedStoreForTest();
  if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
  else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

async function app() {
  const f = Fastify();
  await f.register(projectsRoutes);
  await f.register(archivedRoutes);
  return f;
}

const put = (f: Awaited<ReturnType<typeof app>>, body: unknown) =>
  f.inject({ method: 'PUT', url: '/api/sessions/archived', payload: body as object });

const listIds = async (f: Awaited<ReturnType<typeof app>>, qs: string) => {
  const res = await f.inject({ method: 'GET', url: `/api/projects/proj-a/sessions${qs}` });
  return (res.json() as { id: string; provider: string }[]).map((s) => `${s.provider}:${s.id}`);
};

describe('/api/sessions/archived', () => {
  it('archives, lists and restores a session', async () => {
    const f = await app();
    const res = await put(f, { provider: 'claude', sessionId: 'c2', projectId: 'proj-a', archived: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ provider: 'claude', sessionId: 'c2', projectId: 'proj-a' }]);

    const got = await f.inject({ method: 'GET', url: '/api/sessions/archived' });
    expect(got.json()).toHaveLength(1);

    const back = await put(f, { provider: 'claude', sessionId: 'c2', projectId: 'proj-a', archived: false });
    expect(back.json()).toEqual([]);
    await f.close();
  });

  it('rejects malformed bodies (this endpoint writes disk)', async () => {
    const f = await app();
    for (const body of [
      {},
      { provider: 'claude', sessionId: 'c2', projectId: 'proj-a' }, // archived missing
      { provider: 'claude', sessionId: 'c2', projectId: 'proj-a', archived: 'yes' },
      { provider: 'claude', sessionId: '../etc', projectId: 'proj-a', archived: true },
      { provider: 'Claude Code!', sessionId: 'c2', projectId: 'proj-a', archived: true },
      { provider: 'claude', sessionId: 'c2', projectId: '', archived: true },
    ]) {
      expect((await put(f, body)).statusCode).toBe(400);
    }
    expect((await f.inject({ method: 'GET', url: '/api/sessions/archived' })).json()).toEqual([]);
    await f.close();
  });
});

describe('GET /api/projects/:id/sessions ?archived=', () => {
  it('no param keeps the old behaviour: archived sessions included', async () => {
    const f = await app();
    await put(f, { provider: 'claude', sessionId: 'c2', projectId: 'proj-a', archived: true });
    expect(await listIds(f, '')).toEqual(['claude:c1', 'codex:x1', 'claude:c2', 'claude:shared', 'codex:shared']);
    await f.close();
  });

  it('exclude drops archived sessions; only returns just them', async () => {
    const f = await app();
    await put(f, { provider: 'claude', sessionId: 'c2', projectId: 'proj-a', archived: true });
    expect(await listIds(f, '?archived=exclude')).toEqual(['claude:c1', 'codex:x1', 'claude:shared', 'codex:shared']);
    expect(await listIds(f, '?archived=only')).toEqual(['claude:c2']);
    await f.close();
  });

  it('matches on provider AND id — archiving one store\'s "shared" leaves the other', async () => {
    const f = await app();
    await put(f, { provider: 'codex', sessionId: 'shared', projectId: 'proj-a', archived: true });
    expect(await listIds(f, '?archived=exclude')).toContain('claude:shared');
    expect(await listIds(f, '?archived=exclude')).not.toContain('codex:shared');
    await f.close();
  });

  it('filters BEFORE paging, so a page is never silently short', async () => {
    const f = await app();
    await put(f, { provider: 'claude', sessionId: 'c1', projectId: 'proj-a', archived: true });
    await put(f, { provider: 'codex', sessionId: 'x1', projectId: 'proj-a', archived: true });
    expect(await listIds(f, '?archived=exclude&limit=2')).toEqual(['claude:c2', 'claude:shared']);
    expect(await listIds(f, '?archived=exclude&limit=2&before=300')).toEqual(['codex:shared']);
    await f.close();
  });

  it('restoring puts the session back in the default listing', async () => {
    const f = await app();
    await put(f, { provider: 'claude', sessionId: 'c1', projectId: 'proj-a', archived: true });
    await put(f, { provider: 'claude', sessionId: 'c1', projectId: 'proj-a', archived: false });
    expect(await listIds(f, '?archived=exclude')).toContain('claude:c1');
    expect(await listIds(f, '?archived=only')).toEqual([]);
    await f.close();
  });
});

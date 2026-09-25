// GET/PUT /api/session-names (issue #63). Hermetic: tmp SESHMUX_CONFIG_DIR and an
// injected provider check, so nothing touches the real config dir or agent stores.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sessionNamesRoutes, { type SessionNameChange } from '../../server/routes/session-names';
import { _resetSessionNamesForTest } from '../../server/lib/session-names';

let dir: string;
let prevConfigDir: string | undefined;
let changes: SessionNameChange[];

function makeApp() {
  const f = Fastify();
  f.register(sessionNamesRoutes, {
    isProvider: (id: string) => id === 'claude' || id === 'codex',
    onChanged: (c: SessionNameChange) => changes.push(c),
  });
  return f;
}

const put = (f: ReturnType<typeof makeApp>, payload: unknown) =>
  f.inject({ method: 'PUT', url: '/api/session-names', payload: payload as object });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smx-names-route-'));
  prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
  process.env.SESHMUX_CONFIG_DIR = dir;
  _resetSessionNamesForTest();
  changes = [];
});

afterEach(() => {
  _resetSessionNamesForTest();
  if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
  else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('/api/session-names', () => {
  it('GET starts empty', async () => {
    const f = makeApp();
    const res = await f.inject({ method: 'GET', url: '/api/session-names' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ names: {} });
  });

  it('PUT sets a normalized name, GET returns it, and the change is broadcast', async () => {
    const f = makeApp();
    const res = await put(f, { provider: 'claude', sessionId: 'abc-123', name: '  Refactor   auth ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: 'claude', sessionId: 'abc-123', name: 'Refactor auth' });
    expect(changes).toEqual([{ provider: 'claude', sessionId: 'abc-123', name: 'Refactor auth' }]);
    const got = await f.inject({ method: 'GET', url: '/api/session-names' });
    expect(got.json()).toEqual({ names: { 'claude:abc-123': 'Refactor auth' } });
  });

  it('PUT with an empty name (or null / missing) clears it and broadcasts name:null', async () => {
    const f = makeApp();
    await put(f, { provider: 'codex', sessionId: 's1', name: 'temp' });
    const cleared = await put(f, { provider: 'codex', sessionId: 's1', name: '' });
    expect(cleared.json()).toEqual({ provider: 'codex', sessionId: 's1', name: null });
    await put(f, { provider: 'codex', sessionId: 's2', name: 'x' });
    expect((await put(f, { provider: 'codex', sessionId: 's2', name: null })).json().name).toBeNull();
    expect((await put(f, { provider: 'codex', sessionId: 's2' })).json().name).toBeNull();
    expect(changes.at(-1)).toEqual({ provider: 'codex', sessionId: 's2', name: null });
    const got = await f.inject({ method: 'GET', url: '/api/session-names' });
    expect(got.json()).toEqual({ names: {} });
  });

  it('refuses an unknown provider, a bad session id, and a non-string name', async () => {
    const f = makeApp();
    expect((await put(f, { provider: 'gemini', sessionId: 's1', name: 'x' })).statusCode).toBe(400);
    expect((await put(f, { sessionId: 's1', name: 'x' })).statusCode).toBe(400);
    expect((await put(f, { provider: 'claude', sessionId: '', name: 'x' })).statusCode).toBe(400);
    expect((await put(f, { provider: 'claude', sessionId: 'a\u0000b', name: 'x' })).statusCode).toBe(400);
    expect((await put(f, { provider: 'claude', sessionId: 42, name: 'x' })).statusCode).toBe(400);
    expect((await put(f, { provider: 'claude', sessionId: 's1', name: 5 })).statusCode).toBe(400);
    expect((await put(f, { provider: 'claude', sessionId: 's1', name: { a: 1 } })).statusCode).toBe(400);
    expect(changes).toEqual([]);
  });

  it('caps the stored name length', async () => {
    const f = makeApp();
    const res = await put(f, { provider: 'claude', sessionId: 's1', name: 'y'.repeat(1000) });
    expect(res.json().name).toHaveLength(120);
  });
});

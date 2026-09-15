// POST /api/projects/open — the "+ Add project" path resolver. What separates it
// from /create is that it NEVER creates: a missing path, a file, or an empty
// path is refused, and nothing appears on disk as a side effect.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import projectsRoutes from '../../server/routes/projects';

let base: string;
const app = () => {
  const f = Fastify();
  f.register(projectsRoutes);
  return f;
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'smx-addproj-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const open = (body: Record<string, unknown>) =>
  app().inject({ method: 'POST', url: '/api/projects/open', payload: body });

describe('POST /api/projects/open', () => {
  it('returns the path of an existing directory', async () => {
    mkdirSync(join(base, 'repo'));
    const res = await open({ path: join(base, 'repo') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: join(base, 'repo') });
  });

  it('400s a directory that does not exist, and does not create it', async () => {
    const res = await open({ path: join(base, 'typo') });
    expect(res.statusCode).toBe(400);
    expect(existsSync(join(base, 'typo'))).toBe(false);
  });

  it('400s when the path is a file', async () => {
    writeFileSync(join(base, 'notes.txt'), 'a file');
    const res = await open({ path: join(base, 'notes.txt') });
    expect(res.statusCode).toBe(400);
  });

  it('400s without a path', async () => {
    expect((await open({ path: '   ' })).statusCode).toBe(400);
    expect((await open({})).statusCode).toBe(400);
  });

  it('400s a relative path instead of resolving it against the server cwd', async () => {
    // Both exist relative to where the tests (and a dev server) run — which is the
    // point: they must be refused, not quietly resolved into the seshmux checkout.
    expect((await open({ path: '.' })).statusCode).toBe(400);
    expect((await open({ path: 'server' })).statusCode).toBe(400);
  });

  it.skipIf(process.platform !== 'win32')('expands a Windows-style ~\\ path to the home directory', async () => {
    const res = await open({ path: '~\\' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: homedir() });
  });

  it('expands ~ to the home directory', async () => {
    const res = await open({ path: '~' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: homedir() });
  });
});

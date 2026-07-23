// POST /api/projects/create — the "+ New project" folder maker. It is the only
// route that creates a directory from a user-typed path, so the checks that
// matter are: name is a basename, a missing parent is refused, an existing dir
// is adopted rather than clobbered.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import projectsRoutes from '../../server/routes/projects';

let base: string;
const app = () => {
  const f = Fastify();
  f.register(projectsRoutes);
  return f;
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'smx-newproj-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const create = (body: Record<string, unknown>) =>
  app().inject({ method: 'POST', url: '/api/projects/create', payload: body });

describe('POST /api/projects/create', () => {
  it('creates the folder and returns its path', async () => {
    const res = await create({ parent: base, name: 'my-app' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: join(base, 'my-app'), existed: false });
    expect(existsSync(join(base, 'my-app'))).toBe(true);
  });

  it('adopts an existing directory instead of failing', async () => {
    mkdirSync(join(base, 'already'));
    writeFileSync(join(base, 'already', 'keep.txt'), 'keep');
    const res = await create({ parent: base, name: 'already' });
    expect(res.json()).toMatchObject({ existed: true });
    expect(existsSync(join(base, 'already', 'keep.txt'))).toBe(true); // untouched
  });

  it('reduces the name to a basename — no nesting, no climbing out', async () => {
    const res = await create({ parent: base, name: '../escaped' });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe(join(base, 'escaped'));
    expect(existsSync(join(base, '..', 'escaped'))).toBe(false);
  });

  it('400s a parent that does not exist', async () => {
    const res = await create({ parent: join(base, 'nope'), name: 'x' });
    expect(res.statusCode).toBe(400);
  });

  it('400s when a FILE already occupies the target', async () => {
    writeFileSync(join(base, 'taken'), 'a file');
    const res = await create({ parent: base, name: 'taken' });
    expect(res.statusCode).toBe(400);
  });

  it('400s without a name', async () => {
    expect((await create({ parent: base, name: '   ' })).statusCode).toBe(400);
    expect((await create({ parent: base })).statusCode).toBe(400);
  });
});

// GET /api/git/changes — project resolution + shape + graceful degradation.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import gitRoutes, { type GitRouteDeps } from '../../server/routes/git';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

let repo: string;
let notRepo: string;

function makeApp(over: Partial<GitRouteDeps> = {}) {
  const f = Fastify();
  f.register(gitRoutes, { resolveRepo: () => repo, listWorkspaces: async () => [], ...over });
  return f;
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'smx-gitroute-'));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n'); // dirty +1
  notRepo = mkdtempSync(join(tmpdir(), 'smx-gitroute-plain-'));
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(notRepo, { recursive: true, force: true });
});

describe('GET /api/git/changes', () => {
  it('400 without project', async () => {
    const f = makeApp();
    const res = await f.inject({ method: 'GET', url: '/api/git/changes' });
    expect(res.statusCode).toBe(400);
  });

  it('404 when the project resolves nowhere', async () => {
    const f = makeApp({ resolveRepo: () => null });
    const res = await f.inject({ method: 'GET', url: '/api/git/changes?project=x' });
    expect(res.statusCode).toBe(404);
  });

  it('returns stats for the project repo', async () => {
    const f = makeApp();
    const res = await f.inject({ method: 'GET', url: '/api/git/changes?project=x' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.added).toBe(1);
    expect(body.removed).toBe(0);
    expect(body.files).toHaveLength(1);
    expect(body.tree).toBeUndefined();
  });

  it('includes the tree when tree=1', async () => {
    const f = makeApp();
    const res = await f.inject({ method: 'GET', url: '/api/git/changes?project=x&tree=1' });
    expect(res.json().tree).toEqual(['a.txt']);
  });

  it('diffs an agent/* branch in its workspace dir', async () => {
    // Workspace record points at a second repo standing in for the worktree.
    const ws = mkdtempSync(join(tmpdir(), 'smx-gitroute-ws-'));
    try {
      git(ws, ['init', '-b', 'main']);
      git(ws, ['config', 'user.email', 't@t']);
      git(ws, ['config', 'user.name', 't']);
      writeFileSync(join(ws, 'w.txt'), 'x\n');
      git(ws, ['add', '.']);
      git(ws, ['commit', '-m', 'base']);
      writeFileSync(join(ws, 'w.txt'), 'x\ny\nz\n'); // dirty +2
      const f = makeApp({
        listWorkspaces: async () => [{ dir: ws, branch: 'agent/test-1', project: repo, createdAt: 0 }],
      });
      const res = await f.inject({
        method: 'GET',
        url: '/api/git/changes?project=x&branch=' + encodeURIComponent('agent/test-1'),
      });
      expect(res.json().added).toBe(2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('returns a degraded zeros payload for a non-repo project dir', async () => {
    const f = makeApp({ resolveRepo: () => notRepo });
    const res = await f.inject({ method: 'GET', url: '/api/git/changes?project=x' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ added: 0, removed: 0, files: [], degraded: true });
  });
});

describe('GET /api/git/changes/file', () => {
  it('400 without path', async () => {
    const f = makeApp();
    const res = await f.inject({ method: 'GET', url: '/api/git/changes/file?project=x' });
    expect(res.statusCode).toBe(400);
  });

  it('returns the unified diff for a dirty file', async () => {
    const f = makeApp();
    const res = await f.inject({ method: 'GET', url: '/api/git/changes/file?project=x&path=a.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.json().diff).toContain('+two');
  });

  it('empty diff for a path outside the repo', async () => {
    const f = makeApp();
    const res = await f.inject({
      method: 'GET',
      url: '/api/git/changes/file?project=x&path=' + encodeURIComponent('../../etc/hosts'),
    });
    expect(res.json().diff).toBe('');
  });
});

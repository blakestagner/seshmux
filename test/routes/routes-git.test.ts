// GET /api/git/changes — project resolution + shape + graceful degradation.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import gitRoutes, { type GitRouteDeps } from '../../server/routes/git';
import { canSymlink } from '../helpers/platform';

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

describe('GET /api/git/file', () => {
  it('returns working-tree content', async () => {
    const f = makeApp();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'known content marker\n');
    const res = await f.inject({ method: 'GET', url: '/api/git/file?project=x&path=src/a.ts' });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toContain('known content marker');
    expect(res.json().truncated).toBe(false);
  });

  it('rejects traversal and absolute paths', async () => {
    const f = makeApp();
    for (const p of ['../etc/passwd', '..%2F..%2Fetc%2Fpasswd', '/etc/passwd']) {
      const res = await f.inject({ method: 'GET', url: `/api/git/file?project=x&path=${encodeURIComponent(p)}` });
      expect([400, 404]).toContain(res.statusCode);
    }
  });

  // Creating the escaping symlink is the test's own fixture setup, but on a stock Windows box
  // (no admin/Developer Mode) fs.symlinkSync throws EPERM before the guard under test ever
  // runs — see test/helpers/platform.ts canSymlink(). Skipping loses coverage of the symlink
  // half of this containment guard on such hosts.
  it.skipIf(!canSymlink())('rejects symlink escape', async () => {
    const f = makeApp();
    symlinkSync('/etc', join(repo, 'esc'));
    const res = await f.inject({ method: 'GET', url: '/api/git/file?project=x&path=esc/passwd' });
    expect([400, 404]).toContain(res.statusCode);
  });

  it('flags binary', async () => {
    const f = makeApp();
    writeFileSync(join(repo, 'bin.png'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    const res = await f.inject({ method: 'GET', url: '/api/git/file?project=x&path=bin.png' });
    expect(res.json().binary).toBe(true);
  });

  it('truncates past 5000 lines', async () => {
    const f = makeApp();
    writeFileSync(join(repo, 'big.txt'), Array.from({ length: 6000 }, (_, i) => `line${i}`).join('\n'));
    const res = await f.inject({ method: 'GET', url: '/api/git/file?project=x&path=big.txt' });
    expect(res.json().truncated).toBe(true);
    expect(res.json().content.split('\n').length).toBe(5000);
  });

  it('404 for a missing file', async () => {
    const f = makeApp();
    const res = await f.inject({ method: 'GET', url: '/api/git/file?project=x&path=nope.txt' });
    expect(res.statusCode).toBe(404);
  });

  it('400 without path', async () => {
    const f = makeApp();
    const res = await f.inject({ method: 'GET', url: '/api/git/file?project=x' });
    expect(res.statusCode).toBe(400);
  });
});

// resolveTarget used to route to a worktree only for `agent/*` branches —
// seshmux's own naming convention. Worktrees are now discovered from git and
// can carry ANY branch name, and for those the gate silently fell through to
// the main checkout: search read the wrong tree and replace WROTE to it.
describe('worktree targeting (arbitrary branch names)', () => {
  let wt: string;

  beforeAll(() => {
    wt = join(repo, '..', `smx-gitroute-wt-${Date.now()}`);
    git(repo, ['worktree', 'add', '-b', 'hand-made', wt]);
    writeFileSync(join(wt, 'only-here.txt'), 'needle in the worktree\n');
  });

  afterAll(() => {
    git(repo, ['worktree', 'remove', '--force', wt]);
  });

  const withWorktree = () => ({
    listWorkspaces: async () => [
      { dir: wt, branch: 'hand-made', project: repo, createdAt: 0, external: true },
    ],
  });

  it('searches inside the worktree, not the main checkout', async () => {
    const f = makeApp(withWorktree());
    const res = await f.inject({
      method: 'GET',
      url: '/api/git/search?project=x&branch=hand-made&q=needle',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().files.map((r: { path: string }) => r.path)).toEqual(['only-here.txt']);
  });

  it('reads a file that exists ONLY in the worktree', async () => {
    const f = makeApp(withWorktree());
    const res = await f.inject({
      method: 'GET',
      url: '/api/git/file?project=x&branch=hand-made&path=only-here.txt',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toContain('needle');
  });

  it('replace writes into the worktree, leaving the main checkout untouched', async () => {
    const f = makeApp(withWorktree());
    const res = await f.inject({
      method: 'POST',
      url: '/api/git/replace',
      payload: {
        project: 'x',
        branch: 'hand-made',
        query: 'needle',
        replacement: 'PIN',
        edits: [{ path: 'only-here.txt', line: 1, expected: 'needle in the worktree' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().changed).toEqual(['only-here.txt']);
    expect(readFileSync(join(wt, 'only-here.txt'), 'utf8')).toBe('PIN in the worktree\n');
    expect(existsSync(join(repo, 'only-here.txt'))).toBe(false); // never touched the main tree
  });

  it('still targets the main checkout for a branch that is not a worktree', async () => {
    const f = makeApp(withWorktree());
    const res = await f.inject({
      method: 'GET',
      url: '/api/git/search?project=x&branch=main&q=needle',
    });
    expect(res.json().files).toEqual([]); // only-here.txt does not exist in the main tree
  });
});

// Drag-and-drop: raw-body upload (must not disturb the JSON routes above) and
// the lazy directory listing that backs expanding an ignored dir.
describe('POST /api/git/upload + GET /api/git/dir', () => {
  it('writes the raw body into the repo and reports where it landed', async () => {
    const f = makeApp();
    const res = await f.inject({
      method: 'POST',
      url: '/api/git/upload?project=x&name=dropped.txt&dir=',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('bytes'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().relPath).toBe('dropped.txt');
    expect(readFileSync(join(repo, 'dropped.txt'), 'utf8')).toBe('bytes');
  });

  it('400s a destination outside the repo', async () => {
    const f = makeApp();
    const res = await f.inject({
      method: 'POST',
      url: '/api/git/upload?project=x&name=x.txt&dir=..',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists one directory, dirs suffixed with a slash', async () => {
    mkdirSync(join(repo, 'listme', 'sub'), { recursive: true });
    writeFileSync(join(repo, 'listme', 'f.txt'), 'x');
    const f = makeApp();
    const res = await f.inject({ method: 'GET', url: '/api/git/dir?project=x&path=listme' });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toEqual(['listme/f.txt', 'listme/sub/']);
  });

  it('404s a directory outside the repo', async () => {
    const f = makeApp();
    const res = await f.inject({ method: 'GET', url: '/api/git/dir?project=x&path=../..' });
    expect(res.statusCode).toBe(404);
  });
});

// POST /api/git/reveal — hands a path to the OS file manager. The reveal call
// is injected so the suite never actually opens a Finder window.
describe('POST /api/git/reveal', () => {
  it('reveals the repo root when no path is given (no select)', async () => {
    const calls: [string, boolean | undefined][] = [];
    const f = makeApp({ revealFn: async (t, sel) => (calls.push([t, sel]), true) });
    const res = await f.inject({ method: 'POST', url: '/api/git/reveal', payload: { project: 'x' } });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe(false); // a directory opens, it is not "selected"
  });

  it('selects the file when a path is given', async () => {
    const calls: [string, boolean | undefined][] = [];
    const f = makeApp({ revealFn: async (t, sel) => (calls.push([t, sel]), true) });
    const res = await f.inject({
      method: 'POST',
      url: '/api/git/reveal',
      payload: { project: 'x', path: 'a.txt' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0][0].endsWith('a.txt')).toBe(true);
    expect(calls[0][1]).toBe(true);
  });

  it('404s a path outside the repo instead of falling back to the root', async () => {
    let called = false;
    const f = makeApp({ revealFn: async () => ((called = true), true) });
    const res = await f.inject({
      method: 'POST',
      url: '/api/git/reveal',
      payload: { project: 'x', path: '../../etc/passwd' },
    });
    expect(res.statusCode).toBe(404);
    expect(called).toBe(false);
  });

  it('501s when the host has no file manager', async () => {
    const f = makeApp({ revealFn: async () => false });
    const res = await f.inject({ method: 'POST', url: '/api/git/reveal', payload: { project: 'x' } });
    expect(res.statusCode).toBe(501);
  });
});

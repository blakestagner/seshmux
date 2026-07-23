import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import workspaceRoutes, { type WorkspaceRouteDeps } from '../../server/routes/workspaces';
import * as workspaces from '../../server/lib/workspaces';

const origin = 'http://127.0.0.1:4700';
let repo: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd }).toString();
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

function recorder() {
  const calls: any[] = [];
  const startSession: WorkspaceRouteDeps['startSession'] = async (opts) => {
    calls.push(opts);
    return { ptyId: 'pty-1', tabMeta: { ptyId: 'pty-1', provider: opts.provider, projectPath: opts.projectPath, projectId: 'p', mode: 'new', tmux: false } };
  };
  return { calls, startSession };
}

function makeApp(over: Partial<WorkspaceRouteDeps> = {}) {
  const { calls, startSession } = recorder();
  const f = Fastify();
  const deps: WorkspaceRouteDeps = {
    resolveRepo: () => repo,
    resolveDominantProvider: async () => 'claude',
    startSession,
    ...over,
  };
  f.register(workspaceRoutes, deps);
  return { f, calls };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wsroute-repo-'));
  initRepo(repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('POST /api/workspaces', () => {
  it('creates a real worktree and spawns via the SHARED startSession (no firstPrompt)', async () => {
    const { f, calls } = makeApp();
    const res = await f.inject({
      method: 'POST', url: '/api/workspaces', headers: { origin },
      payload: { projectId: 'demo' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ptyId).toBe('pty-1');
    expect(body.workspace.branch).toMatch(/^agent\//);
    expect(existsSync(body.workspace.dir)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].projectPath).toBe(body.workspace.dir);
    expect(calls[0].provider).toBe('claude');
    expect(calls[0].firstPrompt).toBeUndefined(); // codex-trust race mitigation

    // cleanup
    await workspaces.remove(body.workspace.dir, { mode: 'discard' });
  });

  it('uses the explicit provider when given (power path)', async () => {
    const { f, calls } = makeApp();
    const res = await f.inject({
      method: 'POST', url: '/api/workspaces', headers: { origin },
      payload: { projectId: 'demo', provider: 'codex' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0].provider).toBe('codex');
    await workspaces.remove(res.json().workspace.dir, { mode: 'discard' });
  });

  it('404s when the project cannot be resolved to a real dir', async () => {
    const { f } = makeApp({ resolveRepo: () => null });
    const res = await f.inject({
      method: 'POST', url: '/api/workspaces', headers: { origin },
      payload: { projectId: 'demo' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s when projectId is missing', async () => {
    const { f } = makeApp();
    const res = await f.inject({ method: 'POST', url: '/api/workspaces', headers: { origin }, payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/workspaces', () => {
  it('lists workspaces for a project with dirty file counts', async () => {
    const { dir } = await workspaces.create(repo);
    writeFileSync(join(dir, 'wip.txt'), 'hi');

    const { f } = makeApp();
    const res = await f.inject({ method: 'GET', url: '/api/workspaces?project=demo', headers: { origin } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].filesChanged).toBe(1);

    await workspaces.remove(dir, { mode: 'discard', force: true });
  });

  it('400s without a project query param', async () => {
    const { f } = makeApp();
    const res = await f.inject({ method: 'GET', url: '/api/workspaces', headers: { origin } });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/workspaces', () => {
  it('finishes a workspace with the requested mode', async () => {
    const { dir } = await workspaces.create(repo);
    const { f } = makeApp();
    const res = await f.inject({
      method: 'DELETE', url: '/api/workspaces', headers: { origin },
      payload: { dir, mode: 'keep' },
    });
    expect(res.statusCode).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });

  it('409s with the git error on a failed merge, leaving state intact', async () => {
    writeFileSync(join(repo, 'c.txt'), 'base');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const { dir } = await workspaces.create(repo);
    writeFileSync(join(repo, 'c.txt'), 'main');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'main edit']);
    writeFileSync(join(dir, 'c.txt'), 'ws');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'ws edit']);

    const { f } = makeApp();
    const res = await f.inject({
      method: 'DELETE', url: '/api/workspaces', headers: { origin },
      payload: { dir, mode: 'merge' },
    });
    expect(res.statusCode).toBe(409);
    expect(existsSync(dir)).toBe(true);

    await workspaces.remove(dir, { mode: 'discard', force: true });
  });

  it('400s on an invalid mode', async () => {
    const { f } = makeApp();
    const res = await f.inject({
      method: 'DELETE', url: '/api/workspaces', headers: { origin },
      payload: { dir: '/tmp/x', mode: 'nope' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s an unknown workspace dir (R2-7)', async () => {
    const { f } = makeApp();
    const res = await f.inject({
      method: 'DELETE', url: '/api/workspaces', headers: { origin },
      payload: { dir: '/tmp/does-not-exist-as-a-workspace', mode: 'keep' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s a dirty discard without force (client precondition, not a merge conflict — R2-7)', async () => {
    const { dir } = await workspaces.create(repo);
    writeFileSync(join(dir, 'wip.txt'), 'wip');

    const { f } = makeApp();
    const res = await f.inject({
      method: 'DELETE', url: '/api/workspaces', headers: { origin },
      payload: { dir, mode: 'discard' },
    });
    // Missing force on a dirty discard is a 400 (bad request the client must fix by
    // confirming), distinct from a real merge conflict which stays 409.
    expect(res.statusCode).toBe(400);
    expect(existsSync(dir)).toBe(true);

    // force:true (as the client sends after its typed confirm) proceeds.
    const res2 = await f.inject({
      method: 'DELETE', url: '/api/workspaces', headers: { origin },
      payload: { dir, mode: 'discard', force: true },
    });
    expect(res2.statusCode).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });
});

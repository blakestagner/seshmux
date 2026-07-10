import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ws from '../../server/lib/workspaces';

let configDir: string;
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

// workspaces.ts reads configDir() lazily per-call (via server/daemon-client's
// process.env read), so a single static import + per-test env var swap gives
// every test its own isolated workspaces.json + worktrees root — no need to
// re-import the module.
async function freshWorkspaces() {
  return ws;
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'seshmux-cfg-'));
  process.env.SESHMUX_CONFIG_DIR = configDir;
  repo = mkdtempSync(join(tmpdir(), 'seshmux-repo-'));
  initRepo(repo);
});

afterEach(() => {
  delete process.env.SESHMUX_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('workspaces.create', () => {
  it('creates a worktree + branch named agent/<slug>-<n> off the default branch', async () => {
    const ws = await freshWorkspaces();
    const { dir, branch } = await ws.create(repo);
    expect(existsSync(dir)).toBe(true);
    expect(branch).toMatch(/^agent\/[a-z]+-[a-z]+-1$/);
    // worktree has its own checkout of the repo content.
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
    // Recorded in workspaces.json.
    const records = await ws.list(repo);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ dir, branch, project: repo });
  });

  it('rejects a non-git directory', async () => {
    const ws = await freshWorkspaces();
    const notRepo = mkdtempSync(join(tmpdir(), 'seshmux-notrepo-'));
    await expect(ws.create(notRepo)).rejects.toThrow(/not a git repo/);
    rmSync(notRepo, { recursive: true, force: true });
  });

  it('two workspaces on the same repo get distinct slugs/dirs (parallel-safe)', async () => {
    const ws = await freshWorkspaces();
    const a = await ws.create(repo);
    const b = await ws.create(repo);
    expect(a.dir).not.toBe(b.dir);
    expect(a.branch).not.toBe(b.branch);
    const records = await ws.list(repo);
    expect(records).toHaveLength(2);
  });

  it('does not touch the main tree even with uncommitted changes there', async () => {
    writeFileSync(join(repo, 'dirty.txt'), 'wip');
    const ws = await freshWorkspaces();
    await ws.create(repo);
    expect(existsSync(join(repo, 'dirty.txt'))).toBe(true); // untouched
    const status = git(repo, ['status', '--porcelain']);
    expect(status).toContain('dirty.txt');
  });
});

describe('workspaces.dirtyCount', () => {
  it('counts modified files in the worktree', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    expect(await ws.dirtyCount(dir)).toBe(0);
    writeFileSync(join(dir, 'new.txt'), 'hi');
    expect(await ws.dirtyCount(dir)).toBe(1);
  });
});

describe('workspaces.remove', () => {
  it('merge: merges the branch into the default branch and removes the worktree', async () => {
    const ws = await freshWorkspaces();
    const { dir, branch } = await ws.create(repo);
    writeFileSync(join(dir, 'feature.txt'), 'new feature');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'add feature']);

    await ws.remove(dir, { mode: 'merge' });

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true); // merged into main tree
    const log = git(repo, ['log', '--oneline', '-1']);
    expect(log).toMatch(/merge/i);
    // Branch survives a merge (only worktree removed).
    const branches = git(repo, ['branch', '--list', branch]);
    expect(branches).toContain(branch.replace('agent/', 'agent/'));
    expect(await ws.list(repo)).toHaveLength(0);
  });

  it('merge failure (conflict) leaves worktree + branch + record intact', async () => {
    // Both sides must diverge from a COMMON ancestor for git to see a real
    // conflict — branching off main after main already changed the file just
    // gives the workspace branch a clean fast-forward-content merge.
    writeFileSync(join(repo, 'conflict.txt'), 'base version');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'add conflict.txt']);

    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);

    writeFileSync(join(repo, 'conflict.txt'), 'main version');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'main edits conflict.txt']);

    writeFileSync(join(dir, 'conflict.txt'), 'workspace version');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'workspace edits conflict.txt']);

    await expect(ws.remove(dir, { mode: 'merge' })).rejects.toThrow();
    expect(existsSync(dir)).toBe(true); // worktree untouched on failure
    expect(await ws.list(repo)).toHaveLength(1); // record untouched
  });

  it('keep: removes the worktree but the branch survives', async () => {
    const ws = await freshWorkspaces();
    const { dir, branch } = await ws.create(repo);

    await ws.remove(dir, { mode: 'keep' });

    expect(existsSync(dir)).toBe(false);
    const branches = git(repo, ['branch', '--list', branch]);
    expect(branches).toContain(branch);
    expect(await ws.list(repo)).toHaveLength(0);
  });

  it('discard: force-removes the worktree AND deletes the branch (clean tree, no force needed)', async () => {
    const ws = await freshWorkspaces();
    const { dir, branch } = await ws.create(repo);

    await ws.remove(dir, { mode: 'discard' });

    expect(existsSync(dir)).toBe(false);
    const branches = git(repo, ['branch', '--list', branch]);
    expect(branches.trim()).toBe('');
    expect(await ws.list(repo)).toHaveLength(0);
  });

  it('discard on a dirty tree WITHOUT force refuses — never silent-discard uncommitted work', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    writeFileSync(join(dir, 'uncommitted.txt'), 'wip');

    await expect(ws.remove(dir, { mode: 'discard' })).rejects.toThrow(/uncommitted/);

    expect(existsSync(dir)).toBe(true); // untouched
    expect(await ws.list(repo)).toHaveLength(1); // record untouched
  });

  it('discard on a dirty tree WITH force proceeds', async () => {
    const ws = await freshWorkspaces();
    const { dir, branch } = await ws.create(repo);
    writeFileSync(join(dir, 'uncommitted.txt'), 'wip');

    await ws.remove(dir, { mode: 'discard', force: true });

    expect(existsSync(dir)).toBe(false);
    const branches = git(repo, ['branch', '--list', branch]);
    expect(branches.trim()).toBe('');
    expect(await ws.list(repo)).toHaveLength(0);
  });
});

describe('workspaces.reconcile', () => {
  it('prunes records whose worktree dir is gone from disk', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    rmSync(dir, { recursive: true, force: true }); // simulate a crash mid-remove

    await ws.reconcile();

    expect(await ws.list(repo)).toHaveLength(0);
  });

  it('prunes records git no longer knows about (worktree list drift)', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    // Simulate drift: git forgets the worktree but the dir + record remain.
    git(repo, ['worktree', 'remove', '--force', dir]);
    execFileSync('mkdir', ['-p', dir]); // dir exists again but git doesn't know it

    await ws.reconcile();

    expect(await ws.list(repo)).toHaveLength(0);
  });

  it('keeps valid records untouched', async () => {
    const ws = await freshWorkspaces();
    await ws.create(repo);
    await ws.reconcile();
    expect(await ws.list(repo)).toHaveLength(1);
  });
});

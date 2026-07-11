import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
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

  it('avoids a branch kept by a finished workspace whose record is gone (S4-3)', async () => {
    // Deterministic: fill the ENTIRE `agent/<slug>-1` namespace with real git branches that
    // have NO workspaces.json record (exactly the 'keep'-finished state). Whatever slug
    // create() draws, its -1 is already taken on disk but invisible to a record-only scan —
    // so create MUST consult git branches and bump past it, or `worktree add -b` throws raw.
    const head = git(repo, ['rev-parse', 'HEAD']).trim();
    const refsDir = join(repo, '.git', 'refs', 'heads', 'agent');
    mkdirSync(refsDir, { recursive: true });
    const adjectives = ['quiet','brisk','amber','calm','swift','bold','lucid','mellow','crisp','still','keen','sunny','misty','sharp','gentle','vivid'];
    const nouns = ['otter','falcon','ember','birch','heron','cove','meadow','quartz','willow','harbor','lantern','thistle','ridge','coral','sparrow','ferry'];
    for (const a of adjectives) for (const n of nouns) writeFileSync(join(refsDir, `${a}-${n}-1`), head + '\n');

    const ws = await freshWorkspaces();
    const { dir, branch } = await ws.create(repo); // must not throw
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
    expect(branch).toMatch(/^agent\/[a-z]+-[a-z]+-[2-9]\d*$/); // bumped past the taken -1
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

  it('merge: succeeds and removes the worktree even when it holds untracked files (S4-4)', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    writeFileSync(join(dir, 'feature.txt'), 'new feature');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'add feature']);
    // Untracked file left in the worktree — a plain `worktree remove` would refuse and the
    // already-done merge would be misreported as a 409.
    writeFileSync(join(dir, 'scratch.log'), 'build junk');

    await ws.remove(dir, { mode: 'merge' });

    expect(existsSync(dir)).toBe(false); // force-removed despite the untracked file
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true); // committed work merged
    expect(await ws.list(repo)).toHaveLength(0);
  });

  it('merge conflict aborts the parent merge so the repo is not left mid-merge (S4-6)', async () => {
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
    // Parent must be restored — no MERGE_HEAD, no conflict markers left behind.
    expect(() => git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toThrow();
    expect(git(repo, ['status', '--porcelain'])).not.toMatch(/^UU /m);
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

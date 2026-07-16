import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
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
    // Both paths are canonicalized: git reports realpaths, so records built from `git worktree
    // list` (reconcile's adopt half) must key identically to ones create() writes.
    expect(records[0]).toMatchObject({ dir, branch, project: realpathSync(repo) });
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

  it('merge: refuses when tracked files have uncommitted edits, destroying nothing (R5-1)', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    writeFileSync(join(dir, 'feature.txt'), 'committed');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'commit one']);
    // Agent then kept editing a TRACKED file without committing. A merge moves commits, not
    // these edits — force-removing would destroy them while reporting success.
    writeFileSync(join(dir, 'feature.txt'), 'edits the agent never committed');

    await expect(ws.remove(dir, { mode: 'merge' })).rejects.toThrow(/uncommitted changes/i);

    expect(readFileSync(join(dir, 'feature.txt'), 'utf8')).toBe('edits the agent never committed');
    expect(existsSync(dir)).toBe(true);
    expect(await ws.list(repo)).toHaveLength(1); // record intact, retryable
  });

  it('merge: force-removes the worktree once the work is committed and merged, even with untracked build artifacts left behind (S4-4)', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    writeFileSync(join(dir, 'feature.txt'), 'new feature');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'add feature']);
    // Untracked leftovers: the work IS committed, so these are artifacts — they must not
    // block the merge (guarding on any-dirty re-broke exactly this case).
    writeFileSync(join(dir, 'scratch.log'), 'build junk');

    await ws.remove(dir, { mode: 'merge' });

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true); // committed work merged
    expect(await ws.list(repo)).toHaveLength(0);
  });

  it('merge: preserves UNTRACKED files to leftovers instead of destroying them (R5-1 other half)', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    writeFileSync(join(dir, 'feature.txt'), 'new feature');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'add feature']);
    // Real work the agent wrote but never staged — a merge moves COMMITS, so this file
    // is in none of them and the force-remove used to silently destroy it.
    writeFileSync(join(dir, 'newfeature.ts'), 'export const real = "work";');

    const { leftovers } = await ws.remove(dir, { mode: 'merge' });

    expect(existsSync(dir)).toBe(false);
    expect(leftovers).toBeTruthy();
    expect(readFileSync(join(leftovers!, 'newfeature.ts'), 'utf8')).toBe('export const real = "work";');
  });

  it('merge: preserves an untracked DIRECTORY (collapsed ?? dir/ entry) to leftovers', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    writeFileSync(join(dir, 'feature.txt'), 'new feature');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'add feature']);
    // -unormal collapses a new untracked dir to one 'src/' entry; the whole dir
    // is real never-staged work and must survive the post-merge force-remove.
    mkdirSync(join(dir, 'newmod'));
    writeFileSync(join(dir, 'newmod', 'index.ts'), 'export {};');

    const { leftovers } = await ws.remove(dir, { mode: 'merge' });

    expect(existsSync(dir)).toBe(false);
    expect(leftovers).toBeTruthy();
    expect(readFileSync(join(leftovers!, 'newmod', 'index.ts'), 'utf8')).toBe('export {};');
  });

  it('merge: preserves a gitignored file with a non-ASCII name (porcelain quotepath)', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    writeFileSync(join(dir, '.gitignore'), '*.env\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'ignore env']);
    // Default core.quotepath octal-escapes this in plain porcelain output; the quoted
    // literal never resolved on disk and the file was silently destroyed. -z emits raw bytes.
    writeFileSync(join(dir, 'café.env'), 'UNICODE_SECRET');

    const { leftovers } = await ws.remove(dir, { mode: 'merge' });

    expect(leftovers).toBeTruthy();
    expect(readFileSync(join(leftovers!, 'café.env'), 'utf8')).toBe('UNICODE_SECRET');
  });

  it('merge: preserves gitignored FILES instead of destroying them, and never refuses over them (R6-1/R7-1/R8)', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    writeFileSync(join(dir, '.gitignore'), '.env\ndev.sqlite\ntsconfig.tsbuildinfo\nnode_modules/\n');
    writeFileSync(join(dir, 'feature.txt'), 'work');
    git(dir, ['add', '.gitignore', 'feature.txt']);
    git(dir, ['commit', '-q', '-m', 'work']);
    // A secret, a local DB with real data, and a rebuildable artifact — a name heuristic kept
    // getting this split wrong (destroying dev.sqlite, then refusing over tsbuildinfo), so we
    // preserve every ignored FILE and judge none of them.
    writeFileSync(join(dir, '.env'), 'OPENAI_KEY=sk-live-REAL');
    writeFileSync(join(dir, 'dev.sqlite'), 'THE ONLY COPY');
    writeFileSync(join(dir, 'tsconfig.tsbuildinfo'), '{}');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'big.js'), 'rebuildable');

    const { leftovers } = await ws.remove(dir, { mode: 'merge' }); // must NOT refuse

    expect(existsSync(join(repo, 'feature.txt'))).toBe(true); // work merged
    expect(existsSync(dir)).toBe(false); // worktree gone
    expect(leftovers).toBeTruthy();
    expect(readFileSync(join(leftovers!, '.env'), 'utf8')).toBe('OPENAI_KEY=sk-live-REAL');
    expect(readFileSync(join(leftovers!, 'dev.sqlite'), 'utf8')).toBe('THE ONLY COPY');
    expect(existsSync(join(leftovers!, 'tsconfig.tsbuildinfo'))).toBe(true);
    // An ignored DIRECTORY is rebuildable and expensive to copy — deliberately not preserved.
    expect(existsSync(join(leftovers!, 'node_modules'))).toBe(false);
  });

  it('keep: also preserves gitignored files rather than deleting them (R8)', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    writeFileSync(join(dir, '.gitignore'), '.env\n');
    git(dir, ['add', '.gitignore']);
    git(dir, ['commit', '-q', '-m', 'ignore']);
    writeFileSync(join(dir, '.env'), 'SECRET');

    const { leftovers } = await ws.remove(dir, { mode: 'keep' });

    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(leftovers!, '.env'), 'utf8')).toBe('SECRET');
  });

  it('merge: a gitignored DIRECTORY of build artifacts does not block the merge (R6-1 scoping)', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    writeFileSync(join(dir, '.gitignore'), 'dist/\n');
    writeFileSync(join(dir, 'feature.txt'), 'work');
    git(dir, ['add', '.gitignore', 'feature.txt']);
    git(dir, ['commit', '-q', '-m', 'work']);
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'out.js'), 'rebuildable');

    await ws.remove(dir, { mode: 'merge' }); // rebuildable artifacts are disposable

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
  });

  it('merge + keep: ordinary build artifacts never block finishing (R7-1)', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    writeFileSync(join(dir, '.gitignore'), 'tsconfig.tsbuildinfo\n.DS_Store\n*.log\n');
    writeFileSync(join(dir, 'feature.txt'), 'work');
    git(dir, ['add', '.gitignore', 'feature.txt']);
    git(dir, ['commit', '-q', '-m', 'work']);
    // Exactly what this repo's own "always run typecheck" instruction leaves behind. Refusing
    // here left `discard --force` as the only action — destroying the committed work.
    writeFileSync(join(dir, 'tsconfig.tsbuildinfo'), '{}');
    writeFileSync(join(dir, '.DS_Store'), 'junk');
    writeFileSync(join(dir, 'debug.log'), 'noise');

    await ws.remove(dir, { mode: 'merge' });

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
  });

  it('merge: an ignored dir still collapses under status.showUntrackedFiles=all (R7-2)', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(dir, 'feature.txt'), 'work');
    git(dir, ['add', '.gitignore', 'feature.txt']);
    git(dir, ['commit', '-q', '-m', 'work']);
    // A common global setting. Without an explicit -unormal, --ignored expands node_modules/
    // into individual files and every workspace becomes unmergeable.
    git(dir, ['config', 'status.showUntrackedFiles', 'all']);
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1');

    await ws.remove(dir, { mode: 'merge' });

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
  });

  it('keep/discard: a worktree whose dir already vanished still cleans up (R7-3)', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    rmSync(dir, { recursive: true, force: true }); // user deleted it by hand

    await ws.remove(dir, { mode: 'keep' }); // must not throw 'spawn git ENOENT'

    expect(await ws.list(repo)).toHaveLength(0);
  });

  it('merge: refuses when the branch has no commits, even if the only work is untracked (R5-1)', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    // Agent wrote a brand-new file and never staged it: `merge --no-ff` would be a no-op and
    // the force-remove would delete it while reporting success.
    writeFileSync(join(dir, 'agent-report.md'), 'the only copy of the work');

    await expect(ws.remove(dir, { mode: 'merge' })).rejects.toThrow(/no commits to merge/i);

    expect(readFileSync(join(dir, 'agent-report.md'), 'utf8')).toBe('the only copy of the work');
    expect(await ws.list(repo)).toHaveLength(1);
  });

  it('merge: leaves a pre-existing parent merge alone instead of aborting the user\'s work (R5-2)', async () => {
    // Parent is already mid-merge with a hand-resolved file staged. Our merge refuses to
    // start; aborting on the way out would destroy the user's resolution.
    writeFileSync(join(repo, 'shared.txt'), 'base');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'base']);
    git(repo, ['checkout', '-q', '-b', 'other']);
    writeFileSync(join(repo, 'shared.txt'), 'other-side');
    git(repo, ['commit', '-q', '-am', 'other side']);
    git(repo, ['checkout', '-q', '-']);
    writeFileSync(join(repo, 'shared.txt'), 'main-side');
    git(repo, ['commit', '-q', '-am', 'main side']);

    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    writeFileSync(join(dir, 'x.txt'), 'x');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'work']);

    try {
      git(repo, ['merge', 'other']); // conflicts, leaves MERGE_HEAD
    } catch {
      /* expected conflict */
    }
    writeFileSync(join(repo, 'shared.txt'), 'carefully hand-resolved by the user');
    git(repo, ['add', 'shared.txt']); // user's in-progress resolution, staged

    await expect(ws.remove(dir, { mode: 'merge' })).rejects.toThrow();

    // The user's merge state and resolution must both survive.
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('carefully hand-resolved by the user');
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

describe('concurrent workspace create + orphan adoption (D5-2)', () => {
  // 4 concurrent writers, not 8: the lost-update/ENOENT bug reproduces with 2+, and each
  // create() is a real `git worktree add` — 8 of them under full-suite parallel load took
  // ~25s and flaked. Explicit timeout because this test is genuinely I/O-heavy.
  it('concurrent creates on the same repo all land: zero rejections, one worktree + one record each, no orphan', { timeout: 60_000 }, async () => {
    const ws = await freshWorkspaces();
    const N = 4;

    const results = await Promise.allSettled(Array.from({ length: N }, () => ws.create(repo)));

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const gitList = git(repo, ['worktree', 'list', '--porcelain']);
    const worktreeDirs = gitList
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
      .filter((d) => d !== realpathSync(repo)); // exclude the main tree (git reports realpaths)

    expect(worktreeDirs).toHaveLength(N);

    const records = await ws.list(repo);
    expect(records).toHaveLength(N);

    // No orphan: every worktree dir on disk has a matching record, and vice versa.
    const recordDirs = new Set(records.map((r) => r.dir));
    for (const d of worktreeDirs) expect(recordDirs.has(d)).toBe(true);
  });

  it('reconcile() adopts a worktree whose record was lost (crash window), and it becomes removable', async () => {
    const ws = await freshWorkspaces();
    const { dir } = await ws.create(repo);
    expect(await ws.list(repo)).toHaveLength(1);

    // Simulate the crash window: the worktree was created on disk but the json write for it
    // never landed / was lost. Hand-edit workspaces.json to drop the record while the worktree
    // dir + git registration stay intact.
    const wsFile = join(configDir, 'workspaces.json');
    writeFileSync(wsFile, JSON.stringify([]));
    expect(await ws.list(repo)).toHaveLength(0);

    await ws.reconcile();

    const recovered = await ws.list(repo);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].dir).toBe(dir);

    // Before D5-2 this threw 'unknown workspace dir' — the adopted record must be a real,
    // removable workspace, not a decoration.
    await ws.remove(dir, { mode: 'discard', force: true });
    expect(existsSync(dir)).toBe(false);
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

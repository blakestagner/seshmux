// git-stats: line-count diff vs a base ref (committed + dirty + untracked).
// Integration cases run against a real throwaway git repo — hand-written
// strings can't cover rename/binary/merge-base behavior faithfully.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNumstat, changes, fileDiff } from '../../server/lib/git-stats';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('parseNumstat', () => {
  it('parses added/removed/path', () => {
    expect(parseNumstat('3\t1\tsrc/a.ts\n10\t0\tREADME.md\n')).toEqual([
      { path: 'src/a.ts', added: 3, removed: 1 },
      { path: 'README.md', added: 10, removed: 0 },
    ]);
  });

  it('treats binary (-) as zero', () => {
    expect(parseNumstat('-\t-\timg.png\n')).toEqual([{ path: 'img.png', added: 0, removed: 0 }]);
  });

  it('handles empty output', () => {
    expect(parseNumstat('')).toEqual([]);
  });
});

describe('changes (real repo)', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'smx-gitstats-'));
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@t']);
    git(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, 'base.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(repo, 'kept.txt'), 'kept\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'base']);
    // branch work: one committed edit, one dirty edit, one untracked file
    git(repo, ['checkout', '-b', 'agent/test-1']);
    writeFileSync(join(repo, 'base.txt'), 'one\nTWO\nthree\nfour\n'); // +2 -1
    git(repo, ['add', 'base.txt']);
    git(repo, ['commit', '-m', 'edit']);
    writeFileSync(join(repo, 'kept.txt'), 'kept\ndirty\n'); // +1 uncommitted
    writeFileSync(join(repo, 'fresh.txt'), 'a\nb\nc\n'); // +3 untracked
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('counts committed + dirty + untracked vs base branch', async () => {
    const res = await changes(repo, 'main', false);
    expect(res.added).toBe(6); // 2 + 1 + 3
    expect(res.removed).toBe(1);
    const byPath = Object.fromEntries(res.files.map((f) => [f.path, f]));
    expect(byPath['base.txt']).toMatchObject({ added: 2, removed: 1, status: 'M' });
    expect(byPath['kept.txt']).toMatchObject({ added: 1, removed: 0 });
    expect(byPath['fresh.txt']).toMatchObject({ added: 3, removed: 0, status: 'A' });
    expect(res.tree).toBeUndefined();
  });

  it('returns the full tracked tree plus untracked when asked', async () => {
    const res = await changes(repo, 'main', true);
    expect(res.tree).toEqual(['base.txt', 'fresh.txt', 'kept.txt']);
  });

  it('degrades to uncommitted-only when base equals HEAD branch', async () => {
    const res = await changes(repo, 'agent/test-1', false);
    expect(res.added).toBe(4); // dirty +1, untracked +3
    expect(res.removed).toBe(0);
  });

  it('survives an unknown base ref (falls back to HEAD)', async () => {
    const res = await changes(repo, 'no-such-branch', false);
    expect(res.added).toBe(4);
    expect(res.removed).toBe(0);
  });

  it('returns zeros for a non-repo dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smx-notrepo-'));
    try {
      const res = await changes(dir, 'main', true);
      expect(res).toEqual({ added: 0, removed: 0, files: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fileDiff (real repo)', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'smx-filediff-'));
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@t']);
    git(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'base']);
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\n'); // modified
    writeFileSync(join(repo, 'new.txt'), 'hello\nworld\n'); // untracked
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns a unified diff for a tracked change', async () => {
    const { fileDiff } = await import('../../server/lib/git-stats');
    const { diff, truncated } = await fileDiff(repo, 'main', 'a.txt');
    expect(diff).toContain('@@');
    expect(diff).toContain('-two');
    expect(diff).toContain('+TWO');
    expect(truncated).toBe(false);
  });

  it('renders an untracked file as all-added', async () => {
    const { fileDiff } = await import('../../server/lib/git-stats');
    const { diff } = await fileDiff(repo, 'main', 'new.txt');
    expect(diff).toContain('+hello');
    expect(diff).toContain('+world');
  });

  it('refuses paths escaping the repo', async () => {
    const { fileDiff } = await import('../../server/lib/git-stats');
    expect((await fileDiff(repo, 'main', '../../../etc/hosts')).diff).toBe('');
    expect((await fileDiff(repo, 'main', '/etc/hosts')).diff).toBe('');
  });

  it('returns empty for an unchanged file', async () => {
    const { fileDiff } = await import('../../server/lib/git-stats');
    writeFileSync(join(repo, 'clean.txt'), 'x\n');
    git(repo, ['add', 'clean.txt']);
    git(repo, ['commit', '-m', 'clean']);
    expect((await fileDiff(repo, 'main', 'clean.txt')).diff).toBe('');
  });
});

describe('review-fix regressions (real repo)', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'smx-gitfix-'));
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@t']);
    git(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, 'keep.txt'), 'k\n');
    writeFileSync(join(repo, 'old.txt'), 'same content here\nline two\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'base']);
    git(repo, ['checkout', '-b', 'agent/fix-1']);
    // rename: must NOT produce a `{old => new}` pseudo-path
    git(repo, ['mv', 'old.txt', 'renamed.txt']);
    git(repo, ['commit', '-m', 'rename']);
    // unicode filename: core.quotepath would octal-escape this
    writeFileSync(join(repo, 'héllo.txt'), 'a\nb\n');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reports a rename as delete + add with real paths', async () => {
    const res = await changes(repo, 'main', true);
    const paths = res.files.map((f) => f.path);
    expect(paths).not.toContainEqual(expect.stringContaining('=>'));
    expect(paths).toContain('old.txt');
    expect(paths).toContain('renamed.txt');
    const byPath = Object.fromEntries(res.files.map((f) => [f.path, f]));
    expect(byPath['old.txt'].status).toBe('D');
    expect(byPath['renamed.txt'].status).toBe('A');
    expect(res.tree).toContain('renamed.txt');
  });

  it('emits unicode paths unescaped and counts their lines', async () => {
    const res = await changes(repo, 'main', true);
    const uni = res.files.find((f) => f.path === 'héllo.txt');
    expect(uni).toBeDefined();
    expect(uni!.added).toBe(2);
    expect(res.tree).toContain('héllo.txt');
  });

  it('fileDiff works for a unicode untracked file', async () => {
    const { diff } = await fileDiff(repo, 'main', 'héllo.txt');
    expect(diff).toContain('+a');
    expect(diff).toContain('+b');
  });

  it('truncates oversized diffs and flags it', async () => {
    writeFileSync(join(repo, 'big.txt'), Array.from({ length: 7000 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const { diff, truncated } = await fileDiff(repo, 'main', 'big.txt');
    expect(truncated).toBe(true);
    expect(diff.split('\n').length).toBeLessThanOrEqual(5000);
  });
});

describe('defaultBaseRef', () => {
  it('prefers a local main over the current branch on originless repos', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'smx-baseref-'));
    try {
      git(repo, ['init', '-b', 'main']);
      git(repo, ['config', 'user.email', 't@t']);
      git(repo, ['config', 'user.name', 't']);
      writeFileSync(join(repo, 'a.txt'), 'x\n');
      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', 'base']);
      git(repo, ['checkout', '-b', 'feature-x']); // repo now SITS on a feature branch
      const { defaultBaseRef } = await import('../../server/lib/git-stats');
      expect(await defaultBaseRef(repo)).toBe('main');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

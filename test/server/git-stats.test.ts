// git-stats: line-count diff vs a base ref (committed + dirty + untracked).
// Integration cases run against a real throwaway git repo — hand-written
// strings can't cover rename/binary/merge-base behavior faithfully.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNumstat, changes } from '../../server/lib/git-stats';

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
    const d = await fileDiff(repo, 'main', 'a.txt');
    expect(d).toContain('@@');
    expect(d).toContain('-two');
    expect(d).toContain('+TWO');
  });

  it('renders an untracked file as all-added', async () => {
    const { fileDiff } = await import('../../server/lib/git-stats');
    const d = await fileDiff(repo, 'main', 'new.txt');
    expect(d).toContain('+hello');
    expect(d).toContain('+world');
  });

  it('refuses paths escaping the repo', async () => {
    const { fileDiff } = await import('../../server/lib/git-stats');
    expect(await fileDiff(repo, 'main', '../../../etc/hosts')).toBe('');
    expect(await fileDiff(repo, 'main', '/etc/hosts')).toBe('');
  });

  it('returns empty for an unchanged file', async () => {
    const { fileDiff } = await import('../../server/lib/git-stats');
    writeFileSync(join(repo, 'clean.txt'), 'x\n');
    git(repo, ['add', 'clean.txt']);
    git(repo, ['commit', '-m', 'clean']);
    expect(await fileDiff(repo, 'main', 'clean.txt')).toBe('');
  });
});

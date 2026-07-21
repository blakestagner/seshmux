// git-search: repo-wide `git grep` search + the replace write path.
// Runs against a real throwaway repo — pathspec/ignore/untracked semantics
// are git's, and a hand-written fake would only test our idea of them.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { search, replace, toPathspecs, parseGrepZ, replaceInLine, buildPattern } from '../../server/lib/git-search';

const BASE = { caseSensitive: false, wholeWord: false, regex: false, include: '', exclude: '', includeIgnored: false };

let dir: string;

function write(rel: string, body: string) {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'smx-search-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  write('src/a.ts', 'const needle = 1;\nconst haystack = 2;\nNEEDLE_UPPER\n');
  write('src/a.test.ts', 'needle in a test\n');
  write('docs/readme.md', 'needle here\nneedleneedle twice\n');
  write('.gitignore', 'ignored/\n');
  write('ignored/x.js', 'needle in ignored\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init'], { cwd: dir });
  write('untracked.ts', 'needle untracked\n');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('pure helpers', () => {
  it('normalizes slashless globs to any-depth, bare names also as dirs', () => {
    expect(toPathspecs('*.ts', false)).toEqual([':(glob)**/*.ts']);
    expect(toPathspecs('dist', true)).toEqual([':(exclude,glob)**/dist', ':(exclude,glob)**/dist/**']);
    expect(toPathspecs('app/**', false)).toEqual([':(glob)app/**']);
    expect(toPathspecs(' *.ts , *.tsx ', false)).toEqual([':(glob)**/*.ts', ':(glob)**/*.tsx']);
    expect(toPathspecs('  ,  ', false)).toEqual([]);
  });

  it('parses grep -z records, including a filename containing a newline', () => {
    expect(parseGrepZ('a.ts\x0012\x00hi\nb\nc.ts\x003\x00yo\n')).toEqual([
      { path: 'a.ts', line: 12, text: 'hi' },
      { path: 'b\nc.ts', line: 3, text: 'yo' },
    ]);
  });

  it('replaceInLine targets the nth match only, and expands $& against it', () => {
    const re = buildPattern({ ...BASE, query: 'ab' });
    expect(replaceInLine('ab ab ab', re, 'X', 1)).toBe('ab X ab');
    expect(replaceInLine('ab ab', re, 'X')).toBe('X X');
    expect(replaceInLine('nope', re, 'X')).toBeNull();
    const rx = buildPattern({ ...BASE, query: '(a+)b', regex: true });
    expect(replaceInLine('aab aab', rx, '[$1]', 1)).toBe('aab [aa]');
  });
});

describe('search', () => {
  it('finds tracked + untracked, skips gitignored by default', async () => {
    const res = await search(dir, { ...BASE, query: 'needle' });
    const paths = res.files.map((f) => f.path).sort();
    expect(paths).toEqual(['docs/readme.md', 'src/a.test.ts', 'src/a.ts', 'untracked.ts']);
    // total counts matched LINES (git grep's unit), not occurrences: a.ts 2,
    // a.test.ts 1, readme 2 (`needleneedle` is one line), untracked 1.
    expect(res.total).toBe(6);
  });

  it('includes gitignored files when asked', async () => {
    const res = await search(dir, { ...BASE, query: 'needle', includeIgnored: true });
    expect(res.files.map((f) => f.path)).toContain('ignored/x.js');
  });

  it('honours case sensitivity', async () => {
    const res = await search(dir, { ...BASE, query: 'NEEDLE', caseSensitive: true });
    expect(res.files.flatMap((f) => f.matches.map((m) => m.text))).toEqual(['NEEDLE_UPPER']);
  });

  it('honours whole word', async () => {
    const res = await search(dir, { ...BASE, query: 'needle', wholeWord: true, caseSensitive: true });
    // needleneedle is excluded; the bare `needle` on the same file's line 1 is not
    expect(res.files.find((f) => f.path === 'docs/readme.md')?.matches).toEqual([{ line: 1, text: 'needle here' }]);
  });

  it('applies include and exclude globs', async () => {
    const res = await search(dir, { ...BASE, query: 'needle', include: '*.ts', exclude: '*.test.ts' });
    expect(res.files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'untracked.ts']);
  });

  it('treats the query as a literal unless regex is on', async () => {
    expect((await search(dir, { ...BASE, query: 'need.e' })).total).toBe(0);
    expect((await search(dir, { ...BASE, query: 'need.e', regex: true })).total).toBeGreaterThan(0);
  });

  it('reports an invalid regex instead of silently returning nothing', async () => {
    const res = await search(dir, { ...BASE, query: 'a(', regex: true });
    expect(res.error).toBeTruthy();
    expect(res.files).toEqual([]);
  });

  it('returns an empty result (not a throw) when nothing matches', async () => {
    await expect(search(dir, { ...BASE, query: 'zzzznope' })).resolves.toMatchObject({ total: 0, files: [] });
  });
});

describe('replace', () => {
  it('replaces one match, all matches on a line, and preserves CRLF', async () => {
    write('rep.txt', 'aa bb aa\r\naa\r\n');
    const opts = { ...BASE, query: 'aa', replacement: 'ZZ' };
    const before = readFileSync(join(dir, 'rep.txt'), 'utf8');
    expect(before).toContain('\r\n');

    let res = await replace(dir, [{ path: 'rep.txt', line: 1, expected: 'aa bb aa\r', matchIndex: 1 }], opts);
    expect(res.changed).toEqual(['rep.txt']);
    expect(readFileSync(join(dir, 'rep.txt'), 'utf8')).toBe('aa bb ZZ\r\naa\r\n');

    res = await replace(dir, [{ path: 'rep.txt', line: 1, expected: 'aa bb ZZ\r' }], opts);
    expect(readFileSync(join(dir, 'rep.txt'), 'utf8')).toBe('ZZ bb ZZ\r\naa\r\n');
  });

  it('skips a stale line rather than writing over it', async () => {
    write('stale.txt', 'current text\n');
    const res = await replace(dir, [{ path: 'stale.txt', line: 1, expected: 'what the user saw' }], {
      ...BASE,
      query: 'text',
      replacement: 'X',
    });
    expect(res.changed).toEqual([]);
    expect(res.skipped[0].reason).toBe('stale');
    expect(readFileSync(join(dir, 'stale.txt'), 'utf8')).toBe('current text\n');
  });

  it('refuses a path that escapes the repo', async () => {
    const res = await replace(dir, [{ path: '../escape.txt', line: 1, expected: 'x' }], {
      ...BASE,
      query: 'x',
      replacement: 'y',
    });
    expect(res.changed).toEqual([]);
    expect(res.skipped[0].reason).toBe('outside repo');
  });

  it('keeps $ literal in fixed mode but expands backrefs in regex mode', async () => {
    write('dollar.txt', 'abc\n');
    await replace(dir, [{ path: 'dollar.txt', line: 1, expected: 'abc' }], {
      ...BASE,
      query: 'abc',
      replacement: 'cost: $&',
    });
    expect(readFileSync(join(dir, 'dollar.txt'), 'utf8')).toBe('cost: $&\n');

    write('dollar.txt', 'abc\n');
    await replace(dir, [{ path: 'dollar.txt', line: 1, expected: 'abc' }], {
      ...BASE,
      query: '(a)(b)c',
      regex: true,
      replacement: '$2$1',
    });
    expect(readFileSync(join(dir, 'dollar.txt'), 'utf8')).toBe('ba\n');
  });
});

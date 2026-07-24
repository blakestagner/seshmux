// saveUpload is the drag-and-drop write path: it must stay inside the repo and
// must never clobber an existing file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveUpload, writeWorkingFile } from '../../server/lib/git-stats';

let root: string;
let outside: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'seshmux-upload-'));
  root = join(base, 'repo');
  outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
});
afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

const buf = (s: string) => Buffer.from(s, 'utf8');

describe('saveUpload', () => {
  it('writes into the repo root and returns both paths', async () => {
    const res = await saveUpload(root, '', 'a.txt', buf('hi'));
    expect(res?.relPath).toBe('a.txt');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('hi');
  });

  it('creates a missing subdir (the terminal drop target) and lands there', async () => {
    const res = await saveUpload(root, '.seshmux/dropped', 'shot.png', buf('x'));
    expect(res?.relPath).toBe(join('.seshmux', 'dropped', 'shot.png'));
  });

  it('drops a .gitignore(*) so a .seshmux/ drop is not tracked by git', async () => {
    await saveUpload(root, '.seshmux/dropped', 'report.html', buf('x'));
    expect(readFileSync(join(root, '.seshmux', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('does NOT add a .seshmux/.gitignore for a normal (non-.seshmux) upload', async () => {
    await saveUpload(root, '', 'a.txt', buf('hi'));
    expect(existsSync(join(root, '.seshmux'))).toBe(false);
  });

  it('never overwrites — suffixes instead', async () => {
    writeFileSync(join(root, 'a.txt'), 'original');
    const res = await saveUpload(root, '', 'a.txt', buf('new'));
    expect(res?.relPath).toBe('a-1.txt');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('original');
  });

  it('strips traversal out of the filename', async () => {
    const res = await saveUpload(root, '', '../../escape.txt', buf('x'));
    expect(res?.relPath).toBe('escape.txt');
  });

  it('refuses a destination dir outside the repo', async () => {
    expect(await saveUpload(root, '../outside', 'x.txt', buf('x'))).toBeNull();
  });

  it('refuses a symlinked destination pointing outside the repo', async () => {
    symlinkSync(outside, join(root, 'link'));
    expect(await saveUpload(root, 'link', 'x.txt', buf('x'))).toBeNull();
  });
});

// writeWorkingFile backs the Full-view editor: overwrite-only, and never on
// top of a file that moved since it was read.
describe('writeWorkingFile', () => {
  it('overwrites an existing file and reports the new mtime', async () => {
    writeFileSync(join(root, 'a.txt'), 'old');
    const { mtimeMs } = statSync(join(root, 'a.txt'));
    const res = await writeWorkingFile(root, 'a.txt', 'new', mtimeMs);
    expect(res).toHaveProperty('mtimeMs');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new');
  });

  it('refuses when the file changed on disk since it was read (stale mtime)', async () => {
    writeFileSync(join(root, 'a.txt'), 'agent wrote this');
    const res = await writeWorkingFile(root, 'a.txt', 'my stale edit', 1);
    expect(res).toEqual({ error: 'stale' });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('agent wrote this');
  });

  it('never creates a file that does not exist', async () => {
    expect(await writeWorkingFile(root, 'nope.txt', 'x', 0)).toEqual({ error: 'missing' });
    expect(existsSync(join(root, 'nope.txt'))).toBe(false);
  });

  it('refuses a path outside the repo', async () => {
    writeFileSync(join(outside, 'secret.txt'), 'keep');
    const res = await writeWorkingFile(root, '../outside/secret.txt', 'pwned', 0);
    expect(res).toEqual({ error: 'missing' });
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('keep');
  });
});

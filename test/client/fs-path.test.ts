// fs-path: splitting and joining real filesystem paths client-side. Pure, and the
// regression that motivated it is the first test: a Windows project path fed through
// `lastIndexOf('/')` came back one character short and seeded the New project dialog with
// a directory that could not exist.
//
// Windows paths are written with doubled backslashes rather than String.raw throughout,
// because a raw template cannot end in a backslash — it escapes its own closing backtick.
import { describe, it, expect } from 'vitest';
import { baseName, dirName, isWindowsPath, joinPath, sepOf } from '../../lib/client/fs-path';

const DOWNLOADS = 'C:\\Users\\Blake\\Downloads';
const BLAKE = 'C:\\Users\\Blake';

describe('dirName', () => {
  it('does not chop the last character off a Windows path', () => {
    // The bug, stated: no '/' in the string, lastIndexOf gives -1, slice(0, -1) eats the 's'.
    expect(DOWNLOADS.slice(0, DOWNLOADS.lastIndexOf('/'))).toBe('C:\\Users\\Blake\\Download');
    expect(dirName(DOWNLOADS)).toBe(BLAKE);
  });

  it('handles posix paths', () => {
    expect(dirName('/home/blake/dev/seshmux')).toBe('/home/blake/dev');
    expect(dirName('/foo')).toBe('/');
  });

  it('keeps a backslash that is part of a posix filename', () => {
    // Backslash is legal in a posix filename, so a blanket [\\/] split would corrupt this.
    expect(dirName('/home/b/we\\ird/x')).toBe('/home/b/we\\ird');
  });

  it('stops at a root rather than eating it', () => {
    expect(dirName('C:\\Users')).toBe('C:\\');
    expect(dirName('C:\\')).toBe('');
    expect(dirName('/')).toBe('');
  });

  it('ignores trailing separators', () => {
    expect(dirName(DOWNLOADS + '\\')).toBe(BLAKE);
    expect(dirName('/home/blake/dev/')).toBe('/home/blake');
  });

  it('returns nothing when there is no parent to name', () => {
    expect(dirName('seshmux')).toBe('');
    expect(dirName('')).toBe('');
  });

  it('accepts a Windows path written with forward slashes', () => {
    expect(dirName('C:/Users/Blake/Downloads')).toBe('C:/Users/Blake');
  });
});

describe('baseName', () => {
  it('takes the last segment on either platform', () => {
    expect(baseName(DOWNLOADS)).toBe('Downloads');
    expect(baseName('/home/blake/dev/seshmux')).toBe('seshmux');
    expect(baseName('seshmux')).toBe('seshmux');
  });

  it('ignores trailing separators', () => {
    expect(baseName(DOWNLOADS + '\\')).toBe('Downloads');
    expect(baseName('/home/blake/dev/')).toBe('dev');
  });
});

describe('joinPath', () => {
  it('joins with the separator the parent is written in', () => {
    // The New project preview read `C:\Users\Blake\Download/yes` before this.
    expect(joinPath(DOWNLOADS, 'yes')).toBe(DOWNLOADS + '\\yes');
    expect(joinPath('/home/blake/dev', 'seshmux')).toBe('/home/blake/dev/seshmux');
  });

  it('does not double a separator', () => {
    expect(joinPath(BLAKE + '\\', 'yes')).toBe(BLAKE + '\\yes');
    expect(joinPath('/home/blake/', 'dev')).toBe('/home/blake/dev');
    expect(joinPath('C:\\', 'dev')).toBe('C:\\dev');
    expect(joinPath('/', 'dev')).toBe('/dev');
  });

  it('does not let the child climb out with a leading separator', () => {
    expect(joinPath('/home/blake', '/etc')).toBe('/home/blake/etc');
  });

  it('tolerates an empty half', () => {
    expect(joinPath('', 'dev')).toBe('dev');
    expect(joinPath('/home/blake', '')).toBe('/home/blake');
  });
});

describe('isWindowsPath / sepOf', () => {
  it('recognises drive letters and UNC shares', () => {
    expect(isWindowsPath('C:\\Users')).toBe(true);
    expect(isWindowsPath('c:/Users')).toBe(true);
    expect(isWindowsPath('\\\\host\\share')).toBe(true);
    expect(isWindowsPath('/home/blake')).toBe(false);
    expect(isWindowsPath('relative/path')).toBe(false);
  });

  it('picks the separator to join with', () => {
    expect(sepOf('C:\\Users')).toBe('\\');
    expect(sepOf('/home/blake')).toBe('/');
  });

  it('treats a backslash path with no drive or UNC prefix as posix, by contract', () => {
    // `Users\Blake\proj` is three segments on Windows and ONE legal filename on posix,
    // and nothing in the string decides it. These helpers take absolute paths — where
    // the question never arises — so the posix reading is chosen deliberately: guessing
    // Windows here would split real posix filenames, the exact corruption CLAUDE.local.md
    // warns about. Pinned so the choice is a decision and not an accident.
    expect(isWindowsPath('Users\\Blake\\proj')).toBe(false);
    expect(baseName('Users\\Blake\\proj')).toBe('Users\\Blake\\proj');
    expect(baseName('/home/b/we\\ird')).toBe('we\\ird');
  });
});

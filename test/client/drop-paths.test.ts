import { describe, it, expect } from 'vitest';
import { pasteText, pathsFromDrop, shellQuote } from '../../lib/client/drop-paths';

const dt = (data: Record<string, string>) => ({ getData: (t: string) => data[t] ?? '' });

describe('pathsFromDrop', () => {
  it('decodes file:// URLs from a Finder drag, percent-escapes included', () => {
    expect(pathsFromDrop(dt({ 'text/uri-list': 'file:///Users/x/a%20b.txt\r\nfile:///Users/x/c.png' }))).toEqual([
      '/Users/x/a b.txt',
      '/Users/x/c.png',
    ]);
  });

  it('takes a bare absolute path (our own tree drag) and dedupes across types', () => {
    expect(pathsFromDrop(dt({ 'text/plain': '/repo/src/a.ts', 'text/uri-list': 'file:///repo/src/a.ts' }))).toEqual([
      '/repo/src/a.ts',
    ]);
  });

  it('ignores uri-list comments, relative text, and network file:// hosts', () => {
    expect(pathsFromDrop(dt({ 'text/uri-list': '# comment\nfile://server/share/x', 'text/plain': 'hello world' }))).toEqual(
      [],
    );
  });
});

// The tree row publishes `file://` + encodeURI(abs); the terminal must decode
// it back to the exact path, spaces and all. These two halves live in
// different files, so pin the round trip.
describe('tree-row drag round trip', () => {
  it('survives encodeURI on a path with spaces', () => {
    const abs = '/Users/me/Local Sites/markauthor/a file.txt';
    const uri = 'file://' + encodeURI(abs);
    expect(pathsFromDrop(dt({ 'text/uri-list': uri }))).toEqual([abs]);
  });
});

describe('shellQuote / pasteText', () => {
  it('leaves safe paths bare and single-quotes the rest', () => {
    expect(shellQuote('/a/b-c.txt')).toBe('/a/b-c.txt');
    expect(shellQuote('/a/b c.txt')).toBe("'/a/b c.txt'");
    expect(shellQuote("/a/it's")).toBe("'/a/it'\\''s'");
  });

  it('joins with spaces and leaves a trailing space to keep typing', () => {
    expect(pasteText(['/a', '/b c'])).toBe("/a '/b c' ");
  });
});

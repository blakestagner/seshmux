// safeStartIn is the trust boundary for the native folder chooser: `startIn`
// arrives in a request body and reaches an AppleScript literal and zenity/
// kdialog argv. Anything that isn't a plain absolute path is dropped rather
// than escaped.
import { describe, it, expect } from 'vitest';
import { safeStartIn } from '../../server/lib/folder-picker';

const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('safeStartIn', () => {
  posixOnly('passes a plain absolute path through', () => {
    expect(safeStartIn('/Users/me/Documents/GitHub')).toBe('/Users/me/Documents/GitHub');
  });

  // Spaces are LEGAL in paths ("~/Local Sites/…" is everywhere on macOS) and
  // must survive. A stricter regex that swept them up would silently disable
  // the start-in directory for a large share of real projects, and the dialog
  // would quietly open somewhere else instead.
  posixOnly('keeps a path containing spaces', () => {
    expect(safeStartIn('/Users/me/Local Sites/markauthor')).toBe('/Users/me/Local Sites/markauthor');
  });

  it('drops empty/relative input', () => {
    expect(safeStartIn(undefined)).toBeUndefined();
    expect(safeStartIn('   ')).toBeUndefined();
    expect(safeStartIn('relative/path')).toBeUndefined();
    expect(safeStartIn('~/Documents')).toBeUndefined();
  });

  posixOnly('drops PowerShell subexpression payloads', () => {
    expect(safeStartIn('/tmp/$(calc.exe)')).toBeUndefined();
    expect(safeStartIn('/tmp/"; calc.exe; "')).toBeUndefined();
    expect(safeStartIn('/tmp/`whoami`')).toBeUndefined();
  });

  posixOnly('drops shell metacharacters and control bytes', () => {
    expect(safeStartIn('/tmp/a; rm -rf /')).toBeUndefined();
    expect(safeStartIn('/tmp/a | tee /tmp/b')).toBeUndefined();
    expect(safeStartIn('/tmp/a && b')).toBeUndefined();
    expect(safeStartIn('/tmp/a\u0000b')).toBeUndefined();
    expect(safeStartIn('/tmp/a\nb')).toBeUndefined();
  });

  it('drops a leading dash — argv flag smuggling into zenity/kdialog', () => {
    expect(safeStartIn('--help')).toBeUndefined();
    expect(safeStartIn('-/tmp/x')).toBeUndefined();
  });
});

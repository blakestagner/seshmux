import { describe, it, expect, afterEach } from 'vitest';
import { cmdInvocation, quoteArgv, cmdEscape } from '../../server/lib/win-args';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const daemon = require('../../daemon/win-args');

// win-args has two mirror copies (daemon standalone, server bundled). They must
// agree, and the win32 quoting must actually neutralize cmd metacharacters —
// this is a security path (CVE-2024-27980 + cmd injection), so it gets a real check
// even though the logic only fires on win32.

const realPlatform = process.platform;
function setPlatform(p: string) {
  Object.defineProperty(process, 'platform', { value: p });
}
afterEach(() => setPlatform(realPlatform));

describe('cmdInvocation', () => {
  it('is the identity on posix', () => {
    setPlatform('linux');
    expect(cmdInvocation('/usr/bin/claude', ['--foo', 'a b'])).toEqual(['/usr/bin/claude', ['--foo', 'a b']]);
    expect(daemon.cmdInvocation('/usr/bin/claude', ['x'])).toEqual(['/usr/bin/claude', ['x']]);
  });

  it('is the identity for a non-.cmd/.bat target on win32 (a real .exe)', () => {
    setPlatform('win32');
    expect(cmdInvocation('C:\\tools\\rg.exe', ['--version'])).toEqual(['C:\\tools\\rg.exe', ['--version']]);
  });

  it('wraps a .cmd through cmd.exe with /d /c on win32, server and daemon agreeing', () => {
    setPlatform('win32');
    const server = cmdInvocation('C:\\npm\\claude.cmd', ['--resume=abc']);
    const dmn = daemon.cmdInvocation('C:\\npm\\claude.cmd', ['--resume=abc']);
    expect(server).toEqual(dmn); // the load-bearing mirror assertion
    expect(server[0].toLowerCase()).toContain('cmd');
    expect(server[1].slice(0, 2)).toEqual(['/d', '/c']);
  });

  it('neutralizes a cmd metacharacter in an argument (no command injection)', () => {
    setPlatform('win32');
    const [, args] = cmdInvocation('C:\\npm\\claude.cmd', ['--', 'a & calc.exe']);
    const line = args[args.length - 1];
    // The & must be caret-escaped so cmd passes it to the program, not run calc.
    expect(line).toContain('^&');
    expect(line).not.toMatch(/[^^]& calc/); // no bare, unescaped `& calc`
  });

  it('quotes a path containing spaces for the argv parser', () => {
    setPlatform('win32');
    const [, args] = cmdInvocation('C:\\Program Files\\x\\claude.cmd', ['--version']);
    // The quoting produces a `"..."`-wrapped path; cmdEscape then carets the quotes.
    expect(args[args.length - 1]).toContain('Program Files');
  });
});

describe('quoteArgv', () => {
  it('leaves simple tokens untouched, quotes ones with spaces', () => {
    expect(quoteArgv('--flag')).toBe('--flag');
    expect(quoteArgv('a b')).toBe('"a b"');
  });
  it('escapes embedded quotes and trailing backslashes per MSVC rules', () => {
    expect(quoteArgv('a"b')).toBe('"a\\"b"');
    expect(quoteArgv('C:\\path with space\\')).toBe('"C:\\path with space\\\\"');
  });
});

describe('cmdEscape', () => {
  it('carets every cmd metacharacter', () => {
    expect(cmdEscape('a&b|c>d')).toBe('a^&b^|c^>d');
  });
});

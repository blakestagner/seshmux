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
  it('is the identity on posix (plus empty spawn opts)', () => {
    setPlatform('linux');
    expect(cmdInvocation('/usr/bin/claude', ['--foo', 'a b'])).toEqual(['/usr/bin/claude', ['--foo', 'a b'], {}]);
    expect(daemon.cmdInvocation('/usr/bin/claude', ['x'])).toEqual(['/usr/bin/claude', ['x'], {}]);
  });

  it('is the identity for a non-.cmd/.bat target on win32 (a real .exe)', () => {
    setPlatform('win32');
    expect(cmdInvocation('C:\\tools\\rg.exe', ['--version'])).toEqual(['C:\\tools\\rg.exe', ['--version'], {}]);
  });

  it('wraps a .cmd through cmd.exe with /d /c on win32, server and daemon agreeing', () => {
    setPlatform('win32');
    const server = cmdInvocation('C:\\npm\\claude.cmd', ['--resume=abc']);
    const dmn = daemon.cmdInvocation('C:\\npm\\claude.cmd', ['--resume=abc']);
    expect(server).toEqual(dmn); // the load-bearing mirror assertion
    expect(server[0].toLowerCase()).toContain('cmd');
    expect(server[1].slice(0, 2)).toEqual(['/d', '/c']);
  });

  // The escaped line only survives if nothing re-escapes it. node rewrites `"` as
  // MSVC `\"` when it builds a command line, and cmd.exe does not speak `\"` — that
  // is exactly how a spaced .cmd path died. Callers MUST spawn verbatim.
  it('demands a verbatim spawn on the .cmd path, and nothing on posix', () => {
    setPlatform('win32');
    expect(cmdInvocation('C:\\npm\\claude.cmd', [])[2]).toEqual({ windowsVerbatimArguments: true });
    expect(daemon.cmdInvocation('C:\\npm\\claude.cmd', [])[2]).toEqual({ windowsVerbatimArguments: true });
    setPlatform('linux');
    expect(cmdInvocation('/usr/bin/claude', [])[2]).toEqual({});
  });

  it('neutralizes a cmd metacharacter in a BARE argument (no command injection)', () => {
    setPlatform('win32');
    const [, args] = cmdInvocation('C:\\npm\\claude.cmd', ['--', 'a&calc.exe']);
    const line = args[args.length - 1];
    // Bare token (no spaces) -> caret-escaped, so cmd passes the & to the program
    // rather than starting a second command.
    expect(line).toContain('^&');
    expect(line).not.toMatch(/[^^]&calc/); // no bare, unescaped `&calc`
  });

  it('neutralizes a metacharacter in a QUOTED argument via the quotes, not carets', () => {
    setPlatform('win32');
    const [, args] = cmdInvocation('C:\\npm\\claude.cmd', ['--', 'a & calc.exe']);
    const line = args[args.length - 1];
    // Spaces force MSVC quoting, and cmd does not act on & inside double quotes.
    // A caret here would NOT be consumed (inside quotes ^ is literal) and would be
    // delivered to the program verbatim, corrupting the argument — so assert the
    // token is quoted and carries a CLEAN &.
    expect(line).toContain('"a & calc.exe"');
    expect(line).not.toContain('^&');
  });

  it('builds a launchable line for a .cmd under a path with spaces (regression)', () => {
    setPlatform('win32');
    const [, args] = cmdInvocation('C:\\Program Files\\x\\claude.cmd', ['--version']);
    const line = args[args.length - 1];
    // The file is MSVC-quoted, and the WHOLE line is wrapped again because `cmd /c`
    // strips the first and last quote of its remainder — without the wrap that strip
    // eats the path's own closing quote and the agent never launches. The old code
    // caret-escaped these quotes (^") and node then turned them into \" — cmd
    // reported: '\"C:\Program Files\...^\"' is not recognized...
    expect(line).toBe('""C:\\Program Files\\x\\claude.cmd" --version"');
    expect(line).not.toContain('^"'); // the caret-quote form that broke it
    expect(line).not.toContain('\\"'); // and no MSVC escape for cmd to choke on
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

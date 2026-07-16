'use strict';
/**
 * Windows command-interpreter invocation builder — mirror of server/lib/win-args.ts
 * (daemon/ is standalone; the server never imports it, same posture as ipc.js). Keep
 * the two in sync; test/lib/win-args.test.ts cross-checks them.
 *
 * Node refuses to spawn a .cmd/.bat directly (CVE-2024-27980) and ConPTY/CreateProcess
 * can't launch a batch script, so a .cmd/.bat target must run under cmd.exe. This returns
 * `[comspec, ['/d','/c', <escaped command line>]]` with every token quoted for the
 * target's CommandLineToArgvW parser AND cmd.exe's own parser, so a path with spaces or
 * an arg carrying a cmd metacharacter (& | < > ^ etc.) can neither split the command line
 * nor inject a second command. `/d` disables any HKCU AutoRun. Identity ([file, args]) on
 * posix or for a non-.cmd/.bat file.
 *
 * ponytail: `%VAR%` cannot be reliably escaped against cmd's variable expansion — so raw
 * user text must never be passed as an argv element on win32. session-start.ts routes a
 * user firstPrompt through the delayed-write path there instead; this quoting is
 * defense-in-depth for the remaining safe inputs (resolved paths, fixed flags, a
 * regex-validated version spec).
 */

// Quote one arg for the program's own CommandLineToArgvW parser (MSVC rules).
function quoteArgv(arg) {
  if (arg.length && !/[ \t\n\v"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  out += '\\'.repeat(backslashes * 2) + '"';
  return out;
}

// Prefix cmd.exe metacharacters with ^ so cmd passes them through to the program
// instead of acting on them. cmd consumes the ^ before the program sees the line.
function cmdEscape(line) {
  return line.replace(/[()%!^"<>&|]/g, '^$&');
}

function cmdInvocation(file, args) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return [file, args];
  const line = [file, ...args].map(quoteArgv).join(' ');
  const comspec = process.env.ComSpec || 'cmd.exe';
  return [comspec, ['/d', '/c', cmdEscape(line)]];
}

module.exports = { cmdInvocation, quoteArgv, cmdEscape };

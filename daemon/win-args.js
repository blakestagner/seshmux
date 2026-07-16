'use strict';
/**
 * Windows command-interpreter invocation builder — mirror of server/lib/win-args.ts
 * (daemon/ is standalone; the server never imports it, same posture as ipc.js). Keep
 * the two in sync; test/lib/win-args.test.ts cross-checks them.
 *
 * Node refuses to spawn a .cmd/.bat directly (CVE-2024-27980) and ConPTY/CreateProcess
 * can't launch a batch script, so a .cmd/.bat target must run under cmd.exe. This returns
 * `[comspec, ['/d','/c', <command line>], opts]` — `/d` disables any HKCU AutoRun.
 * Identity (`[file, args, {}]`) on posix or for a non-.cmd/.bat file.
 *
 * ── the caller MUST spawn VERBATIM (that's what `opts` is for) ───────────────────
 * We build the whole `/c` command line ourselves, so nothing may re-escape it.
 * child_process honors `opts.windowsVerbatimArguments`; node-pty has no such option
 * but takes a pre-escaped command line when `args` is a STRING (windowsPtyAgent.js:
 * `if (typeof args === 'string') return argsToCommandLine(file, []) + ' ' + args`),
 * so daemon/holder.js joins the array for that path. Spread `opts` into the spawn
 * options; on posix it is `{}` and changes nothing.
 *
 * This is why: previously we handed the escaped line to node as a normal argv element,
 * and node re-escaped its quotes (`"` -> `\"`) while building the real command line.
 * cmd.exe doesn't speak MSVC's `\"`, so a .cmd under a path with SPACES never launched:
 *     '\"C:\Program Files\x\agent.cmd^\"' is not recognized as an internal or
 *     external command
 * Unspaced paths worked only because quoteArgv left them bare and node's own wrapping
 * happened to produce the `cmd /c "..."` form this now builds explicitly.
 *
 * ── the escaping model ───────────────────────────────────────────────────────────
 * Two mutually exclusive neutralizations, one per token (see cmdToken):
 *  - a token needing MSVC quoting (spaces/quotes) is QUOTED. cmd does not act on
 *    & | < > ( ) inside double quotes, so the quotes are the neutralization —
 *    carets would NOT work there (inside quotes a ^ is a literal caret and would be
 *    delivered to the program verbatim, corrupting the argument).
 *  - a bare token is CARET-escaped, which only works unquoted.
 *
 * ponytail: `%VAR%` cannot be reliably escaped against cmd's variable expansion in
 * either form — so raw user text must never be passed as an argv element on win32.
 * session-start.ts routes a user firstPrompt through the delayed-write path there
 * instead; this quoting is defense-in-depth for the remaining safe inputs (resolved
 * paths, fixed flags, a regex-validated version spec).
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
// Only valid for an UNQUOTED token — see cmdToken.
function cmdEscape(line) {
  return line.replace(/[()%!^"<>&|]/g, '^$&');
}

// One token of the cmd command line: quoted OR caret-escaped, never both.
function cmdToken(arg) {
  const quoted = quoteArgv(arg);
  return quoted === arg ? cmdEscape(arg) : quoted;
}

function cmdInvocation(file, args) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return [file, args, {}];
  const inner = [file, ...args].map(cmdToken).join(' ');
  const comspec = process.env.ComSpec || 'cmd.exe';
  // The outer quotes are load-bearing: `cmd /c` strips the FIRST and LAST quote of
  // its remainder, so wrapping is what lets an inner "quoted path with spaces"
  // survive that strip intact. With no args and an unspaced file the wrap is inert
  // (cmd strips it straight back off), so the common case is byte-identical to the
  // line node used to build.
  return [comspec, ['/d', '/c', `"${inner}"`], { windowsVerbatimArguments: true }];
}

module.exports = { cmdInvocation, quoteArgv, cmdEscape, cmdToken };

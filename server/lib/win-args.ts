// Windows command-interpreter invocation builder — mirror of daemon/win-args.js
// (daemon/ is standalone; the server never imports it, same posture as ipc.ts).
// Keep the two in sync; test/lib/win-args.test.ts cross-checks them.
//
// Node refuses to spawn a .cmd/.bat directly (CVE-2024-27980) and CreateProcess can't
// launch a batch script, so a .cmd/.bat target must run under cmd.exe. Returns
// [comspec, ['/d','/c', <escaped command line>]] with every token quoted for the
// target's CommandLineToArgvW parser AND cmd.exe's own parser, so a path with spaces or
// an arg carrying a cmd metacharacter can neither split the line nor inject a command.
// Identity ([file, args]) on posix or for a non-.cmd/.bat file. See the daemon mirror
// for the %VAR%-expansion caveat (callers must not pass raw user text as argv on win32).

// Quote one arg for the program's own CommandLineToArgvW parser (MSVC rules).
export function quoteArgv(arg: string): string {
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

// Prefix cmd.exe metacharacters with ^ so cmd passes them to the program.
export function cmdEscape(line: string): string {
  return line.replace(/[()%!^"<>&|]/g, '^$&');
}

export function cmdInvocation(file: string, args: string[]): [string, string[]] {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return [file, args];
  const line = [file, ...args].map(quoteArgv).join(' ');
  const comspec = process.env.ComSpec || 'cmd.exe';
  return [comspec, ['/d', '/c', cmdEscape(line)]];
}

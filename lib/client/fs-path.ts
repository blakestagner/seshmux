// Splitting and joining REAL filesystem paths in the browser, where node's `path` is not
// available and the client cannot ask which OS the server is on.
//
// The naive `p.lastIndexOf('/')` is wrong on Windows in a way that does not throw and does
// not look wrong: there is no '/' in `C:\Users\Blake\Downloads`, so lastIndexOf returns -1
// and `slice(0, -1)` quietly hands back `C:\Users\Blake\Download` — a path one character
// short of real, which then fails much later as "no such directory".
//
// Separator is decided from the PATH, not from a blanket `[\\/]`: a backslash is a legal
// character in a posix filename, so `/home/b/we\ird` must keep its backslash. A path is
// treated as Windows only when it says so — a drive letter or a UNC share.
//
// Git paths are a different thing and do not belong here: git always emits forward slashes
// on every platform, so git-tree.ts and the diff views are right to split on '/' alone.
//
// CONTRACT: these take an ABSOLUTE path — a recorded agent cwd, a repo path, a folder the
// picker returned. Every caller has one. It matters because a RELATIVE path can be
// genuinely ambiguous: `Users\Blake\proj` is three segments on Windows and one legal
// filename on posix, and nothing in the string says which. Rather than guess and risk
// splitting a real posix filename, a path with no drive letter, no UNC prefix and no '/'
// is treated as posix — i.e. one segment. Absolute paths never land there: a posix one
// always carries '/', a Windows one always carries its drive or UNC prefix.

/** A drive-letter path (`C:\x`, `C:/x`) or a UNC share (`\\host\share`). */
export function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** The separator this path is written with, for joining onto it. */
export function sepOf(p: string): string {
  return isWindowsPath(p) ? '\\' : '/';
}

/** Index of the final separator, or -1. Windows accepts either; posix only '/'. */
function lastSep(p: string): number {
  return isWindowsPath(p) ? Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) : p.lastIndexOf('/');
}

/** Drop trailing separators, but never eat a root: `C:\` and `/` are whole paths. */
function trimTrailing(p: string): string {
  if (isWindowsPath(p)) return p.length > 3 ? p.replace(/[\\/]+$/, '') : p;
  return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
}

/** The containing directory, or '' when the path names no parent — a root included. */
export function dirName(p: string): string {
  const t = trimTrailing(p.trim());
  const i = lastSep(t);
  if (i < 0) return '';
  // At a root the separator found IS the root, so there is nothing above it to name.
  if (isWindowsPath(t) && i === 2) return t.length > 3 ? t.slice(0, 3) : ''; // C:\foo -> C:\
  if (i === 0) return t.length > 1 ? '/' : ''; // /foo -> /
  return t.slice(0, i);
}

/** The last segment. */
export function baseName(p: string): string {
  const t = trimTrailing(p.trim());
  const i = lastSep(t);
  return i < 0 ? t : t.slice(i + 1) || t;
}

/** `parent` + `child`, separated the way `parent` is written. */
export function joinPath(parent: string, child: string): string {
  const p = trimTrailing(parent.trim());
  const c = child.trim().replace(/^[\\/]+/, '');
  if (!p) return c;
  if (!c) return p;
  const sep = sepOf(p);
  return p.endsWith('/') || p.endsWith('\\') ? `${p}${c}` : `${p}${sep}${c}`;
}

// Turning a browser drop into something a shell can swallow. Pure, so the
// quoting and the file:// decoding are testable without a DataTransfer.
//
// Where the paths come from, in order:
//  1. our own tree drag — sets text/plain to the absolute path directly;
//  2. a Finder/Explorer drag in a browser that exposes text/uri-list as
//     file:// URLs (Safari, Firefox);
//  3. Chrome, which deliberately withholds local paths for File drops — the
//     caller falls back to uploading dataTransfer.files (see ChangesPanel /
//     TerminalPane) and pastes the path it wrote.

/** Absolute paths a drop carries as TEXT (no File upload involved). */
export function pathsFromDrop(dt: Pick<DataTransfer, 'getData'>): string[] {
  const raw = [dt.getData('text/uri-list'), dt.getData('text/plain')].join('\n');
  const out: string[] = [];
  for (const line of raw.split(/[\r\n]+/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue; // uri-list comments
    if (s.startsWith('file://')) {
      // file:///Users/x/a%20b.txt → /Users/x/a b.txt. A host component
      // (file://server/share) is a network path we can't resolve — skip it.
      try {
        const u = new URL(s);
        if (u.host) continue;
        out.push(decodeURIComponent(u.pathname));
      } catch {
        /* not a URL after all */
      }
    } else if (s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s)) {
      out.push(s);
    }
  }
  return [...new Set(out)];
}

/** POSIX single-quote quoting. ponytail: cmd.exe/PowerShell quote differently. */
export function shellQuote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/** What actually gets written into the PTY for a set of dropped paths. */
export function pasteText(paths: string[]): string {
  return paths.map(shellQuote).join(' ') + ' ';
}

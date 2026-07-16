// Parse a unified diff into renderable lines for the changes panel's file
// view. Pure — unit-testable without React. Line numbers are tracked from
// hunk headers: added/context lines carry the NEW file number, removed lines
// carry the OLD one (matches how GitHub gutters read).

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  text: string; // without the +/-/space marker
  oldNo?: number; // del + context
  newNo?: number; // add + context
}

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      lines.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (raw.startsWith('diff --git')) inHunk = false; // next file's header block
    // EVERYTHING outside a hunk is header/preamble noise — skipped wholesale.
    // Header prefixes must never be matched INSIDE a hunk: deleting a
    // `-- sql comment` line serializes as `--- sql comment` and would be
    // eaten as a header, hiding the deletion and shifting gutter numbers.
    if (!inHunk) continue;
    // Inside a hunk the only legal prefixes are +, -, space, and the
    // no-newline marker.
    if (raw.startsWith('\\ No newline')) continue;
    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ });
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ });
    } else if (raw.startsWith(' ')) {
      lines.push({ kind: 'context', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
    // anything else inside a hunk (empty trailing line) — skip
  }
  return lines;
}

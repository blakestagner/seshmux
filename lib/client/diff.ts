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

// File-level header noise (diff --git, index, ---/+++, mode/rename lines).
// Only valid OUTSIDE hunks: inside a hunk these prefixes collide with real
// content — deleting a `-- sql comment` line serializes as `--- sql comment`
// and used to be eaten as a header, silently hiding the deletion and
// shifting every later gutter number.
const HEADER_PREFIXES = [
  'diff --git',
  'index ',
  '--- ',
  '+++ ',
  'new file mode',
  'deleted file mode',
  'old mode',
  'new mode',
  'similarity index',
  'rename from',
  'rename to',
];

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
    if (!inHunk) {
      if (HEADER_PREFIXES.some((p) => raw.startsWith(p))) continue;
      continue; // anything else outside a hunk (empty preamble lines) — skip
    }
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

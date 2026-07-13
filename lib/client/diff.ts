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
  for (const raw of diff.split('\n')) {
    // file-level header noise (diff --git, index, ---/+++, mode lines) — skip;
    // the panel header already names the file.
    if (
      raw.startsWith('diff --git') ||
      raw.startsWith('index ') ||
      raw.startsWith('--- ') ||
      raw.startsWith('+++ ') ||
      raw.startsWith('new file mode') ||
      raw.startsWith('deleted file mode') ||
      raw.startsWith('old mode') ||
      raw.startsWith('new mode') ||
      raw.startsWith('similarity index') ||
      raw.startsWith('rename from') ||
      raw.startsWith('rename to') ||
      raw.startsWith('\\ No newline')
    ) {
      continue;
    }
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      lines.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ });
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ });
    } else if (raw.startsWith(' ')) {
      lines.push({ kind: 'context', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
    // anything else (empty trailing line) — skip
  }
  return lines;
}

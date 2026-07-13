import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '../../lib/client/diff';

const SAMPLE = `diff --git a/a.txt b/a.txt
index 1234567..89abcde 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,4 @@
 one
-two
+TWO
+three
 four
`;

describe('parseUnifiedDiff', () => {
  it('classifies and numbers lines', () => {
    const lines = parseUnifiedDiff(SAMPLE);
    expect(lines.map((l) => l.kind)).toEqual(['hunk', 'context', 'del', 'add', 'add', 'context']);
    expect(lines[1]).toMatchObject({ text: 'one', oldNo: 1, newNo: 1 });
    expect(lines[2]).toMatchObject({ text: 'two', oldNo: 2 });
    expect(lines[3]).toMatchObject({ text: 'TWO', newNo: 2 });
    expect(lines[4]).toMatchObject({ text: 'three', newNo: 3 });
    expect(lines[5]).toMatchObject({ text: 'four', oldNo: 3, newNo: 4 });
  });

  it('skips file headers and no-newline markers', () => {
    const lines = parseUnifiedDiff('diff --git a/x b/x\nnew file mode 100644\n@@ -0,0 +1 @@\n+hi\n\\ No newline at end of file\n');
    expect(lines.map((l) => l.kind)).toEqual(['hunk', 'add']);
  });

  it('handles empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

describe('parseUnifiedDiff — header prefixes inside hunks (review fix)', () => {
  it('keeps a deleted line that looks like a --- header', () => {
    const d = 'diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,1 @@\n--- name: ListUsers :many\n select 1;\n';
    const lines = parseUnifiedDiff(d);
    expect(lines.map((l) => l.kind)).toEqual(['hunk', 'del', 'context']);
    expect(lines[1]).toMatchObject({ kind: 'del', text: '-- name: ListUsers :many', oldNo: 1 });
    expect(lines[2]).toMatchObject({ text: 'select 1;', oldNo: 2, newNo: 1 });
  });

  it('keeps an added line that looks like a +++ header', () => {
    const d = '@@ -0,0 +1 @@\n+++ weird content\n';
    const lines = parseUnifiedDiff(d);
    expect(lines[1]).toMatchObject({ kind: 'add', text: '++ weird content', newNo: 1 });
  });

  it('resets header handling at the next file boundary', () => {
    const d = '@@ -1 +1 @@\n-x\n+y\ndiff --git a/b b/b\nindex 123..456\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-p\n+q\n';
    const kinds = parseUnifiedDiff(d).map((l) => l.kind);
    expect(kinds).toEqual(['hunk', 'del', 'add', 'hunk', 'del', 'add']);
  });
});

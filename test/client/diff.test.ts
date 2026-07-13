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

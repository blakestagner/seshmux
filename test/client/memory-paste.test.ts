// memory-paste: wrapping a pack for delivery into a live PTY. Pure, so this is the whole
// specification of the delivery contract — most importantly that a multi-line block cannot
// submit itself line by line, and that nothing is sent by default.
import { describe, it, expect } from 'vitest';
import { budgetLabel, estimateRowTokens, memoryPaste, PASTE_END, PASTE_START } from '../../lib/client/memory-paste';

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

describe('memoryPaste', () => {
  it('wraps the block in bracketed-paste markers', () => {
    const out = memoryPaste('hello');
    expect(out).toBe(`${ESC}[200~hello${ESC}[201~`);
  });

  it('keeps a multi-line block as ONE paste', () => {
    // The property that matters: typed newlines would submit each line separately, firing
    // three half-messages at the agent instead of one block.
    const out = memoryPaste('line one\nline two\nline three');
    expect(out.startsWith(PASTE_START)).toBe(true);
    expect(out.endsWith(PASTE_END)).toBe(true);
    // Exactly one paste region.
    expect(out.split(PASTE_START)).toHaveLength(2);
    expect(out.split(PASTE_END)).toHaveLength(2);
  });

  it('does not press Enter by default', () => {
    // A person stays between "load memory" and "the agent acts on it".
    expect(memoryPaste('line one\nline two')).not.toContain(CR);
  });

  it('presses Enter only when explicitly asked', () => {
    expect(memoryPaste('hello', { submit: true }).endsWith(PASTE_END + CR)).toBe(true);
  });

  it('strips paste markers smuggled inside the text', () => {
    // A record carrying an END marker would close the paste early and turn the remainder
    // into live keystrokes.
    const hostile = `safe ${PASTE_END} rm -rf / ${PASTE_START} more`;
    const out = memoryPaste(hostile);
    expect(out.split(PASTE_END)).toHaveLength(2); // only the one we added
    expect(out.split(PASTE_START)).toHaveLength(2);
  });

  it('trims trailing whitespace so the input does not open with blank lines', () => {
    expect(memoryPaste('body\n\n  \n')).toBe(`${PASTE_START}body${PASTE_END}`);
  });

  it('sends nothing for an empty pack', () => {
    expect(memoryPaste('')).toBe('');
    expect(memoryPaste('   \n  ')).toBe('');
  });
});

describe('budget helpers', () => {
  it('labels the running cost', () => {
    expect(budgetLabel(420, 1500)).toBe('~420 tok of 1500');
  });

  it('sums the per-row estimates', () => {
    expect(estimateRowTokens([{ tokens: 10 }, { tokens: 32 }])).toBe(42);
    expect(estimateRowTokens([])).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { renderOutcomeBlocks } from '../../lib/client/subagent-outcome';

describe('renderOutcomeBlocks', () => {
  it('text kind → single markdown block', () => {
    const blocks = renderOutcomeBlocks({ kind: 'text', raw: 'hello **world**' });
    expect(blocks).toEqual([{ kind: 'markdown', text: 'hello **world**' }]);
  });

  it('json with all known keys → markdown+files+badge+prose in order', () => {
    const raw = JSON.stringify({ summary: 'did stuff', files: ['a.ts', 'b.ts'], testsPassed: true, notes: 'x' });
    const blocks = renderOutcomeBlocks({ kind: 'json', raw });
    expect(blocks).toEqual([
      { kind: 'markdown', text: 'did stuff' },
      { kind: 'files', files: ['a.ts', 'b.ts'] },
      { kind: 'badge', label: 'tests', ok: true },
      { kind: 'prose', text: 'x' },
    ]);
  });

  it('json with only testsPassed:false → single badge block, ok:false', () => {
    const blocks = renderOutcomeBlocks({ kind: 'json', raw: JSON.stringify({ testsPassed: false }) });
    expect(blocks).toEqual([{ kind: 'badge', label: 'tests', ok: false }]);
  });

  it('junk string (invalid JSON) → single pre block, no throw', () => {
    const blocks = renderOutcomeBlocks({ kind: 'json', raw: 'not json {' });
    expect(blocks).toEqual([{ kind: 'pre', text: 'not json {' }]);
  });

  it('json array with no known keys → single pre block', () => {
    const raw = JSON.stringify([1, 2]);
    const blocks = renderOutcomeBlocks({ kind: 'json', raw });
    expect(blocks).toEqual([{ kind: 'pre', text: JSON.stringify([1, 2], null, 2) }]);
  });
});

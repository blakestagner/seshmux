import { describe, it, expect } from 'vitest';
import {
  leaf, split, cloneNode, leafIds, normalize, removeLeaf, replaceLeaf, swapIds,
  type LayoutNode,
} from '../../lib/client/grid-layout';

describe('grid-layout tree core', () => {
  it('split defaults to equal fractions', () => {
    const s = split('h', [leaf('a'), leaf('b')]);
    expect(s).toEqual({ t: 's', dir: 'h', f: [0.5, 0.5], c: [leaf('a'), leaf('b')] });
  });

  it('leafIds walks depth-first', () => {
    const t = split('h', [leaf('a'), split('v', [leaf('b'), leaf('c')])]);
    expect(leafIds(t)).toEqual(['a', 'b', 'c']);
  });

  it('normalize collapses single-child splits', () => {
    const t: LayoutNode = { t: 's', dir: 'h', f: [1], c: [leaf('a')] };
    expect(normalize(t)).toEqual(leaf('a'));
  });

  it('normalize flattens same-direction nesting and renormalizes fractions', () => {
    const t = split('h', [leaf('a'), split('h', [leaf('b'), leaf('c')], [0.5, 0.5])], [0.5, 0.5]);
    const n = normalize(t);
    expect(n).toEqual(split('h', [leaf('a'), leaf('b'), leaf('c')], [0.5, 0.25, 0.25]));
  });

  it('removeLeaf drops the id and renormalizes siblings', () => {
    const t = split('h', [leaf('a'), leaf('b'), leaf('c')], [0.5, 0.25, 0.25]);
    expect(removeLeaf(t, 'a')).toEqual(split('h', [leaf('b'), leaf('c')], [0.5, 0.5]));
  });

  it('removeLeaf collapses a two-child split to the survivor', () => {
    const t = split('h', [leaf('a'), leaf('b')]);
    expect(removeLeaf(t, 'b')).toEqual(leaf('a'));
  });

  it('removeLeaf returns null when the whole tree vanishes', () => {
    expect(removeLeaf(leaf('a'), 'a')).toBeNull();
  });

  it('replaceLeaf swaps a leaf for a subtree in place', () => {
    const t = split('h', [leaf('a'), leaf('b')]);
    const r = replaceLeaf(cloneNode(t), 'b', split('v', [leaf('b'), leaf('x')]));
    expect(leafIds(r)).toEqual(['a', 'b', 'x']);
  });

  it('swapIds exchanges two leaf ids', () => {
    const t = split('h', [leaf('a'), split('v', [leaf('b'), leaf('c')])]);
    expect(leafIds(swapIds(cloneNode(t), 'a', 'c'))).toEqual(['c', 'b', 'a']);
  });

  it('cloneNode deep-copies (mutating the clone leaves the original intact)', () => {
    const t = split('h', [leaf('a'), leaf('b')]);
    const c = cloneNode(t);
    swapIds(c, 'a', 'b');
    expect(leafIds(t)).toEqual(['a', 'b']);
  });
});

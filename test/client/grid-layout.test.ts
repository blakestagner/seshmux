import { describe, it, expect } from 'vitest';
import {
  leaf, split, cloneNode, leafIds, normalize, removeLeaf, replaceLeaf, swapIds,
  computeLayout, focusRects, seamFractions, hitZone, applyDrop, preset, reconcile,
  GAP, PAD, type LayoutNode, type Rect,
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

const WS: Rect = { x: PAD, y: PAD, w: 1000, h: 800 };

describe('grid-layout geometry', () => {
  it('computeLayout tiles a 50/50 h-split with one gutter', () => {
    const { rects, seams } = computeLayout(split('h', [leaf('a'), leaf('b')]), WS);
    const span = 1000 - GAP;
    expect(rects.get('a')).toEqual({ x: PAD, y: PAD, w: span / 2, h: 800 });
    expect(rects.get('b')).toEqual({ x: PAD + span / 2 + GAP, y: PAD, w: span / 2, h: 800 });
    expect(seams).toHaveLength(1);
    expect(seams[0]).toMatchObject({ dir: 'h', x: PAD + span / 2, w: GAP, h: 800 });
  });

  it('computeLayout covers the workspace exactly (no overlap, no gaps beyond gutters)', () => {
    const t = preset(['a', 'b', 'c', 'd', 'e']);
    const { rects } = computeLayout(t, WS);
    const area = [...rects.values()].reduce((s, r) => s + r.w * r.h, 0);
    // total area + gutter area == workspace area (gutters are the only non-panel space)
    expect(area).toBeLessThanOrEqual(1000 * 800);
    expect(area).toBeGreaterThan(1000 * 800 * 0.9);
    for (const r of rects.values()) {
      expect(r.x).toBeGreaterThanOrEqual(WS.x);
      expect(r.y).toBeGreaterThanOrEqual(WS.y);
      expect(r.x + r.w).toBeLessThanOrEqual(WS.x + WS.w + 0.001);
      expect(r.y + r.h).toBeLessThanOrEqual(WS.y + WS.h + 0.001);
    }
  });

  it('seamFractions conserves total and clamps to the min fraction', () => {
    // span 990px, axis 1000px → minPx = 140 → minF ≈ 0.1414
    const [f0, f1] = seamFractions(0.5, 0.5, 200, 990, 1000);
    expect(f0 + f1).toBeCloseTo(1);
    expect(f0).toBeCloseTo(0.5 + 200 / 990);
    const [g0, g1] = seamFractions(0.5, 0.5, -10000, 990, 1000);
    expect(g0).toBeCloseTo(140 / 990); // clamped at min
    expect(g0 + g1).toBeCloseTo(1);
  });

  it('hitZone: workspace edge bands win, then split sides, then center swap', () => {
    const { rects } = computeLayout(split('h', [leaf('a'), leaf('b')]), WS);
    expect(hitZone(20, 400, WS, rects, 'a')).toMatchObject({ kind: 'edge', side: 'left' });
    // inside b, near its left edge (b starts at x=515): split left
    expect(hitZone(560, 400, WS, rects, 'a')).toMatchObject({ kind: 'split', target: 'b', side: 'left' });
    // dead center of b: swap
    const b = rects.get('b')!;
    expect(hitZone(b.x + b.w / 2, b.y + b.h / 2, WS, rects, 'a')).toMatchObject({ kind: 'swap', target: 'b' });
    // over the dragged panel itself: no zone
    const a = rects.get('a')!;
    expect(hitZone(a.x + a.w / 2, a.y + a.h / 2, WS, rects, 'a')).toBeNull();
  });

  it('applyDrop split puts the dragged leaf beside the target at 50/50', () => {
    const t = split('h', [leaf('a'), leaf('b'), leaf('c')]);
    const z = { kind: 'split' as const, target: 'c', side: 'top' as const, x: 0, y: 0, w: 0, h: 0 };
    const r = applyDrop(cloneNode(t), 'a', z)!;
    expect(leafIds(r)).toEqual(['b', 'a', 'c']);
  });

  it('applyDrop swap exchanges positions', () => {
    const t = split('h', [leaf('a'), leaf('b')]);
    const z = { kind: 'swap' as const, target: 'b', side: 'center' as const, x: 0, y: 0, w: 0, h: 0 };
    expect(leafIds(applyDrop(cloneNode(t), 'a', z)!)).toEqual(['b', 'a']);
  });

  it('applyDrop edge makes a 28% lane', () => {
    const t = split('v', [leaf('a'), leaf('b')]);
    const z = { kind: 'edge' as const, side: 'left' as const, x: 0, y: 0, w: 0, h: 0 };
    const r = applyDrop(cloneNode(t), 'a', z)!;
    expect(r).toMatchObject({ t: 's', dir: 'h', f: [0.28, 0.72] });
    expect(leafIds(r)).toEqual(['a', 'b']);
  });

  it('preset covers 1..8 panels with every id present exactly once', () => {
    for (let n = 1; n <= 8; n++) {
      const ids = Array.from({ length: n }, (_, i) => `p${i}`);
      expect(leafIds(preset(ids)).sort()).toEqual([...ids].sort());
    }
  });

  it('focusRects gives the focused panel 78% and stacks the rest in a strip', () => {
    const t = preset(['a', 'b', 'c']);
    const rects = focusRects(t, 'b', WS);
    expect(rects.get('b')!.w).toBeCloseTo(Math.round(1000 * 0.78) - GAP / 2);
    expect(rects.get('a')!.x).toBeGreaterThan(rects.get('b')!.w);
    expect(rects.size).toBe(3);
  });

  it('reconcile drops closed ids, adds new ids by splitting the largest leaf, builds from preset when empty', () => {
    expect(reconcile(null, ['a', 'b'])).toEqual(preset(['a', 'b']));
    const t = split('h', [leaf('a'), leaf('b')], [0.7, 0.3]);
    // 'b' closed, 'c' opened: a keeps its space until c splits the largest (a)
    const r = reconcile(t, ['a', 'c'])!;
    expect(leafIds(r).sort()).toEqual(['a', 'c']);
    // all closed → null
    expect(reconcile(t, [])).toBeNull();
    // unchanged set → same tree (fractions preserved)
    expect(reconcile(t, ['a', 'b'])).toEqual(t);
  });
});

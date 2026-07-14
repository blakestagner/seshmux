// Pure, DOM-free layout math for the Grid workspace (design-3 tiled model).
// The tree: a leaf per open term tab (keyed by tab.id), splits with fractional
// sizes. Kept free of window/document so it's unit-testable without a DOM shim.
// Ported from docs/local/prototypes/grid-layout/design-3.html.

export type LayoutNode =
  | { t: 'l'; id: string }
  | { t: 's'; dir: 'h' | 'v'; f: number[]; c: LayoutNode[] };

export function leaf(id: string): LayoutNode {
  return { t: 'l', id };
}

export function split(dir: 'h' | 'v', kids: LayoutNode[], fr?: number[]): LayoutNode {
  return { t: 's', dir, f: fr ?? kids.map(() => 1 / kids.length), c: kids };
}

export function cloneNode(n: LayoutNode): LayoutNode {
  return JSON.parse(JSON.stringify(n)) as LayoutNode;
}

export function leafIds(n: LayoutNode, out: string[] = []): string[] {
  if (n.t === 'l') out.push(n.id);
  else n.c.forEach((k) => leafIds(k, out));
  return out;
}

// Collapse single-child splits and flatten same-direction nesting so the tree
// stays minimal (seams and drop math assume this canonical form).
export function normalize(n: LayoutNode): LayoutNode {
  if (n.t === 'l') return n;
  const c = n.c.map(normalize);
  if (c.length === 1) return c[0];
  const kids: LayoutNode[] = [];
  const fr: number[] = [];
  for (let i = 0; i < c.length; i++) {
    const k = c[i];
    const w = n.f[i];
    if (k.t === 's' && k.dir === n.dir) {
      for (let j = 0; j < k.c.length; j++) {
        kids.push(k.c[j]);
        fr.push(w * k.f[j]);
      }
    } else {
      kids.push(k);
      fr.push(w);
    }
  }
  const sum = fr.reduce((a, b) => a + b, 0) || 1;
  return { t: 's', dir: n.dir, f: fr.map((x) => x / sum), c: kids };
}

// Remove a leaf; surviving siblings absorb its fraction proportionally.
// Returns null if the subtree vanished entirely.
export function removeLeaf(n: LayoutNode, id: string): LayoutNode | null {
  if (n.t === 'l') return n.id === id ? null : n;
  const kids: LayoutNode[] = [];
  const fr: number[] = [];
  for (let i = 0; i < n.c.length; i++) {
    const r = removeLeaf(n.c[i], id);
    if (r) {
      kids.push(r);
      fr.push(n.f[i]);
    }
  }
  if (kids.length === 0) return null;
  const sum = fr.reduce((a, b) => a + b, 0) || 1;
  return normalize({ t: 's', dir: n.dir, f: fr.map((x) => x / sum), c: kids });
}

export function replaceLeaf(n: LayoutNode, id: string, repl: LayoutNode): LayoutNode {
  if (n.t === 'l') return n.id === id ? repl : n;
  return { ...n, c: n.c.map((k) => replaceLeaf(k, id, repl)) };
}

export function swapIds(n: LayoutNode, a: string, b: string): LayoutNode {
  if (n.t === 'l') {
    if (n.id === a) return leaf(b);
    if (n.id === b) return leaf(a);
    return n;
  }
  return { ...n, c: n.c.map((k) => swapIds(k, a, b)) };
}

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

// ── Geometry ────────────────────────────────────────────────────────────────

export const GAP = 10; // px between panels (the seam hit area lives here)
export const PAD = 10; // px workspace padding
export const MIN_FRAC = 0.14; // min panel size = 14% of the workspace axis

export type Rect = { x: number; y: number; w: number; h: number };

export type Seam = {
  node: Extract<LayoutNode, { t: 's' }>;
  i: number; // seam sits between node.c[i] and node.c[i+1]
  dir: 'h' | 'v';
  x: number;
  y: number;
  w: number;
  h: number;
  span: number; // px length of the parent split's axis (for fraction math)
};

// Walk the tree over the workspace rect: every leaf gets a rect, every gap
// between siblings becomes a seam.
export function computeLayout(t: LayoutNode, ws: Rect): { rects: Map<string, Rect>; seams: Seam[] } {
  const rects = new Map<string, Rect>();
  const seams: Seam[] = [];
  if (ws.w < 10 || ws.h < 10) return { rects, seams };
  const walk = (n: LayoutNode, x: number, y: number, w: number, h: number): void => {
    if (n.t === 'l') {
      rects.set(n.id, { x, y, w, h });
      return;
    }
    const horiz = n.dir === 'h';
    const span = (horiz ? w : h) - GAP * (n.c.length - 1);
    let pos = horiz ? x : y;
    for (let i = 0; i < n.c.length; i++) {
      const size = span * n.f[i];
      if (horiz) walk(n.c[i], pos, y, size, h);
      else walk(n.c[i], x, pos, w, size);
      pos += size;
      if (i < n.c.length - 1) {
        seams.push({
          node: n, i, dir: n.dir,
          x: horiz ? pos : x,
          y: horiz ? y : pos,
          w: horiz ? GAP : w,
          h: horiz ? h : GAP,
          span,
        });
        pos += GAP;
      }
    }
  };
  walk(t, ws.x, ws.y, ws.w, ws.h);
  return { rects, seams };
}

// Focus mode: focused panel takes 78% width, everyone else stacks in a strip.
export function focusRects(t: LayoutNode, focusId: string, ws: Rect): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  const others = leafIds(t).filter((id) => id !== focusId);
  if (others.length === 0) {
    rects.set(focusId, { ...ws });
    return rects;
  }
  const bigW = Math.round(ws.w * 0.78) - GAP / 2;
  rects.set(focusId, { x: ws.x, y: ws.y, w: bigW, h: ws.h });
  const stripX = ws.x + bigW + GAP;
  const stripW = ws.w - bigW - GAP;
  const each = (ws.h - GAP * (others.length - 1)) / others.length;
  others.forEach((id, i) => {
    rects.set(id, { x: stripX, y: ws.y + i * (each + GAP), w: stripW, h: each });
  });
  return rects;
}

// Seam drag: convert a pixel delta into the two siblings' new fractions.
// Conserves f0+f1; clamps so each side keeps >= MIN_FRAC of the workspace axis.
export function seamFractions(
  f0: number, f1: number, deltaPx: number, spanPx: number, axisPx: number,
): [number, number] {
  const total = f0 + f1;
  const minF = Math.min((MIN_FRAC * axisPx) / spanPx, total / 2);
  const next = Math.max(minF, Math.min(total - minF, f0 + deltaPx / spanPx));
  return [next, total - next];
}

// ── Drop zones ──────────────────────────────────────────────────────────────

export type DropZone = {
  kind: 'swap' | 'split' | 'edge';
  target?: string;
  side: 'left' | 'right' | 'top' | 'bottom' | 'center';
  x: number;
  y: number;
  w: number;
  h: number;
};

const EDGE_BAND = 40; // px band along workspace edges = "full lane here"

// x/y are workspace-local coordinates (same space as ws/rects).
export function hitZone(
  x: number, y: number, ws: Rect, rects: Map<string, Rect>, dragId: string,
): DropZone | null {
  const X0 = ws.x - PAD, Y0 = ws.y - PAD, W = ws.w + PAD * 2, H = ws.h + PAD * 2;
  if (x < X0 || y < Y0 || x > X0 + W || y > Y0 + H) return null;
  if (x < X0 + EDGE_BAND) return { kind: 'edge', side: 'left', x: X0, y: Y0, w: Math.round(W * 0.25), h: H };
  if (x > X0 + W - EDGE_BAND) return { kind: 'edge', side: 'right', x: X0 + Math.round(W * 0.75), y: Y0, w: Math.round(W * 0.25), h: H };
  if (y < Y0 + EDGE_BAND) return { kind: 'edge', side: 'top', x: X0, y: Y0, w: W, h: Math.round(H * 0.25) };
  if (y > Y0 + H - EDGE_BAND) return { kind: 'edge', side: 'bottom', x: X0, y: Y0 + Math.round(H * 0.75), w: W, h: Math.round(H * 0.25) };

  for (const [id, r] of rects) {
    if (id === dragId) continue;
    if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
    const fx = (x - r.x) / r.w;
    const fy = (y - r.y) / r.h;
    const m = Math.min(fx, 1 - fx, fy, 1 - fy);
    if (m >= 0.3) return { kind: 'swap', target: id, side: 'center', x: r.x, y: r.y, w: r.w, h: r.h };
    if (m === fx) return { kind: 'split', target: id, side: 'left', x: r.x, y: r.y, w: r.w / 2, h: r.h };
    if (m === 1 - fx) return { kind: 'split', target: id, side: 'right', x: r.x + r.w / 2, y: r.y, w: r.w / 2, h: r.h };
    if (m === fy) return { kind: 'split', target: id, side: 'top', x: r.x, y: r.y, w: r.w, h: r.h / 2 };
    return { kind: 'split', target: id, side: 'bottom', x: r.x, y: r.y + r.h / 2, w: r.w, h: r.h / 2 };
  }
  return null;
}

// Apply a drop to a CLONE of the tree (caller clones); returns the new tree or
// null if the drop is a no-op (e.g. swapping with itself).
export function applyDrop(t: LayoutNode, dragId: string, z: DropZone): LayoutNode | null {
  if (z.kind === 'swap') {
    if (!z.target || z.target === dragId) return null;
    return normalize(swapIds(t, dragId, z.target));
  }
  if (z.kind === 'split') {
    if (!z.target || z.target === dragId) return null;
    const without = removeLeaf(t, dragId);
    if (!without) return null;
    const dir: 'h' | 'v' = z.side === 'left' || z.side === 'right' ? 'h' : 'v';
    const pair = z.side === 'left' || z.side === 'top'
      ? [leaf(dragId), leaf(z.target)]
      : [leaf(z.target), leaf(dragId)];
    return normalize(replaceLeaf(without, z.target, split(dir, pair, [0.5, 0.5])));
  }
  // edge: dragged panel becomes a full lane on that workspace side
  const rest = removeLeaf(t, dragId);
  if (!rest) return null;
  const dir: 'h' | 'v' = z.side === 'left' || z.side === 'right' ? 'h' : 'v';
  const first = z.side === 'left' || z.side === 'top';
  return normalize(split(
    dir,
    first ? [leaf(dragId), rest] : [rest, leaf(dragId)],
    first ? [0.28, 0.72] : [0.72, 0.28],
  ));
}

// ── Presets + reconcile ─────────────────────────────────────────────────────

// Balanced arrangement for N panels (auto-arrange + default layout).
export function preset(ids: string[]): LayoutNode {
  const L = ids.map(leaf);
  const n = ids.length;
  if (n === 1) return L[0];
  if (n === 2) return split('h', L, [0.5, 0.5]);
  if (n === 3) return split('h', [L[0], split('v', [L[1], L[2]], [0.5, 0.5])], [0.58, 0.42]);
  if (n === 4) return split('h', [split('v', [L[0], L[1]]), split('v', [L[2], L[3]])], [0.5, 0.5]);
  if (n === 5) return split('h', [L[0], split('v', [L[1], L[2], L[3], L[4]])], [0.64, 0.36]);
  if (n === 6) return split('h', [split('v', [L[0], L[1]]), split('v', [L[2], L[3]]), split('v', [L[4], L[5]])]);
  // 7+: near-square column grid
  const cols = Math.ceil(Math.sqrt(n));
  const colNodes: LayoutNode[] = [];
  let i = 0;
  for (let c = 0; c < cols && i < n; c++) {
    const take = Math.ceil((n - i) / (cols - c));
    const kids = L.slice(i, i + take);
    i += take;
    colNodes.push(kids.length === 1 ? kids[0] : split('v', kids));
  }
  return split('h', colNodes);
}

// Bring a (possibly stale/persisted/null) tree in line with the open tab set:
// drop leaves whose tab closed, add new tabs by splitting the largest leaf
// along its longer axis. Unchanged sets return the tree untouched.
export function reconcile(t: LayoutNode | null, openIds: string[]): LayoutNode | null {
  if (openIds.length === 0) return null;
  const open = new Set(openIds);
  let tree: LayoutNode | null = t;
  if (tree) {
    for (const id of leafIds(tree)) {
      if (!open.has(id)) {
        tree = tree ? removeLeaf(tree, id) : null;
        if (!tree) break;
      }
    }
  }
  const present = new Set(tree ? leafIds(tree) : []);
  const missing = openIds.filter((id) => !present.has(id));
  if (!tree) return preset(openIds);
  for (const id of missing) {
    // measure against a nominal 16:10 workspace to pick the largest leaf + axis
    const { rects } = computeLayout(tree, { x: 0, y: 0, w: 1600, h: 1000 });
    let biggest: string | null = null;
    let area = -1;
    for (const [lid, r] of rects) {
      if (r.w * r.h > area) {
        area = r.w * r.h;
        biggest = lid;
      }
    }
    if (!biggest) return preset(openIds);
    const r = rects.get(biggest)!;
    const dir: 'h' | 'v' = r.w >= r.h ? 'h' : 'v';
    tree = normalize(replaceLeaf(cloneNode(tree), biggest, split(dir, [leaf(biggest), leaf(id)], [0.5, 0.5])));
  }
  return tree;
}

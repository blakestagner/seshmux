// Pure, DOM-free resize math shared by every drag-resizable pane (rail,
// future split panes). Kept free of window/document so it's unit-testable
// without a DOM shim.

// Clamp a proposed pixel size to [min, max].
export function clampSize(proposed: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, proposed));
}

// Read a persisted number from a raw string|null (localStorage.getItem result),
// clamp to [min,max]; return `fallback` (already assumed in-range) if absent/NaN/corrupt.
export function readPersistedSize(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return clampSize(n, min, max);
}

// Given a container's total width and a proposed LEFT-pane width, clamp so BOTH
// sides keep their minimums. Returns the clamped left width.
// leftMin, rightMin are px. If container too small to honor both, prefer leftMin.
export function clampSplit(proposedLeft: number, containerWidth: number, leftMin: number, rightMin: number): number {
  const maxLeft = Math.max(leftMin, containerWidth - rightMin);
  return clampSize(proposedLeft, leftMin, maxLeft);
}

// Convert a persisted RATIO (0..1, left fraction) + container width to a left px width,
// then clamp via clampSplit. Used to restore a split from a stored ratio.
export function ratioToLeftPx(ratio: number, containerWidth: number, leftMin: number, rightMin: number): number {
  return clampSplit(ratio * containerWidth, containerWidth, leftMin, rightMin);
}

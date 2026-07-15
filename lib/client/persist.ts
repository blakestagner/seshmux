'use client';

// Debounced localStorage.setItem, one timer per key. Drag-fed persists (rail
// width, viewer split, sessions height) update state once per rAF frame; a
// synchronous setItem per frame is a main-thread disk write competing with the
// repaint of live xterm panes under the drag. Trailing-edge write means the
// final value always lands (~250ms after the last move — drag end included).
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function persistDebounced(key: string, value: string, ms = 250): void {
  const t = timers.get(key);
  if (t !== undefined) clearTimeout(t);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      localStorage.setItem(key, value);
    }, ms),
  );
}

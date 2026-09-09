'use client';
// Tab strip layout across a reload ('seshmux-tab-layout').
//
// The set of tabs that comes back after a refresh is derived from the daemon's
// live-PTY list, not from anything the client saved — that is deliberate (a PTY
// that died while the page was closed must NOT come back as a dead tab). But
// GET /api/sessions/live answers in daemon order and knows nothing about the
// strip, so everything the user arranged on top of that set — the DnD order and
// which tabs were minimized — was lost on every refresh.
//
// This stores just that thin layer: an ordered list of tab ids plus each one's
// minimized flag. It is advisory. A tab id in here that has no live PTY is
// ignored, and a live PTY missing from here still opens (appended at the end),
// so a stale or absent entry degrades to today's behaviour instead of hiding a
// terminal — the failure mode the dismissal list already taught us to avoid.
const KEY = 'seshmux-tab-layout';

export type TabLayoutEntry = { id: string; minimized: boolean };

export function readTabLayout(): TabLayoutEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is { id: string; minimized?: unknown } => !!e && typeof e.id === 'string')
      .map((e) => ({ id: e.id, minimized: e.minimized === true }));
  } catch {
    return []; // corrupt / unavailable → no saved layout
  }
}

export function writeTabLayout(entries: TabLayoutEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* localStorage unavailable — layout just won't persist */
  }
}

/**
 * Order live sessions by the saved strip order. Sessions the layout has never
 * seen (spawned from another browser tab, or started while this one was closed)
 * keep their relative live-order and go last — appended, exactly as openTerm
 * would have appended them had they arrived while the page was open.
 *
 * Pure + generic over the session shape so it can be unit-tested without a DOM.
 */
export function orderByLayout<T>(
  sessions: T[],
  tabIdOf: (s: T) => string,
  layout: TabLayoutEntry[],
): T[] {
  const rank = new Map(layout.map((e, i) => [e.id, i]));
  return sessions
    .map((s, i) => ({ s, i, r: rank.get(tabIdOf(s)) ?? Infinity }))
    // Stable on ties: `i` breaks Infinity-vs-Infinity so unknown sessions keep live order.
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.s);
}

/** Tab ids the saved layout had minimized, limited to ones that actually opened. */
export function minimizedFromLayout(layout: TabLayoutEntry[], openedTabIds: string[]): string[] {
  const opened = new Set(openedTabIds);
  return layout.filter((e) => e.minimized && opened.has(e.id)).map((e) => e.id);
}

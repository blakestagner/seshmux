'use client';
// The tab-dismissal list ('seshmux-dismissed-ptys') — one home for the key, so
// the three call sites (endTermSession, boot rehydrate, jumpToWaiting) can't
// drift apart on its semantics.
//
// WHAT IT IS: a SHORT-LIVED guard, not a permanent blacklist. Closing a tab
// kills the PTY, but the kill is async and other browser tabs / a reload landing
// inside that window would otherwise see the PTY still in GET /api/sessions/live
// and reopen the tab the user just closed. The entry covers exactly that window.
//
// WHY IT MUST BE PRUNED: daemon ptyIds are RECYCLED. `_nextId` restarts at 1 in
// every fresh daemon (pty-manager only bumps it past ptyIds claimed by surviving
// holders on disk), and without tmux — every Windows install — dismissalKey()
// falls back to the ptyId. So a permanent entry blacklists that numeric slot
// forever: after any daemon restart the next session spawned is handed `pty-1`
// again, boot rehydrate skips it as "dismissed", and a live terminal the user
// never closed silently vanishes on every refresh. Bounding the list to PTYs
// that are actually still alive is what keeps a stale entry from poisoning an
// unrelated future session.
//
// KEY BUMP: entries written by the old "permanent blacklist" build are
// indistinguishable from a legitimate in-flight one, so they cannot be pruned by
// inspection — an already-poisoned browser would keep hiding a live `pty-1` for
// one more load. Bumping the key abandons that data outright, which is the safe
// direction: the worst case is that a tab whose kill FAILED reappears once, and
// that PTY is genuinely still running, so showing it is the more honest answer.
const KEY = 'seshmux-dismissed-ptys-v2';
const LEGACY_KEY = 'seshmux-dismissed-ptys';

function read(): string[] {
  try {
    localStorage.removeItem(LEGACY_KEY); // one-way migration; see KEY BUMP above
  } catch {
    /* localStorage unavailable — nothing to migrate */
  }
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return []; // corrupt / unavailable → treat as none
  }
}

function write(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* localStorage unavailable — dismissal just won't persist */
  }
}

export function readDismissed(): string[] {
  return read();
}

export function addDismissed(id: string): void {
  if (!id) return;
  const cur = read();
  if (!cur.includes(id)) write([...cur, id]);
}

export function removeDismissed(id: string): void {
  if (!id) return;
  const cur = read();
  if (cur.includes(id)) write(cur.filter((x) => x !== id));
}

/**
 * Pure half of the prune, so it can be tested without localStorage: keep only
 * the dismissals whose PTY is STILL alive. Anything else has already been
 * killed — there is nothing left for it to suppress, and leaving it behind is
 * what lets a recycled ptyId inherit someone else's dismissal.
 */
export function keepLiveDismissals(dismissed: string[], liveKeys: string[]): string[] {
  const live = new Set(liveKeys);
  return dismissed.filter((id) => live.has(id));
}

/**
 * Prune against the live-PTY set and return what survived. Called once per boot
 * rehydrate, which is both the only place the list is consumed and the only
 * place a trustworthy live set exists.
 */
export function pruneDismissed(liveKeys: string[]): string[] {
  const cur = read();
  const kept = keepLiveDismissals(cur, liveKeys);
  if (kept.length !== cur.length) write(kept);
  return kept;
}

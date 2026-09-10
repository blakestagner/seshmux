// Back/forward for the preview panel's iframe, and the URL-bar's input parsing.
// Pure — no React, no DOM — so the history semantics are unit-tested without a
// render, same posture as right-pane.ts.
//
// WHY WE KEEP OUR OWN STACK. The previewed app is cross-origin (seshmux is on
// :4700, your dev server on :3000), and `iframe.contentWindow.history` is not
// reachable across origins — `history.back()` throws, and there is no event for
// "the user clicked a link in there". So this stack records only the
// navigations WE perform: URL-bar entries, port switches, the initial load.
// Following a link inside the page moves the iframe without moving this stack,
// which means Back returns to the last URL seshmux set rather than the last
// page you saw. That is a real limitation, not a bug to chase: closing it would
// mean proxying the app through seshmux's own origin, which breaks HMR
// websockets and absolute redirects for a nicety.

export interface NavState {
  /** Visited URLs, oldest first. */
  stack: string[];
  /** Index into `stack` of the URL currently loaded. -1 when empty. */
  index: number;
}

export const emptyNav: NavState = { stack: [], index: -1 };

export function initialNav(url?: string | null): NavState {
  return url ? { stack: [url], index: 0 } : emptyNav;
}

export const current = (s: NavState): string => s.stack[s.index] ?? '';
export const canBack = (s: NavState): boolean => s.index > 0;
export const canForward = (s: NavState): boolean => s.index >= 0 && s.index < s.stack.length - 1;

/**
 * Go to `url`, dropping any forward entries — standard browser semantics.
 * Re-navigating to the URL already shown is a no-op rather than a duplicate
 * entry, so mashing Enter in the URL bar (or a reload) never builds a stack of
 * identical steps you then have to click back through.
 */
export function navigate(s: NavState, url: string): NavState {
  if (!url) return s;
  if (current(s) === url) return s;
  const stack = [...s.stack.slice(0, s.index + 1), url];
  return { stack, index: stack.length - 1 };
}

export function back(s: NavState): NavState {
  return canBack(s) ? { ...s, index: s.index - 1 } : s;
}

export function forward(s: NavState): NavState {
  return canForward(s) ? { ...s, index: s.index + 1 } : s;
}

/**
 * What the user typed in the URL bar → a URL to load, or null if it can't be
 * made into one.
 *
 * Accepts the shapes people actually type at a dev server: a bare port (`3000`,
 * `:3000`), a path against whatever is loaded (`/admin`), a host:port
 * (`localhost:5173/docs`), or a full URL. A bare port wins over a bare hostname
 * because in this panel a number is always a port — nobody browses to a host
 * named "3000".
 */
export function normalizeUrl(input: string, base?: string | null): string | null {
  const raw = input.trim();
  if (!raw) return null;

  // Full URL, as typed.
  if (/^https?:\/\//i.test(raw)) return safeUrl(raw);

  // Bare port, with or without the colon.
  const bare = /^:?(\d{2,5})((?:\/|\?|#).*)?$/.exec(raw);
  if (bare) {
    const port = Number(bare[1]);
    if (port >= 1 && port <= 65535) return safeUrl(`http://localhost:${port}${bare[2] ?? ''}`);
  }

  // Path (or query/hash) against the currently loaded origin.
  if (/^[/?#]/.test(raw) && base) {
    const origin = safeOrigin(base);
    if (origin) return safeUrl(origin + raw);
  }

  // host[:port][/path] — assume http, which is what a local dev server is.
  if (/^[a-z0-9.-]+(:\d{2,5})?([/?#].*)?$/i.test(raw)) return safeUrl(`http://${raw}`);

  return null;
}

function safeUrl(candidate: string): string | null {
  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

function safeOrigin(candidate: string): string | null {
  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

/**
 * URL-bar display text: the origin's host:port plus path, without the `http://`
 * noise that is the same on every row. https IS shown — a dev server on TLS is
 * unusual enough that hiding it would be a lie of omission.
 */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    const scheme = u.protocol === 'https:' ? 'https://' : '';
    const tail = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
    return `${scheme}${u.host}${tail}`;
  } catch {
    return url;
  }
}

// Preview-browser port discovery: "what can I point the embedded browser at?"
//
// Why this is NOT just ports.ts. That module answers "which process owns this
// port", which it does by walking every listener's cwd — an lsof-only trick, so
// it returns [] on win32 and always will (netstat reports no cwd, leaving
// nothing to attribute a port to). The embedded browser has to work on Windows,
// so it asks a different, easier question: which URL did THIS SESSION print?
//
// Every dev server announces itself — `Local: http://localhost:3000`, `Local:
// http://localhost:5173/` — and the daemon already keeps that text as PTY
// scrollback (the `history` RPC). Scraping the session's own history needs no
// process introspection, works identically on every platform, and is scoped to
// the session by construction rather than by a cwd-prefix test.
//
// The catch is staleness: an announcement outlives the server that printed it
// (^C does not erase scrollback), so every scraped candidate is TCP-probed
// before it is offered. lsof stays the richer source where it exists — it
// carries pid + command + subdir, which scrollback cannot, and the ports
// panel's kill button needs a pid — so mergePorts() keeps both and lets a
// process-derived entry win on overlap.

import net from 'node:net';
import { stripAnsi } from './needs-input';
import type { PortEntry } from './ports';

/** A localhost URL seen in PTY output. `url` is normalized to an origin. */
export interface ScrapedPort {
  port: number;
  url: string;
}

export interface PreviewPort {
  port: number;
  /** Origin to load, e.g. `http://localhost:3000`. */
  url: string;
  /** `process` = lsof said so (has pid/command/dir); `output` = scraped from PTY text. */
  origin: 'process' | 'output';
  pid?: number;
  command?: string;
  /** Project-relative cwd of the owning process ('' = repo root). lsof only. */
  dir?: string;
}

// Loopback hosts only. A dev server that prints its LAN address ("Network:
// http://192.168.1.5:3000") prints the loopback one on the line above, so there
// is nothing to gain from matching a bare IPv4 — and plenty to lose: a
// "1.2.3.4:80" in a log line would become a browsable "port".
const HOST_ALTERNATION = 'localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1?\\]';
const URL_RE = new RegExp(`\\bhttps?://(?:${HOST_ALTERNATION}):(\\d{2,5})\\b`, 'gi');

/**
 * localhost URLs in `text`, in first-seen order, deduped by port.
 *
 * Scans the RAW text and the ANSI-stripped text, unioning the two. Raw alone
 * misses a URL a TUI positioned with cursor escapes mid-string; stripped alone
 * misses one carried in an OSC-8 hyperlink (stripAnsi drops OSC payloads
 * wholesale). Both passes are cheap — history is a bounded buffer, not a stream.
 */
export function scrapePorts(text: string): ScrapedPort[] {
  const byPort = new Map<number, ScrapedPort>();
  for (const pass of [text, stripAnsi(text)]) {
    URL_RE.lastIndex = 0;
    for (let m = URL_RE.exec(pass); m; m = URL_RE.exec(pass)) {
      const port = Number(m[1]);
      // Port 0 is "pick one for me" and never listens; >65535 is a version
      // string that happened to look like a URL.
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      if (byPort.has(port)) continue;
      const scheme = m[0].slice(0, m[0].indexOf(':')).toLowerCase();
      // 0.0.0.0 / [::] are bind addresses, not browsable ones — say localhost.
      byPort.set(port, { port, url: `${scheme}://localhost:${port}` });
    }
  }
  return [...byPort.values()];
}

/**
 * Is something accepting TCP connections on `port` right now?
 *
 * Tries IPv4 loopback then IPv6: a server bound to `::` refuses 127.0.0.1 on
 * hosts without v4 mapping, and one bound to 127.0.0.1 has no v6 socket at all.
 * Either answer means "browsable", so both are tried before reporting dead.
 */
export function probePort(port: number, timeoutMs = 500): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const sock = new net.Socket();
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(timeoutMs, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      sock.connect(port, host);
    });
  return tryHost('127.0.0.1').then((ok) => (ok ? true : tryHost('::1')));
}

/**
 * Union lsof-derived and output-derived ports, lsof winning on overlap (it
 * knows the pid, command and subdir; a scrape knows only the number).
 * Process entries sort first, then scraped ones in the order given — which the
 * caller has already reversed to most-recently-printed-first.
 */
export function mergePorts(processPorts: PortEntry[], scraped: ScrapedPort[]): PreviewPort[] {
  const out: PreviewPort[] = processPorts.map((p) => ({
    port: p.port,
    url: `http://localhost:${p.port}`,
    origin: 'process' as const,
    pid: p.pid,
    command: p.command,
    dir: p.dir,
  }));
  const seen = new Set(out.map((p) => p.port));
  for (const s of scraped) {
    if (seen.has(s.port)) continue;
    seen.add(s.port);
    out.push({ port: s.port, url: s.url, origin: 'output' });
  }
  return out;
}

/**
 * The browsable ports for one session.
 *
 * `histories` is the scrollback of the session's own PTYs (agent + its scratch
 * shells), newest text last, exactly as the daemon returns it. Scraped
 * candidates are reversed (most recently printed first: after a port collision
 * a dev server reprints on :3001, and that is the one you want) and then
 * probed. Process-derived ports are already proof of a listener, so only the
 * scraped ones pay for a probe; probes run concurrently and are individually
 * short, so a dead candidate costs one timeout, not a serial stall.
 */
export async function discoverPorts(opts: {
  processPorts?: PortEntry[];
  histories?: string[];
  probe?: (port: number) => Promise<boolean>;
}): Promise<PreviewPort[]> {
  const probe = opts.probe ?? ((p: number) => probePort(p));
  const processPorts = opts.processPorts ?? [];
  const known = new Set(processPorts.map((p) => p.port));

  const candidates = new Map<number, ScrapedPort>();
  for (const text of opts.histories ?? []) {
    for (const s of scrapePorts(text)) if (!known.has(s.port)) candidates.set(s.port, s);
  }
  // Reverse of first-seen order across the concatenated histories. That is not
  // strictly "most recent" — Map.set keeps a repeated port at its FIRST
  // position — but it is the right tiebreak for the case that matters: a server
  // that moved from :3000 to :3001 announced :3001 later, so :3001 leads.
  const ordered = [...candidates.values()].reverse();
  const alive = await Promise.all(ordered.map((s) => probe(s.port).catch(() => false)));
  return mergePorts(
    processPorts,
    ordered.filter((_, i) => alive[i]),
  );
}

/**
 * Would this URL refuse to render in an iframe?
 *
 * An `X-Frame-Options: DENY` or a `frame-ancestors` CSP makes the preview a
 * silent blank rectangle, with the reason only in a devtools console the user
 * cannot open — the worst possible failure for a panel whose whole job is
 * showing a page. Checking the headers server-side lets the panel say "this app
 * blocks embedding" and offer the open-in-real-browser button instead.
 *
 * `frame-ancestors` is only approximated: seshmux's own origin varies by port,
 * so anything short of an outright `none` is treated as allowed and left for
 * the browser to enforce. Under-reporting is the right way to be wrong here —
 * a page that would have loaded fine must never be pre-emptively refused.
 */
export function frameBlock(headers: { get(name: string): string | null }): 'xfo' | 'csp' | null {
  const xfo = (headers.get('x-frame-options') ?? '').trim().toLowerCase();
  // Deliberately NOT allow-from: Chrome never implemented it and Firefox removed
  // it, so every current browser ignores that value and renders the frame.
  // Treating it as a block would refuse a page that loads fine — the exact
  // over-reporting this function's contract rules out.
  if (xfo === 'deny' || xfo.startsWith('sameorigin')) return 'xfo';
  const csp = headers.get('content-security-policy') ?? '';
  const m = /frame-ancestors([^;]*)/i.exec(csp);
  if (m && /(^|\s)'none'(\s|$)/i.test(m[1])) return 'csp';
  return null;
}

/**
 * Loopback-only URL guard for the frame check.
 *
 * That endpoint makes the SERVER fetch a client-supplied URL, which is a
 * textbook SSRF primitive — it would happily read a cloud metadata endpoint or
 * an intranet host from inside the user's network. Fail closed: only http(s) to
 * a loopback host, which is the only thing the preview panel can browse anyway.
 */
export function isLoopbackUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

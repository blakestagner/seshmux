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

import { execFile } from 'node:child_process';
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
  /**
   * Where the port came from, best-attributed first:
   *   `process`   — lsof: a listener whose cwd is inside this repo. pid+command+dir.
   *   `output`    — scraped from THIS session's PTY scrollback. Session-attributed.
   *   `listening` — netstat: listening somewhere on this machine, owner unknown.
   *                 Not attributable to a repo (see winListeners), so it sorts last.
   */
  origin: 'process' | 'output' | 'listening';
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

// ── win32: what is listening, machine-wide ──────────────────────────────────
//
// The scrollback scrape only finds servers started INSIDE a seshmux session.
// A dev server started from VSCode, an external terminal, or Docker is
// invisible to it — which is most people's actual workflow. netstat closes that
// gap on Windows: it reports every listener with its pid, just no cwd, so these
// ports cannot be attributed to a repo and are offered as "on this machine".
//
// Deliberately NOT folded into ports.ts: that module's contract is "ports owned
// by a process running inside THIS dir", and netstat cannot answer it. Claiming
// otherwise would make the ports panel silently lie about scope.

/** A listening socket with no repo attribution. */
export interface MachinePort {
  port: number;
  pid: number;
  command: string;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      // windowsHide: without it every one of these flashes a console window on
      // the user's screen — the poll makes that a strobe, not a blip.
      { timeout: 5000, maxBuffer: 8 << 20, windowsHide: true },
      (err, stdout) => resolve(err && !stdout ? '' : stdout),
    );
  });
}

// Windows service hosts listen on a lot of ports and none of them are a dev
// server. Filtering by owner name is far more robust than guessing port ranges
// (a dev server can bind anywhere, including 8080 and 49xxx).
const SYSTEM_IMAGES = new Set([
  'system',
  'system idle process',
  'svchost.exe',
  'services.exe',
  'lsass.exe',
  'wininit.exe',
  'spoolsv.exe',
  'smss.exe',
  'csrss.exe',
  'dllhost.exe',
  'searchindexer.exe',
  'msmpeng.exe',
]);

/**
 * Parse `netstat -ano -p TCP` LISTENING rows.
 *
 * Keeps only addresses a browser on this machine can reach: 0.0.0.0 and [::]
 * are wildcard binds (loopback included — Swing Helix binds 0.0.0.0, so
 * matching 127.0.0.1 alone would have missed it), plus explicit loopback. A
 * listener bound to only a LAN IP is dropped; localhost would not reach it.
 */
export function parseNetstat(out: string): MachinePort[] {
  const byPort = new Map<number, MachinePort>();
  for (const line of out.split('\n')) {
    const m = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const [, local, pidStr] = m;
    const idx = local.lastIndexOf(':');
    if (idx === -1) continue;
    const host = local.slice(0, idx).toLowerCase();
    const port = Number(local.slice(idx + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (host !== '0.0.0.0' && host !== '127.0.0.1' && host !== '[::]' && host !== '[::1]') continue;
    // IPv4 + IPv6 rows of one server collapse to one entry.
    if (!byPort.has(port)) byPort.set(port, { port, pid: Number(pidStr), command: '' });
  }
  return [...byPort.values()];
}

/** Parse `tasklist /FO CSV /NH` into pid → image name. */
export function parseTasklist(out: string): Map<number, string> {
  const byPid = new Map<number, string>();
  for (const line of out.split('\n')) {
    // "image.exe","1234","Console","1","12,345 K" — image names can contain
    // commas, so match the first two quoted fields rather than splitting.
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m) byPid.set(Number(m[2]), m[1]);
  }
  return byPid;
}

// Start of the Windows dynamic/ephemeral range. A port in here was handed out
// at random by the OS, which means nobody typed it and nobody will browse to
// it — it is how Spotify, Plex and an editor's helper processes show up. A dev
// server binds a port you chose, so this cut is safe and removes most noise.
const DYNAMIC_PORT_START = 49152;

// Ports people actually run dev servers on. Used only for ORDER, never to
// exclude: guessing wrong about an unusual port must cost a scroll, not the
// ability to find your app.
function devRank(port: number): number {
  if (port >= 3000 && port < 3100) return 0; // next, rails, express
  if (port === 5173 || (port >= 5170 && port < 5200)) return 1; // vite
  if (port >= 4000 && port < 4100) return 2;
  if (port >= 8000 && port < 8100) return 3; // django, php, http.server
  if (port >= 8080 && port < 8100) return 3;
  if (port >= 5000 && port < 5100) return 4; // flask
  if (port < 10000) return 5;
  return 6;
}

/**
 * Listening ports on this machine (win32 only; [] elsewhere, where lsof already
 * answers a better question). Owner names come from tasklist so the chooser can
 * show `node.exe` next to `:3000`, and so system services can be filtered out.
 *
 * Ordered dev-ports-first rather than numerically: the whole point is that the
 * app you are looking for is at the top without you reading the list.
 */
export async function winListeners(
  runner: (cmd: string, args: string[]) => Promise<string> = run,
): Promise<MachinePort[]> {
  if (process.platform !== 'win32') return [];
  const ports = parseNetstat(await runner('netstat', ['-ano', '-p', 'TCP']));
  if (ports.length === 0) return [];
  const names = parseTasklist(await runner('tasklist', ['/FO', 'CSV', '/NH']));
  return ports
    .filter((p) => p.port < DYNAMIC_PORT_START)
    .map((p) => ({ ...p, command: names.get(p.pid) ?? '' }))
    // An unknown owner is kept: tasklist omits processes owned by another user,
    // and dropping them would hide a dev server running elevated.
    .filter((p) => !SYSTEM_IMAGES.has(p.command.toLowerCase()))
    .sort((a, b) => devRank(a.port) - devRank(b.port) || a.port - b.port);
}

/**
 * Does this port answer HTTP?
 *
 * A machine-wide netstat sweep finds ~34 listeners on a normal dev box — sshd,
 * Postgres, Docker's proxy, the editor's language server. Offering those in a
 * BROWSER chooser is noise. The tempting filter is the owner's image name, but
 * that is guesswork that fails both ways: it would keep every stray node
 * process and drop a perfectly good dev UI (Inngest, Ollama, anything
 * Docker-hosted) for having the wrong parent. Asking the port directly is the
 * only honest test of "can I browse this".
 *
 * Any HTTP response counts, including 401/404/500 — the question is whether a
 * browser gets a page, not whether the page is happy.
 */
export async function speaksHttp(port: number, timeoutMs = 700, doFetch: typeof fetch = fetch): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    await doFetch(`http://127.0.0.1:${port}/`, { signal: ac.signal, redirect: 'manual' });
    return true;
  } catch {
    // A non-HTTP listener (Postgres, SSH) accepts the socket and then either
    // says nothing or speaks its own protocol; both surface here as a failure.
    return false;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

// Cache keyed by port AND pid: a port that changes owner is a different server
// and must be re-tested. Short TTL because the panel polls and a dev server
// that just came up should appear within a few seconds, not a minute.
const httpCache = new Map<string, { ok: boolean; at: number }>();
const HTTP_CACHE_MS = 20_000;

/** Test hook — the cache is module state, so a test must be able to clear it. */
export function _resetHttpCacheForTest(): void {
  httpCache.clear();
}

/**
 * Narrow machine-wide listeners to the ones a browser can actually show.
 *
 * Cached so the panel's poll does not re-probe two dozen ports every few
 * seconds; the whole sweep runs concurrently, so an unresponsive port costs one
 * timeout rather than stalling the rest.
 */
export async function filterHttp(
  ports: MachinePort[],
  probe: (port: number) => Promise<boolean> = (p) => speaksHttp(p),
  now = Date.now(),
): Promise<MachinePort[]> {
  const results = await Promise.all(
    ports.map(async (p) => {
      const key = `${p.port}:${p.pid}`;
      const hit = httpCache.get(key);
      if (hit && now - hit.at < HTTP_CACHE_MS) return hit.ok;
      const ok = await probe(p.port).catch(() => false);
      httpCache.set(key, { ok, at: now });
      return ok;
    }),
  );
  return ports.filter((_, i) => results[i]);
}

/**
 * Union lsof-derived and output-derived ports, lsof winning on overlap (it
 * knows the pid, command and subdir; a scrape knows only the number).
 * Process entries sort first, then scraped ones in the order given — which the
 * caller has already reversed to most-recently-printed-first.
 */
export function mergePorts(
  processPorts: PortEntry[],
  scraped: ScrapedPort[],
  machine: MachinePort[] = [],
): PreviewPort[] {
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
  // Last: everything else listening on this box. Least attributed, so it must
  // never outrank a port this session actually printed — but it is the only
  // thing that finds a server started from VSCode or an external terminal.
  for (const m of machine) {
    if (seen.has(m.port)) continue;
    seen.add(m.port);
    out.push({
      port: m.port,
      url: `http://localhost:${m.port}`,
      origin: 'listening',
      pid: m.pid,
      command: m.command || undefined,
    });
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
  /** win32 netstat listeners. Already proof of a listener, so never probed. */
  machinePorts?: MachinePort[];
  probe?: (port: number) => Promise<boolean>;
}): Promise<PreviewPort[]> {
  const probe = opts.probe ?? ((p: number) => probePort(p));
  const processPorts = opts.processPorts ?? [];
  const machine = opts.machinePorts ?? [];
  const lsofPorts = new Set(processPorts.map((p) => p.port));
  const listening = new Set(machine.map((m) => m.port));

  const candidates = new Map<number, ScrapedPort>();
  for (const text of opts.histories ?? []) {
    for (const s of scrapePorts(text)) if (!lsofPorts.has(s.port)) candidates.set(s.port, s);
  }
  // Reverse of first-seen order across the concatenated histories. That is not
  // strictly "most recent" — Map.set keeps a repeated port at its FIRST
  // position — but it is the right tiebreak for the case that matters: a server
  // that moved from :3000 to :3001 announced :3001 later, so :3001 leads.
  const ordered = [...candidates.values()].reverse();
  // A scraped port netstat also reports is already proven live, so skip the
  // probe — on Windows that is the common case, and probing every poll would be
  // pure waste. It stays an `output` port either way: netstat confirming it must
  // not demote a port THIS SESSION printed to an unattributed machine port.
  const alive = await Promise.all(
    ordered.map((s) => (listening.has(s.port) ? Promise.resolve(true) : probe(s.port).catch(() => false))),
  );
  return mergePorts(
    processPorts,
    ordered.filter((_, i) => alive[i]),
    machine,
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

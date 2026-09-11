// Framing proxy: lets the preview panel show an app that refuses to be framed.
//
// X-Frame-Options / CSP frame-ancestors are enforced by the BROWSER against the
// response it received. Nothing outside the page can override them — not an
// iframe attribute, not a sandbox flag. The only way to render such an app is
// for the bytes to arrive without those headers, which means seshmux has to be
// the one serving them. Hence a proxy.
//
// WHY A WHOLE LISTENER PER TARGET, rather than a path under the main server.
// A path-mounted proxy (/api/preview/proxy/3000/…) breaks on the first
// root-relative URL the app emits: `/_next/chunk.js` resolves against the
// ORIGIN, not the mount point, so every asset 404s. Fixing that means
// rewriting URLs in HTML, CSS and JS — endless and fragile. A dedicated port
// gives the app a real origin of its own, so root-relative paths, cookies,
// fetch() and client-side routing all behave exactly as they do when you visit
// it directly. The cost is one extra loopback listener per previewed port.
//
// SCOPE OF TRUST: binds 127.0.0.1 only, and forwards ONLY to a loopback port on
// this machine. It is not an open relay — the target is fixed when the proxy is
// created, and a request cannot redirect it elsewhere.

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface ProxyHandle {
  /** Port on 127.0.0.1 serving the proxied app. */
  proxyPort: number;
  /** The app being proxied. */
  targetPort: number;
}

interface Entry extends ProxyHandle {
  server: http.Server;
  lastUsed: number;
}

const proxies = new Map<number, Entry>();

// A preview panel is one app at a time; a handful covers switching between
// them. The cap exists so a pathological caller cannot open listeners forever.
const MAX_PROXIES = 8;

// Headers that make a browser refuse to frame the response. Stripped on the way
// back — this is the entire point of the proxy.
const FRAME_HEADERS = ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only'];

/**
 * Remove only the framing directive from a CSP, leaving the rest of the policy
 * intact. Dropping the whole header would silently disable the app's XSS
 * protections in the preview, which is a bigger change than asked for.
 */
export function stripFrameAncestors(csp: string): string {
  const kept = csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !/^frame-ancestors\b/i.test(d));
  return kept.join('; ');
}

/** Copy response headers, defusing the ones that block framing. */
export function proxyHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined) continue;
    if (!FRAME_HEADERS.includes(lower)) {
      out[name] = value;
      continue;
    }
    if (lower === 'x-frame-options') continue; // no salvageable part
    const csp = stripFrameAncestors(Array.isArray(value) ? value.join('; ') : String(value));
    if (csp) out[name] = csp;
  }
  return out;
}

function createProxy(targetPort: number): Promise<Entry> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const entry = proxies.get(targetPort);
      if (entry) entry.lastUsed = Date.now();
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: targetPort,
          method: req.method,
          path: req.url,
          // Host is rewritten so the app builds correct absolute URLs and any
          // host-based routing (Next's dev overlay, virtual hosts) still matches.
          headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, proxyHeaders(up.headers));
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        // The app died or never answered. A plain 502 is enough — the panel's
        // own reachability check is what explains it to the user.
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('preview target not reachable');
      });
      // The iframe is remounted on every URL change, reload and port switch, so
      // responses are abandoned routinely. Without this the upstream request
      // lives on: for an asset that wastes a socket, but for a long-lived
      // response — Next's HMR stream, which is the thing this proxy exists to
      // carry — it never ends, leaking one connection to the dev server per
      // reload for the life of the proxy.
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    });

    // HMR is a websocket. Without this the page renders but never hot-reloads,
    // and Next's dev client logs connection failures forever — which looks like
    // the preview is broken even though the app is fine. Raw socket piping is
    // enough: neither side needs us to understand the frames.
    server.on('upgrade', (req, socket, head) => {
      const upstream = http.request({
        host: '127.0.0.1',
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
      });
      upstream.on('upgrade', (upRes, upSocket, upHead) => {
        const lines = Object.entries(upRes.headers).flatMap(([k, v]) =>
          Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${String(v)}`],
        );
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
        // unshift() pushes a chunk back onto a stream's OWN READABLE side, from
        // where it flows out through that stream's pipe. So each leftover goes
        // back on the socket it was READ from, not the one it is headed for:
        //   upHead was read from upstream -> upSocket -> (pipe) -> client
        //   head   was read from the client -> socket -> (pipe) -> upstream
        // Swapping these echoes each side's first bytes back at its sender. It
        // bites exactly when a server ships the first frame in the same packet
        // as the 101 — which Next's HMR does — so the socket corrupts and the
        // client reconnect-loops: the failure this handler exists to prevent.
        if (upHead?.length) upSocket.unshift(upHead);
        if (head?.length) socket.unshift(head);
        upSocket.pipe(socket).pipe(upSocket);
        // Tear the PAIR down whenever either half ends, for any reason. Binding
        // only 'error' leaked the upstream socket on every clean close — and a
        // websocket closing cleanly is the normal case, not the exception, so
        // each HMR reconnect abandoned one live connection to the dev server.
        const closePair = () => {
          socket.destroy();
          upSocket.destroy();
        };
        upSocket.on('error', closePair);
        socket.on('error', closePair);
        upSocket.on('close', closePair);
        socket.on('close', closePair);
      });
      upstream.on('error', () => socket.destroy());
      upstream.end();
    });

    server.on('error', reject);
    // Port 0 = let the OS pick, 127.0.0.1 = never reachable off this machine.
    server.listen(0, '127.0.0.1', () => {
      const proxyPort = (server.address() as AddressInfo).port;
      resolve({ server, proxyPort, targetPort, lastUsed: Date.now() });
    });
  });
}

/**
 * The proxy for `targetPort`, starting one if needed. Idempotent: the panel
 * calls this on every load of a blocked app, and must get the same port back so
 * the iframe is not needlessly torn down.
 */
export async function ensureProxy(targetPort: number): Promise<ProxyHandle> {
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error('invalid target port');
  }
  const existing = proxies.get(targetPort);
  if (existing) {
    existing.lastUsed = Date.now();
    return { proxyPort: existing.proxyPort, targetPort };
  }
  if (proxies.size >= MAX_PROXIES) {
    // Evict the least recently used rather than refusing — the caller wants a
    // preview, and an old proxy nobody is looking at is the cheapest thing to lose.
    const oldest = [...proxies.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (oldest) stopProxy(oldest.targetPort);
  }
  const entry = await createProxy(targetPort);
  proxies.set(targetPort, entry);
  return { proxyPort: entry.proxyPort, targetPort };
}

export function stopProxy(targetPort: number): void {
  const entry = proxies.get(targetPort);
  if (!entry) return;
  proxies.delete(targetPort);
  entry.server.close();
  entry.server.closeAllConnections?.();
}

/** Shutdown hook + test cleanup: a listener left behind would keep the process alive. */
export function stopAllProxies(): void {
  for (const targetPort of [...proxies.keys()]) stopProxy(targetPort);
}

/** Test visibility only. */
export function _activeProxyCount(): number {
  return proxies.size;
}

/** Probe helper for tests: does a socket connect on this port? */
export function proxyIsListening(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.connect(port, '127.0.0.1');
  });
}

// Local security boundary. This app spawns shells, so localhost binding alone is NOT a
// boundary (DNS-rebinding + cross-site POST can reach 127.0.0.1). Two mandatory layers:
//   1. Origin/Referer check on every mutating request (non-GET) and every WS upgrade.
//   2. Per-process random token: `x-seshmux-token` header on /api/* requests,
//      `?token=` query param on WS upgrades.
// Both are enforced by a single Fastify onRequest hook (server/index.ts) via requireAuth.

import { timingSafeEqual } from 'node:crypto';

export class AuthError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

export interface AuthCtx {
  token: string;
  port: number;
  isWebSocket?: boolean;
  // The configured bind host (see bin/lib/host.js). When it names a specific
  // non-loopback IP (opt-in LAN bind), that exact address is added to the Host
  // and Origin allowlists so a browser on another device can reach us. Loopback
  // is ALWAYS allowed regardless, so the default (loopback) bind never widens
  // the boundary. Undefined ⇒ loopback-only, unchanged from the original model.
  host?: string;
}

interface ReqLike {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  url?: string;
}

function header(headers: ReqLike['headers'], name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);

// A configured bind host only widens the allowlist when it's a specific
// non-loopback address; a loopback bind is already covered and must not be
// double-counted (keeps the default boundary exactly as it was).
function extraHost(host: string | undefined): string | undefined {
  return host !== undefined && !LOOPBACK_NAMES.has(host) ? host : undefined;
}

// Host as it appears inside a URL: IPv6 literals must be bracketed. (net.isIP is
// avoided here to keep this module free of node imports for the browser build;
// a bare ':' unambiguously marks an IPv6 literal in this position.)
function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

// Accept a Host header naming our own loopback interface (any port) OR the
// specific IP we were told to bind (`allowedHost`, opt-in LAN bind). Defeats
// DNS-rebinding: a rebound page resolves attacker.com -> our IP but the browser
// still sends `Host: attacker.com`, which is on neither list and fails here.
// Applied to ALL guarded requests (GET included) — the read-only exfil vector.
export function checkHost(host: string | undefined, allowedHost?: string): boolean {
  if (!host) return false;
  // Strip the port. IPv6 literals are bracketed: [::1]:port.
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  if (LOOPBACK_NAMES.has(hostname)) return true;
  return hostname === extraHost(allowedHost);
}

// Accept http origins pointing at our own loopback host:port OR the configured
// non-loopback bind IP:port (opt-in LAN bind).
export function checkOrigin(
  headers: { origin?: string; referer?: string },
  port: number,
  allowedHost?: string,
): boolean {
  const source = headers.origin ?? headers.referer;
  if (!source) return false;
  const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const extra = extraHost(allowedHost);
  if (extra) allowed.push(`http://${hostForUrl(extra)}:${port}`);
  // origin is an exact host:port; referer carries a path — compare by prefix.
  return allowed.some((a) => source === a || source.startsWith(a + '/'));
}

// Constant-time token comparison; false on any length/format mismatch.
export function checkToken(provided: string | undefined, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Throws AuthError (403 origin / 401 token) or returns void. Applied to every /api/*
// request and WS upgrade. Order: Origin first (cheap, blocks cross-site), then token.
export function requireAuth(req: ReqLike, ctx: AuthCtx): void {
  const isMutating = req.method !== 'GET' && req.method !== 'HEAD';

  // Layer 0 — Host allowlist on every guarded request (GET included). Blocks
  // DNS-rebinding read-only exfiltration that the Origin check (mutating/WS only)
  // and localhost binding alone don't cover.
  if (!checkHost(header(req.headers, 'host'), ctx.host)) {
    throw new AuthError(403, 'host not allowed');
  }

  // Layer 1 — Origin/Referer for mutating requests and WS upgrades.
  if (isMutating || ctx.isWebSocket) {
    const origin = header(req.headers, 'origin');
    const referer = header(req.headers, 'referer');
    if (!checkOrigin({ origin, referer }, ctx.port, ctx.host)) {
      throw new AuthError(403, 'origin not allowed');
    }
  }

  // Layer 2 — per-process token. Header on /api/*, query param on WS upgrades.
  const provided = ctx.isWebSocket
    ? (typeof req.query?.token === 'string' ? (req.query.token as string) : undefined)
    : header(req.headers, 'x-seshmux-token');

  if (!checkToken(provided, ctx.token)) {
    throw new AuthError(401, 'invalid or missing token');
  }
}

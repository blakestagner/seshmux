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

// Accept only a Host header naming our own loopback interface (any port). Defeats
// DNS-rebinding: a rebound page resolves attacker.com -> 127.0.0.1 but the browser
// still sends `Host: attacker.com`, which fails here. Applied to ALL guarded
// requests (GET included) since that's the read-only exfiltration vector.
export function checkHost(host: string | undefined): boolean {
  if (!host) return false;
  // Strip the port. IPv6 literals are bracketed: [::1]:port.
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

// Accept only http origins pointing at our own loopback host:port.
export function checkOrigin(
  headers: { origin?: string; referer?: string },
  port: number,
): boolean {
  const source = headers.origin ?? headers.referer;
  if (!source) return false;
  const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
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
  if (!checkHost(header(req.headers, 'host'))) {
    throw new AuthError(403, 'host not allowed');
  }

  // Layer 1 — Origin/Referer for mutating requests and WS upgrades.
  if (isMutating || ctx.isWebSocket) {
    const origin = header(req.headers, 'origin');
    const referer = header(req.headers, 'referer');
    if (!checkOrigin({ origin, referer }, ctx.port)) {
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

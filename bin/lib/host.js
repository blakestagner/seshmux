'use strict';
// Shared bind-host parsing + validation. Pure (only node:net), zero deps, plain
// CommonJS so bin/seshmux.js can `require` it raw in prod (no build step) AND
// server/index.ts can import it (tsx in dev; esbuild bundles it into the
// standalone at scripts/entry-server.ts). Single source of truth for "what is a
// legal bind address" — the CLI guardrail and the server both go through here.
//
// SECURITY MODEL (see server/lib/auth.ts): seshmux spawns real shells, so the
// address it binds to is a security boundary, not a convenience. Default is
// loopback. A non-loopback bind is an explicit opt-in and is restricted to a
// SPECIFIC IP literal:
//   • never an all-interfaces wildcard (0.0.0.0 / ::) — that would expose the
//     shells on every network the box is attached to at once;
//   • never a DNS hostname — the Host-header allowlist (checkHost) must compare
//     against the exact address the browser sends, and a name is ambiguous.
// Once bound to a LAN IP, the per-process token is the ONLY wall between anyone
// who can reach that address and a shell. Callers should say so out loud.
const net = require('node:net');

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const WILDCARD = new Set(['0.0.0.0', '::', '::0']);

function isLoopback(host) {
  return LOOPBACK.has(String(host));
}

function portOrThrow(p, raw) {
  const n = Number(p);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`invalid port in "${raw}": ${p}`);
  }
  return n;
}

// Split a `host`, `host:port`, or `[ipv6]:port` token into { host, port }.
// port is null when the token carries no port. A bare (unbracketed) IPv6 literal
// is taken as the whole host with no port — attach a port only via [addr]:port.
function parseHostPort(raw) {
  if (raw == null) throw new Error('missing host value');
  const s = String(raw).trim();
  if (!s) throw new Error('empty host value');
  // [ipv6] or [ipv6]:port
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end === -1) throw new Error(`malformed IPv6 host (missing ']'): ${raw}`);
    const host = s.slice(1, end);
    const rest = s.slice(end + 1);
    if (!rest) return { host, port: null };
    if (!rest.startsWith(':')) throw new Error(`malformed host:port: ${raw}`);
    return { host, port: portOrThrow(rest.slice(1), raw) };
  }
  // Bare IPv6 literal (unbracketed) → the whole token is the host, no port.
  if (net.isIP(s) === 6) return { host: s, port: null };
  const i = s.indexOf(':');
  if (i === -1) return { host: s, port: null };
  // A second colon on an unbracketed token is an IPv6-with-port ambiguity.
  if (s.indexOf(':', i + 1) !== -1) {
    throw new Error(`ambiguous host — bracket IPv6 as [addr]:port: ${raw}`);
  }
  return { host: s.slice(0, i), port: portOrThrow(s.slice(i + 1), raw) };
}

// Validate a bind host against the security model. Returns the canonical host
// string to bind + allowlist, or throws Error with a user-facing message.
function validateBindHost(host) {
  const h = String(host).trim();
  if (!h) throw new Error('empty bind host');
  if (LOOPBACK.has(h)) return h; // loopback names/literals pass through unchanged
  if (WILDCARD.has(h)) {
    throw new Error(
      `refusing to bind all interfaces (${h}): seshmux spawns shells. ` +
        `Bind one specific IP instead, e.g. --host 10.0.26.5`,
    );
  }
  if (net.isIP(h) === 0) {
    throw new Error(
      `--host must be an IP address (e.g. 10.0.26.5), not "${h}". ` +
        `Hostnames aren't accepted — the bound address must match the browser's Host header exactly.`,
    );
  }
  return h;
}

// Host as it should appear inside an http(s) URL: IPv6 literals must be bracketed.
function displayHost(host) {
  const h = String(host);
  return net.isIP(h) === 6 ? `[${h}]` : h;
}

module.exports = { isLoopback, parseHostPort, validateBindHost, displayHost };

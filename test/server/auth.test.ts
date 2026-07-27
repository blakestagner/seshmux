import { describe, it, expect } from 'vitest';
import { checkHost, checkOrigin, checkToken, requireAuth, AuthError } from '../../server/lib/auth';

const PORT = 4700;
const TOKEN = 'deadbeef'.repeat(8); // 64 hex chars

function reqLike(opts: {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  url?: string;
}) {
  // Default to a loopback Host so the new Layer-0 allowlist passes unless a test
  // deliberately overrides it.
  return {
    method: opts.method ?? 'GET',
    headers: { host: `127.0.0.1:${PORT}`, ...(opts.headers ?? {}) },
    query: opts.query ?? {},
    url: opts.url ?? '/api/projects',
  };
}

describe('checkHost', () => {
  it('accepts loopback hostnames on any port', () => {
    expect(checkHost('127.0.0.1:4700')).toBe(true);
    expect(checkHost('localhost:9999')).toBe(true);
    expect(checkHost('127.0.0.1')).toBe(true);
    expect(checkHost('[::1]:4700')).toBe(true);
  });
  it('rejects a rebound / foreign Host', () => {
    expect(checkHost('evil.example.com')).toBe(false);
    expect(checkHost('evil.example.com:4700')).toBe(false);
    expect(checkHost('169.254.169.254')).toBe(false);
    expect(checkHost(undefined)).toBe(false);
  });
  it('allows the configured non-loopback bind IP (opt-in LAN), loopback still ok', () => {
    expect(checkHost('10.0.26.5:4700', '10.0.26.5')).toBe(true);
    expect(checkHost('127.0.0.1:4700', '10.0.26.5')).toBe(true); // loopback always allowed
    expect(checkHost('[fd00::5]:4700', 'fd00::5')).toBe(true);
  });
  it('still rejects a foreign Host even with a LAN bind configured', () => {
    expect(checkHost('evil.example.com', '10.0.26.5')).toBe(false);
    expect(checkHost('10.0.26.6:4700', '10.0.26.5')).toBe(false); // different IP
  });
});

describe('checkOrigin', () => {
  it('accepts matching 127.0.0.1 and localhost origins', () => {
    expect(checkOrigin({ origin: `http://127.0.0.1:${PORT}` }, PORT)).toBe(true);
    expect(checkOrigin({ origin: `http://localhost:${PORT}` }, PORT)).toBe(true);
  });
  it('accepts a matching referer when origin absent', () => {
    expect(checkOrigin({ referer: `http://127.0.0.1:${PORT}/app` }, PORT)).toBe(true);
  });
  it('rejects a foreign origin', () => {
    expect(checkOrigin({ origin: 'http://evil.example.com' }, PORT)).toBe(false);
    expect(checkOrigin({ origin: `http://127.0.0.1:9999` }, PORT)).toBe(false);
  });
  it('rejects when neither origin nor referer present', () => {
    expect(checkOrigin({}, PORT)).toBe(false);
  });
  it('accepts the configured non-loopback origin (opt-in LAN)', () => {
    expect(checkOrigin({ origin: `http://10.0.26.5:${PORT}` }, PORT, '10.0.26.5')).toBe(true);
    expect(checkOrigin({ referer: `http://10.0.26.5:${PORT}/app` }, PORT, '10.0.26.5')).toBe(true);
    // IPv6 bind → bracketed origin.
    expect(checkOrigin({ origin: `http://[fd00::5]:${PORT}` }, PORT, 'fd00::5')).toBe(true);
    // Loopback origin still fine alongside a LAN bind.
    expect(checkOrigin({ origin: `http://127.0.0.1:${PORT}` }, PORT, '10.0.26.5')).toBe(true);
  });
  it('rejects a foreign origin even with a LAN bind, and the LAN IP on a wrong port', () => {
    expect(checkOrigin({ origin: 'http://evil.example.com' }, PORT, '10.0.26.5')).toBe(false);
    expect(checkOrigin({ origin: `http://10.0.26.5:9999` }, PORT, '10.0.26.5')).toBe(false);
  });
});

describe('checkToken', () => {
  it('accepts the exact token', () => {
    expect(checkToken(TOKEN, TOKEN)).toBe(true);
  });
  it('rejects a wrong or missing token', () => {
    expect(checkToken('nope', TOKEN)).toBe(false);
    expect(checkToken(undefined, TOKEN)).toBe(false);
    expect(checkToken('', TOKEN)).toBe(false);
  });
});

describe('requireAuth (non-GET / mutating)', () => {
  const ctx = { token: TOKEN, port: PORT };

  it('POST without Origin -> 403', () => {
    const err = grab(() =>
      requireAuth(reqLike({ method: 'POST', headers: { 'x-seshmux-token': TOKEN } }), ctx),
    );
    expect(err).toBeInstanceOf(AuthError);
    expect(err.statusCode).toBe(403);
  });

  it('POST with evil Origin -> 403', () => {
    const err = grab(() =>
      requireAuth(
        reqLike({
          method: 'POST',
          headers: { origin: 'http://evil.example.com', 'x-seshmux-token': TOKEN },
        }),
        ctx,
      ),
    );
    expect(err.statusCode).toBe(403);
  });

  it('valid Origin + bad token -> 401', () => {
    const err = grab(() =>
      requireAuth(
        reqLike({
          method: 'POST',
          headers: { origin: `http://127.0.0.1:${PORT}`, 'x-seshmux-token': 'wrong' },
        }),
        ctx,
      ),
    );
    expect(err.statusCode).toBe(401);
  });

  it('valid Origin + valid token -> passes', () => {
    expect(() =>
      requireAuth(
        reqLike({
          method: 'POST',
          headers: { origin: `http://127.0.0.1:${PORT}`, 'x-seshmux-token': TOKEN },
        }),
        ctx,
      ),
    ).not.toThrow();
  });
});

describe('requireAuth (GET /api/* still needs token)', () => {
  const ctx = { token: TOKEN, port: PORT };
  it('GET without token -> 401', () => {
    const err = grab(() => requireAuth(reqLike({ method: 'GET', headers: {} }), ctx));
    expect(err.statusCode).toBe(401);
  });
  it('GET with token -> passes (no origin required for GET)', () => {
    expect(() =>
      requireAuth(reqLike({ method: 'GET', headers: { 'x-seshmux-token': TOKEN } }), ctx),
    ).not.toThrow();
  });
  it('GET with valid token but rebound Host -> 403 (DNS-rebinding block)', () => {
    const err = grab(() =>
      requireAuth(
        reqLike({ method: 'GET', headers: { host: 'evil.example.com', 'x-seshmux-token': TOKEN } }),
        ctx,
      ),
    );
    expect(err.statusCode).toBe(403);
  });
});

describe('requireAuth (WS upgrade)', () => {
  const ctx = { token: TOKEN, port: PORT, isWebSocket: true };
  it('WS upgrade without token (query) -> rejected', () => {
    const err = grab(() =>
      requireAuth(reqLike({ headers: { origin: `http://127.0.0.1:${PORT}` }, query: {} }), ctx),
    );
    expect(err.statusCode).toBe(401);
  });
  it('WS upgrade with token in query + good origin -> passes', () => {
    expect(() =>
      requireAuth(
        reqLike({ headers: { origin: `http://127.0.0.1:${PORT}` }, query: { token: TOKEN } }),
        ctx,
      ),
    ).not.toThrow();
  });
  it('WS upgrade with token but foreign origin -> 403', () => {
    const err = grab(() =>
      requireAuth(
        reqLike({ headers: { origin: 'http://evil.example.com' }, query: { token: TOKEN } }),
        ctx,
      ),
    );
    expect(err.statusCode).toBe(403);
  });
});

describe('requireAuth (opt-in LAN bind)', () => {
  const ctx = { token: TOKEN, port: PORT, host: '10.0.26.5' };
  const lan = { host: `10.0.26.5:${PORT}`, origin: `http://10.0.26.5:${PORT}` };

  it('POST from the LAN IP with token -> passes', () => {
    expect(() =>
      requireAuth(
        reqLike({ method: 'POST', headers: { ...lan, 'x-seshmux-token': TOKEN } }),
        ctx,
      ),
    ).not.toThrow();
  });
  it('WS from the LAN IP with token -> passes', () => {
    expect(() =>
      requireAuth(
        reqLike({ headers: { ...lan }, query: { token: TOKEN } }),
        { ...ctx, isWebSocket: true },
      ),
    ).not.toThrow();
  });
  it('foreign Host with valid token still -> 403 (rebinding block holds)', () => {
    const err = grab(() =>
      requireAuth(
        reqLike({ headers: { host: 'evil.example.com', 'x-seshmux-token': TOKEN } }),
        ctx,
      ),
    );
    expect(err.statusCode).toBe(403);
  });
});

// Helper: run fn, return the thrown AuthError (fails if nothing thrown).
function grab(fn: () => void): AuthError {
  try {
    fn();
  } catch (e) {
    return e as AuthError;
  }
  throw new Error('expected requireAuth to throw');
}

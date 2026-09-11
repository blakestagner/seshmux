// The framing proxy — the only way to render an app that sends
// X-Frame-Options, since that header is enforced by the browser against bytes
// seshmux did not serve. Tests run against a REAL origin server on loopback so
// the header rewriting and the socket plumbing are actually exercised.
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  _activeProxyCount,
  ensureProxy,
  proxyHeaders,
  stopAllProxies,
  stripFrameAncestors,
} from '../../server/lib/preview-proxy';

afterEach(() => stopAllProxies());

/** A throwaway origin server that echoes whatever headers the test wants. */
async function origin(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: (srv.address() as AddressInfo).port,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

describe('stripFrameAncestors', () => {
  // Dropping the whole CSP would silently disable the app's XSS protections in
  // the preview — a bigger change than "let me see it in a frame".
  it('removes only the framing directive, keeping the rest of the policy', () => {
    expect(stripFrameAncestors("default-src 'self'; frame-ancestors 'none'; img-src *")).toBe(
      "default-src 'self'; img-src *",
    );
  });

  it('leaves a policy with no frame-ancestors untouched', () => {
    expect(stripFrameAncestors("default-src 'self'")).toBe("default-src 'self'");
  });

  it('collapses to empty when framing was the only directive', () => {
    expect(stripFrameAncestors("frame-ancestors 'none'")).toBe('');
  });
});

describe('proxyHeaders', () => {
  it('drops X-Frame-Options entirely — no part of it is salvageable', () => {
    const out = proxyHeaders({ 'x-frame-options': 'DENY', 'content-type': 'text/html' });
    expect(out['x-frame-options']).toBeUndefined();
    expect(out['content-type']).toBe('text/html');
  });

  it('keeps a CSP that had other directives, and omits one left empty', () => {
    expect(proxyHeaders({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" })).toEqual({
      'content-security-policy': "default-src 'self'",
    });
    expect(proxyHeaders({ 'content-security-policy': "frame-ancestors 'none'" })).toEqual({});
  });

  it('also defuses the report-only variant', () => {
    const out = proxyHeaders({ 'content-security-policy-report-only': "frame-ancestors 'none'" });
    expect(out['content-security-policy-report-only']).toBeUndefined();
  });
});

describe('ensureProxy', () => {
  it('serves the app without the header that blocked it', async () => {
    const app = await origin((_req, res) => {
      res.writeHead(200, { 'x-frame-options': 'DENY', 'content-type': 'text/html' });
      res.end('<h1>swing</h1>');
    });
    try {
      const { proxyPort } = await ensureProxy(app.port);
      const res = await fetch(`http://127.0.0.1:${proxyPort}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-frame-options')).toBe(null); // the whole point
      expect(await res.text()).toBe('<h1>swing</h1>');
    } finally {
      await app.close();
    }
  });

  it('passes through method, path, query and body unchanged', async () => {
    const seen: { method?: string; url?: string; body: string }[] = [];
    const app = await origin((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body });
        res.writeHead(204);
        res.end();
      });
    });
    try {
      const { proxyPort } = await ensureProxy(app.port);
      await fetch(`http://127.0.0.1:${proxyPort}/api/thing?q=1`, { method: 'POST', body: 'payload' });
      expect(seen).toEqual([{ method: 'POST', url: '/api/thing?q=1', body: 'payload' }]);
    } finally {
      await app.close();
    }
  });

  it('is idempotent per target, so re-loading does not tear the iframe down', async () => {
    const app = await origin((_req, res) => res.end('ok'));
    try {
      const a = await ensureProxy(app.port);
      const b = await ensureProxy(app.port);
      expect(b.proxyPort).toBe(a.proxyPort);
      expect(_activeProxyCount()).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('answers 502 rather than hanging when the app is not there', async () => {
    // Nothing is listening on this port — the proxy must still be a good HTTP
    // citizen so the iframe shows an error instead of spinning forever.
    const { proxyPort } = await ensureProxy(59999);
    const res = await fetch(`http://127.0.0.1:${proxyPort}/`);
    expect(res.status).toBe(502);
  });

  it('refuses a port that is not a port', async () => {
    await expect(ensureProxy(0)).rejects.toThrow(/invalid target port/);
    await expect(ensureProxy(70000)).rejects.toThrow(/invalid target port/);
  });

  it('evicts the oldest rather than leaking listeners without bound', async () => {
    // 9 targets against a cap of 8.
    for (let i = 0; i < 9; i++) await ensureProxy(50000 + i);
    expect(_activeProxyCount()).toBeLessThanOrEqual(8);
  });

  it('stopAllProxies closes every listener, so the process can exit', async () => {
    await ensureProxy(51000);
    await ensureProxy(51001);
    expect(_activeProxyCount()).toBe(2);
    stopAllProxies();
    expect(_activeProxyCount()).toBe(0);
  });
});

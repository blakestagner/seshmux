// The framing proxy — the only way to render an app that sends
// X-Frame-Options, since that header is enforced by the browser against bytes
// seshmux did not serve. Tests run against a REAL origin server on loopback so
// the header rewriting and the socket plumbing are actually exercised.
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
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
    // stopAllProxies FIRST: the proxy keeps a live socket to this fixture, and
    // server.close() waits for every connection to end — so closing in the
    // other order hangs until the test times out, which is not a failure of the
    // code under test but looks exactly like one.
    close: () =>
      new Promise<void>((r) => {
        stopAllProxies();
        srv.closeAllConnections?.();
        srv.close(() => r());
      }),
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

  // The upgrade path had no coverage, and the bug it hid was a swapped pair of
  // unshift() calls that echoed each side's first bytes back at its own sender.
  // It only bites when a server ships data in the SAME packet as the 101 —
  // which Next's HMR does — so the fixture must do that too or it proves nothing.
  it('carries a websocket upgrade, including data sent with the 101', async () => {
    const srv = http.createServer();
    // Held so teardown can destroy it explicitly: once a socket is upgraded the
    // http server hands ownership away, so neither close() nor
    // closeAllConnections() reliably reaps it and close() waits forever.
    // A list, not a `let`: TS narrows a callback-assigned variable back to its
    // initializer at the use site, so `originSocket?.destroy()` typed as never.
    const originSockets: net.Socket[] = [];
    srv.on('upgrade', (_req, socket, _head) => {
      originSockets.push(socket as net.Socket);
      // 101 and the first frame in one write: the case that broke.
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nHELLO');
      socket.on('data', (d) => socket.write(`echo:${d.toString()}`));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const targetPort = (srv.address() as AddressInfo).port;

    try {
      const { proxyPort } = await ensureProxy(targetPort);
      const received = await new Promise<string>((resolve, reject) => {
        const sock = new net.Socket();
        let buf = '';
        sock.setTimeout(3000, () => reject(new Error('timed out')));
        sock.on('error', reject);
        sock.connect(proxyPort, '127.0.0.1', () => {
          sock.write(
            `GET /_next/webpack-hmr HTTP/1.1\r\nHost:127.0.0.1:${proxyPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
          );
        });
        sock.on('data', (d: Buffer) => {
          buf += d.toString();
          // The 101 plus the frame that rode along with it, then a round trip.
          if (buf.includes('HELLO')) sock.write('PING');
          if (buf.includes('echo:PING')) {
            sock.destroy();
            resolve(buf);
          }
        });
      });
      expect(received).toContain('101 Switching Protocols');
      expect(received).toContain('HELLO'); // would be echoed to the SERVER if unshift were swapped
      expect(received).toContain('echo:PING'); // and the tunnel still works both ways
    } finally {
      stopAllProxies(); // see the note in origin(): close() waits on the proxy's socket
      for (const s of originSockets) s.destroy();
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('aborts the upstream request when the client hangs up', async () => {
    let aborted = false;
    const app = await origin((req, res) => {
      // A long-lived response, like an HMR stream: it never ends on its own, so
      // only an abort can clean it up.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': open\n\n');
      req.on('aborted', () => (aborted = true));
      res.on('close', () => (aborted = true));
    });
    try {
      const { proxyPort } = await ensureProxy(app.port);
      const ac = new AbortController();
      await fetch(`http://127.0.0.1:${proxyPort}/stream`, { signal: ac.signal }).catch(() => {});
      ac.abort();
      await new Promise((r) => setTimeout(r, 150));
      expect(aborted).toBe(true);
    } finally {
      await app.close();
    }
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

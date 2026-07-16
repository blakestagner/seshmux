// listenWithStaleRecovery — the fix for "kill -9'd server leaves approval.sock/
// wait.sock behind and the next boot silently degrades MCP approval + wait".
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, connect, type Server } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listenWithStaleRecovery } from '../../server/lib/bridge/socket-listen';

// Short base dir — macOS unix-socket paths cap ~104 bytes.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smx-sl-'));
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null)));
});

function sock(name: string) {
  return path.join(dir, name);
}

describe('listenWithStaleRecovery', () => {
  it('binds a fresh path normally', async () => {
    const s = createServer();
    servers.push(s);
    await listenWithStaleRecovery(s, sock('fresh.sock'));
    expect(fs.existsSync(sock('fresh.sock'))).toBe(true);
  });

  it('locks the socket to 0600 (SEC-2)', async () => {
    if (process.platform === 'win32') return;
    const s = createServer();
    servers.push(s);
    await listenWithStaleRecovery(s, sock('perm.sock'));
    expect(fs.statSync(sock('perm.sock')).mode & 0o777).toBe(0o600);
  });

  it('recovers a stale socket file left by a dead server (the kill -9 case)', async () => {
    const p = sock('stale.sock');
    // A dead server's leftover: a socket FILE with no listener. Create one by
    // listening then closing WITHOUT the close() unlink — simulate by copying
    // the simplest equivalent: a plain file at the path (same EADDRINUSE, and
    // the probe's connect() fails the same way as on a listenerless socket).
    fs.writeFileSync(p, '');
    const s = createServer();
    servers.push(s);
    await listenWithStaleRecovery(s, p); // must not throw
    // And it genuinely accepts connections now.
    await new Promise<void>((resolve, reject) => {
      const c = connect(p);
      c.once('connect', () => {
        c.destroy();
        resolve();
      });
      c.once('error', reject);
    });
  });

  it('refuses to steal a LIVE listener (real second server → rethrows EADDRINUSE)', async () => {
    const p = sock('live.sock');
    const first = createServer();
    servers.push(first);
    await listenWithStaleRecovery(first, p);
    const second = createServer();
    servers.push(second);
    await expect(listenWithStaleRecovery(second, p)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    // First server unharmed — still accepting.
    await new Promise<void>((resolve, reject) => {
      const c = connect(p);
      c.once('connect', () => {
        c.destroy();
        resolve();
      });
      c.once('error', reject);
    });
  });
});

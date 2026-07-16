import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonConnection } from '../../server/daemon-client';

// A daemon that dies mid-call must REJECT in-flight RPCs, not hang them —
// session-start/bridge/mcp all bare-await rpc(), and a hung awaiter leaks the
// whole HTTP request (a hang is not a rejection).
describe('DaemonConnection pending-RPC rejection', () => {
  let dir: string;
  let sockPath: string;
  let server: net.Server;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'seshmux-dc-'));
    sockPath = join(dir, 'd.sock');
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects an in-flight rpc when the socket closes without a reply', async () => {
    // Accepts the connection, never replies, hangs up after 50ms.
    server = net.createServer((sock) => {
      setTimeout(() => sock.destroy(), 50);
    });
    await new Promise<void>((r) => server.listen(sockPath, r));

    const conn = new DaemonConnection(sockPath);
    await conn.connect();
    await expect(conn.list()).rejects.toThrow('daemon connection closed');
    conn.close();
  });

  it('rejects an rpc issued after the socket already closed', async () => {
    server = net.createServer((sock) => sock.destroy());
    await new Promise<void>((r) => server.listen(sockPath, r));

    const conn = new DaemonConnection(sockPath);
    await conn.connect().catch(() => {});
    await new Promise((r) => setTimeout(r, 50)); // let the close land
    await expect(conn.list()).rejects.toThrow('daemon connection closed');
    conn.close();
  });
});

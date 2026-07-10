// Stale-socket-safe listen for the server-owned bridge sockets (approval.sock,
// wait.sock). A kill -9'd server leaves its unix socket FILES behind; the next
// boot then hits EADDRINUSE and (before this) silently degraded MCP approval +
// wait until someone deleted the files by hand. Same recovery the daemon does
// in daemon/ensure.js: on EADDRINUSE, PROBE the socket — a live listener
// accepts the connect (real second server: rethrow, never steal its socket);
// a dead one refuses (or it's not a socket at all) → unlink and listen again.

import { connect, type Server } from 'node:net';
import { unlinkSync } from 'node:fs';

function tryListen(server: Server, socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function probeAlive(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = connect(socketPath);
    let settled = false;
    const done = (alive: boolean) => {
      if (settled) return;
      settled = true;
      probe.destroy();
      resolve(alive);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.setTimeout(500, () => done(false));
  });
}

export async function listenWithStaleRecovery(server: Server, socketPath: string): Promise<void> {
  try {
    await tryListen(server, socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    if (await probeAlive(socketPath)) throw err; // genuinely in use
    try {
      unlinkSync(socketPath);
    } catch {
      /* raced another cleanup — the retry below decides */
    }
    await tryListen(server, socketPath);
  }
}

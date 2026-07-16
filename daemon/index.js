'use strict';
/**
 * seshmuxd — the PTY daemon. Plain Node JS, ZERO build step.
 * Only dependency (transitively, via pty-manager): the node-pty package.
 * Never imports server/ or UI code. Protocol FROZEN at 1.
 *
 * Owns a unix-socket JSON-RPC server + the PTY lifecycle. Deliberately boring:
 * it almost never needs updating, which is what keeps live sessions alive
 * across server updates (the product's core promise — plan Task 18).
 *
 * Paths derive from one config dir, overridable via SESHMUX_CONFIG_DIR:
 *   <configDir>/seshmuxd.sock   unix socket
 *   <configDir>/seshmuxd.pid    pidfile
 * Default configDir = ~/.config/seshmux
 */

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { PtyManager } = require('./pty-manager');
const { PROTOCOL, encode, createDecoder } = require('./protocol');
const { stripTerminalQueries } = require('./strip-queries');

const VERSION = readVersion();

function defaultConfigDir() {
  return (
    process.env.SESHMUX_CONFIG_DIR ||
    path.join(os.homedir(), '.config', 'seshmux')
  );
}

function readVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    );
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Start the daemon.
 * @param {{configDir?:string, sockPath?:string, pidPath?:string}} [opts]
 * @returns {Promise<{ server, ptyManager, sockPath, pidPath, close }>}
 */
async function startDaemon(opts = {}) {
  const configDir = opts.configDir || defaultConfigDir();
  const sockPath = opts.sockPath || path.join(configDir, 'seshmuxd.sock');
  const pidPath = opts.pidPath || path.join(configDir, 'seshmuxd.pid');

  // mode 0o700: the config dir holds the control socket — anyone who can reach
  // it can spawn arbitrary argv as this user. Only affects dirs we create.
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });

  // Unlink a stale socket file so listen() doesn't EADDRINUSE. (Stale-vs-live
  // pid detection is the server launcher's job in Task 13; here we just clear
  // a leftover file to bind.)
  try {
    fs.unlinkSync(sockPath);
  } catch {
    // not present — fine
  }

  const ptyManager = new PtyManager({ configDir });

  /** @type {Set<net.Socket>} clients subscribed to PTY events */
  const subscribers = new Set();

  // Fan PTY events out to every subscribed client.
  ptyManager.onEvent((event) => {
    const frame = encode(event);
    for (const sock of subscribers) {
      if (!sock.destroyed) sock.write(frame);
    }
  });

  const server = net.createServer((sock) => {
    const decoder = createDecoder();

    // setEncoding, NOT chunk.toString('utf8'): a socket chunk can split a
    // multibyte UTF-8 sequence, and per-chunk toString mangles the straddling
    // bytes to U+FFFD permanently. setEncoding routes through StringDecoder,
    // which buffers the partial sequence across chunks. (daemon-client.ts and
    // ensure.js already do this on their side.)
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      const messages = decoder.push(chunk);
      for (const msg of messages) handleMessage(sock, msg);
    });
    sock.on('error', () => {
      subscribers.delete(sock);
    });
    sock.on('close', () => {
      subscribers.delete(sock);
    });
  });

  function reply(sock, id, result) {
    if (!sock.destroyed) sock.write(encode({ id, result }));
  }
  function replyError(sock, id, message) {
    if (!sock.destroyed) sock.write(encode({ id, error: { message } }));
  }

  function handleMessage(sock, msg) {
    const { id, method, params } = msg || {};
    try {
      switch (method) {
        case 'hello':
          reply(sock, id, {
            protocol: PROTOCOL,
            version: VERSION,
            ptyCount: ptyManager.count(),
          });
          return;

        case 'spawn':
          reply(sock, id, ptyManager.spawn(params || {}));
          return;

        case 'attach': {
          const p = params || {};
          const ptyId = p.ptyId;
          if (!ptyManager.has(ptyId)) {
            replyError(sock, id, 'unknown ptyId: ' + ptyId);
            return;
          }
          // CRITICAL ordering: subscribe and snapshot in ONE synchronous block
          // with no await between them. onData fires on a later tick, so the
          // scrollback snapshot enqueues on the socket before any live chunk —
          // and we drop nothing arriving in the gap.
          subscribers.add(sock);
          if (p.fromScrollback !== false) {
            // Strip stale terminal QUERY sequences (DA/DSR) from the replay so
            // the reattaching emulator isn't provoked into sending a now-stale
            // reply that lands as junk in the current prompt. Live output is
            // never routed through here — only replayed scrollback. See
            // daemon/strip-queries.js.
            const scroll = stripTerminalQueries(ptyManager.scrollback(ptyId));
            if (scroll.length > 0) {
              sock.write(encode({ event: 'data', ptyId, data: scroll }));
            }
          }
          // Dead-but-in-grace PTY: the exit broadcast went to the THEN-subscribers,
          // so replay it to this late attacher (after the scrollback, mirroring
          // holder.js) — otherwise the client renders the final screen and waits
          // on a terminal that will never speak again.
          const dead = ptyManager.deadInfo(ptyId);
          if (dead) sock.write(encode({ event: 'exit', ptyId, code: dead.code }));
          reply(sock, id, { ptyId });
          return;
        }

        case 'write':
          reply(sock, id, ptyManager.write(params || {}));
          return;

        case 'resize':
          reply(sock, id, ptyManager.resize(params || {}));
          return;

        case 'kill':
          reply(sock, id, ptyManager.kill(params || {}));
          return;

        case 'list':
          reply(sock, id, ptyManager.list());
          return;

        case 'history':
          // Additive method (protocol stays 1): deep, width-correct history
          // from tmux capture-pane; ring-buffer fallback for plain PTYs.
          ptyManager
            .history(params || {})
            .then((r) => reply(sock, id, r))
            .catch((err) => replyError(sock, id, (err && err.message) || String(err)));
          return;

        case 'shutdown': {
          const force = !!(params && params.force);
          const alive = ptyManager.aliveCount();
          if (alive > 0 && !force) {
            // Refuse: stay up, live PTYs must not die on a casual shutdown.
            replyError(
              sock,
              id,
              'refusing to shut down: ' + alive + ' live pty(s); pass force:true'
            );
            return;
          }
          reply(sock, id, { ptyCount: ptyManager.count() });
          // Kill PTYs and tear down after the reply flushes.
          setImmediate(() => {
            ptyManager.killAll();
            close().catch(() => {});
          });
          return;
        }

        default:
          replyError(sock, id, 'unknown method: ' + method);
      }
    } catch (err) {
      replyError(sock, id, (err && err.message) || String(err));
    }
  }

  function close() {
    return new Promise((resolve) => {
      ptyManager.close();
      for (const sock of subscribers) {
        try {
          sock.destroy();
        } catch {
          // ignore
        }
      }
      subscribers.clear();
      server.close(() => {
        try {
          fs.unlinkSync(sockPath);
        } catch {
          // ignore
        }
        try {
          fs.unlinkSync(pidPath);
        } catch {
          // ignore
        }
        resolve();
      });
    });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // 0o600: the socket is created world-reachable-by-mode by default; lock it to
  // the owner so only this user's processes can drive the daemon.
  try {
    fs.chmodSync(sockPath, 0o600);
  } catch {
    // Non-POSIX FS (Windows) — best effort; the dir mode still constrains access.
  }

  fs.writeFileSync(pidPath, String(process.pid));

  // Adopt PTYs that outlived the previous daemon: holder tier first (ptyIds are
  // preserved there, and they were already reserved in the PtyManager ctor),
  // then tmux-tier sessions (no-op if tmux absent).
  await ptyManager.rehydrateHolders();
  await ptyManager.rehydrateTmux();

  return { server, ptyManager, sockPath, pidPath, close };
}

module.exports = { startDaemon };

// Run as a standalone process when invoked directly (Task 13 spawns this
// detached). In-process tests call startDaemon() instead.
if (require.main === module) {
  // Safety net (standalone only — in-process tests want loud failures): this
  // process OWNS every live PTY, so one missed rejection crashing it kills every
  // agent session at once — the exact failure the daemon exists to prevent.
  // Log-and-continue; the JSON-RPC layer already catches per-request errors.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write('[seshmuxd] unhandled rejection: ' + reason + '\n');
  });
  startDaemon().then(
    ({ sockPath }) => {
      process.stderr.write('[seshmuxd] listening on ' + sockPath + '\n');
    },
    (err) => {
      process.stderr.write('[seshmuxd] failed to start: ' + err.message + '\n');
      process.exit(1);
    }
  );
}

'use strict';
/**
 * ensure-daemon: make a responsive seshmuxd available, spawning + recovering as
 * needed. Plain Node JS so bin/seshmux.js can `require` it directly (zero build)
 * and the integration test can import the pure classifier.
 *
 * This is the ONLY place the daemon is spawned or a stale socket recovered.
 * server/daemon-client.ts never spawns/kills — that split is the update-safety
 * invariant (a server restart must not touch daemon-owned PTYs).
 *
 * "Responsive" = a hello reply within 1500ms. Recovery ladder:
 *   1. dial the socket → hello ok? done.
 *   2. ECONNREFUSED / timeout on an EXISTING socket file → inspect pidfile:
 *        - pid alive  → wait+retry (a peer is mid-startup)
 *        - pid dead   → stale: unlink socket, respawn.
 *   3. no socket file → spawn.
 * Concurrent launches serialize on a `mkdir` spawnlock (EEXIST → wait+retry dial).
 */

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const { PROTOCOL, encode, createDecoder } = require('./protocol');
const { ipcPath } = require('./ipc');

const HELLO_TIMEOUT_MS = 1500;
// A spawnlock older than this is presumed orphaned by a SIGKILLed launcher.
const LOCK_STALE_MS = 60_000;

function configDir() {
  return process.env.SESHMUX_CONFIG_DIR || path.join(os.homedir(), '.config', 'seshmux');
}
function paths(dir = configDir()) {
  return {
    dir,
    sock: path.join(dir, 'seshmuxd.sock'),
    pid: path.join(dir, 'seshmuxd.pid'),
    lock: path.join(dir, 'seshmuxd.spawnlock'),
  };
}

/** Is a pid running? kill(pid, 0) throws ESRCH if not, EPERM if alive-but-foreign. */
function pidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * PURE classifier (unit-tested): given the filesystem facts + whether a hello
 * dial succeeded, decide what to do. No I/O of its own.
 * @param {{socketExists:boolean, dialOk:boolean, pidExists:boolean, pidAlive:boolean}} facts
 * @returns {'ok'|'wait'|'stale'|'spawn'}
 *   ok    — daemon responsive, use it.
 *   wait  — a peer is starting (pid alive but not yet answering): retry dial.
 *   stale — socket file left by a dead daemon: unlink + spawn.
 *   spawn — nothing there: spawn.
 */
function classify(facts) {
  if (facts.dialOk) return 'ok';
  if (!facts.socketExists) return 'spawn';
  // socket file exists but dial failed:
  if (facts.pidExists && facts.pidAlive) return 'wait';
  return 'stale';
}

/** Read the pid from the pidfile, or null. */
function readPid(pidPath) {
  try {
    return Number(fs.readFileSync(pidPath, 'utf8').trim());
  } catch {
    return null;
  }
}

/** Dial + hello handshake within HELLO_TIMEOUT_MS. Resolves true/false, never throws. */
function tryHello(sockPath, timeoutMs = HELLO_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const decoder = createDecoder();
    const sock = net.connect(ipcPath(sockPath));
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(encode({ id: 1, method: 'hello' })));
    sock.on('data', (chunk) => {
      for (const msg of decoder.push(chunk)) {
        if (msg && msg.result && msg.result.protocol === PROTOCOL) done(true);
      }
    });
    sock.on('error', () => done(false));
    sock.on('close', () => done(false));
  });
}

/**
 * PURE predicate (unit-tested): may we restart the daemon without ending a live agent session?
 * tmux-tier PTYs rehydrate from `tmux ls` in the fresh daemon and survive; PLAIN-tier PTYs
 * (tmuxName null — machine without tmux) die with it. So: safe only when every LIVE pty is
 * tmux-backed, or there are none. Dead entries can't be killed twice, so they don't block.
 * @param {{tmuxName: string|null, alive?: boolean}[]} ptys — the daemon's `list` result
 * @returns {{safe: boolean, plainCount: number}}
 */
function canSafelyRestartDaemon(ptys) {
  const live = (ptys || []).filter((p) => p && p.alive !== false);
  const plainCount = live.filter((p) => !p.tmuxName).length;
  return { safe: plainCount === 0, plainCount };
}

/**
 * One dial: hello + list. Resolves { version, ptys } or null if the daemon isn't reachable.
 * Used by the supervisor's auto-upgrade decision (bin/seshmux.js) — never throws.
 */
function daemonInfo(sockPath, timeoutMs = HELLO_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    let version = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const decoder = createDecoder();
    const sock = net.connect(ipcPath(sockPath));
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write(encode({ id: 1, method: 'hello' }));
      sock.write(encode({ id: 2, method: 'list' }));
    });
    sock.on('data', (chunk) => {
      for (const msg of decoder.push(chunk)) {
        if (!msg || !msg.result) continue;
        if (msg.id === 1) version = msg.result.version || null;
        if (msg.id === 2) done({ version, ptys: msg.result.ptys || [] });
      }
    });
    sock.on('error', () => done(null));
    sock.on('close', () => done(null));
  });
}

const sleep = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

/**
 * Spawn seshmuxd detached so it OUTLIVES this process (Ctrl-C / server update).
 * detached + stdio:'ignore' + unref() is the literal mechanism behind
 * update-safety — the child is not in our process group and we don't wait on it.
 */
function spawnDaemon(dir) {
  const daemonEntry = path.join(__dirname, 'index.js');
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true, // win32: detached would otherwise open a console window
    env: { ...process.env, SESHMUX_CONFIG_DIR: dir },
  });
  child.unref();
  return child;
}

/**
 * Ensure a responsive daemon. Returns { sock, spawned }.
 * @param {{configDir?:string, retries?:number, retryDelayMs?:number}} [opts]
 */
async function ensureDaemon(opts = {}) {
  const dir = opts.configDir || configDir();
  const p = paths(dir);
  const retries = opts.retries ?? 40; // ~40 * 250ms = 10s ceiling
  const delay = opts.retryDelayMs ?? 250;

  // mode 0o700: guards the control socket the daemon binds inside this dir.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < retries; attempt++) {
    const dialOk = await tryHello(p.sock);
    const pid = readPid(p.pid);
    // win32: named pipes leave no fs entry, so the pidfile stands in for the
    // socket file in the staleness classifier (it's written after listen, so
    // it carries the same "a daemon got as far as binding" meaning).
    const socketExists = process.platform === 'win32' ? pid != null : fs.existsSync(p.sock);
    const facts = {
      socketExists,
      dialOk,
      pidExists: pid != null,
      pidAlive: pidAlive(pid),
    };
    const action = classify(facts);

    if (action === 'ok') return { sock: p.sock, spawned: false };
    if (action === 'wait') {
      await sleep(delay);
      continue;
    }

    // action is 'stale' or 'spawn' — serialize the spawn on the mkdir lock.
    let haveLock = false;
    try {
      fs.mkdirSync(p.lock);
      haveLock = true;
    } catch (e) {
      if (e.code === 'EEXIST') {
        // Another launcher holds the lock — UNLESS it was SIGKILLed between
        // mkdir and rmdir, orphaning the lock forever. Break that deadlock:
        // if the lock dir is older than LOCK_STALE_MS, remove it and retry.
        try {
          const age = Date.now() - fs.statSync(p.lock).mtimeMs;
          if (age > LOCK_STALE_MS) {
            fs.rmdirSync(p.lock);
            continue; // retry mkdir immediately
          }
        } catch {
          /* lock vanished under us — just retry */
        }
        await sleep(delay);
        continue;
      }
      throw e;
    }

    try {
      if (action === 'stale') {
        try {
          fs.unlinkSync(p.sock); // no-op on win32 (pipes leave no file)
        } catch {
          /* already gone */
        }
        try {
          fs.unlinkSync(p.pid); // dead daemon's pidfile must not re-classify as 'stale' forever on win32
        } catch {
          /* already gone */
        }
      }
      spawnDaemon(dir);
      // Wait for the fresh daemon to answer hello.
      for (let i = 0; i < retries; i++) {
        if (await tryHello(p.sock)) {
          return { sock: p.sock, spawned: true };
        }
        await sleep(delay);
      }
      throw new Error('seshmuxd did not become responsive after spawn');
    } finally {
      if (haveLock) {
        try {
          fs.rmdirSync(p.lock);
        } catch {
          /* ignore */
        }
      }
    }
  }
  throw new Error('ensureDaemon: exhausted retries without a responsive daemon');
}

module.exports = {
  classify,
  canSafelyRestartDaemon,
  daemonInfo,
  pidAlive,
  tryHello,
  ensureDaemon,
  paths,
  configDir,
  HELLO_TIMEOUT_MS,
};

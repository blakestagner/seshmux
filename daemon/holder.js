'use strict';
/**
 * seshmux PTY holder — a tiny detached process that OWNS one PTY.
 *
 * Why: the daemon used to `pty.spawn` directly, so it held the master fd. Kill
 * the daemon (crash, restart, upgrade) and the fd closed, the child got SIGHUP,
 * and the user's agent died. Only the tmux tier survived, because tmux owned
 * the process. The holder is the tmux tier for machines without tmux: it sits
 * between the daemon and the PTY, is spawned detached+setsid+unref'd, ignores
 * SIGHUP, and keeps buffering output while no daemon is attached.
 *
 * Plain CJS, zero build step, node-pty is the only dep (same rules as daemon/).
 *
 * Wire (NDJSON, same framing helpers as the daemon protocol — this is the
 * holder<->daemon link, NOT the frozen daemon<->server protocol):
 *   holder -> daemon:  {event:'ready', ptyId}        first frame to the accepted client
 *                      {event:'busy'}                a client is already attached; go away
 *                      {event:'data', data}          replay (one frame) then live output
 *                      {event:'exit', code}          the PTY exited
 *   daemon -> holder:  {method:'write', data}
 *                      {method:'resize', cols, rows}
 *                      {method:'kill'}
 *
 * Exactly ONE client at a time (that's the no-double-attach guarantee). A
 * client disconnect never touches the PTY.
 *
 * Argv: node holder.js '<json spec>' where spec =
 *   { holderDir, ptyId, sock, cwd, args, cols, rows, env }
 */

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const {
  RING_BUFFER_LINES,
  RING_BUFFER_BYTES,
  encode,
  createDecoder,
} = require('./protocol');
const { cmdInvocation } = require('./win-args');

// After the PTY exits we keep the socket up so a daemon that reconnects can
// still learn the exit code. Long grace when nobody knew; short when a live
// client already got the exit frame (or explicitly asked for the kill), so we
// don't leave a node process loitering for a minute per closed session.
const EXIT_GRACE_MS = 60 * 1000;
const EXIT_GRACE_KNOWN_MS = 5 * 1000;

// SIGHUP -> SIGKILL window for killTree(). Long enough for a dev server to run
// its shutdown handler, short enough that a closed tab frees its port promptly.
const KILL_ESCALATION_MS = 2000;

// The daemon's death must not be ours. (detached+stdio:'ignore' covers the fd
// side; this covers the signal side.)
process.on('SIGHUP', () => {});

const spec = JSON.parse(process.argv[2] || '{}');
const { holderDir, ptyId, sock: sockPath, cwd, args, cols, rows, env } = spec;
const jsonPath = path.join(holderDir, ptyId + '.json');

// This process owns exactly ONE agent PTY, and node-pty throws from inside its
// own socket 'error' callbacks (windowsTerminal.js / unixTerminal.js), outside
// every try/catch here. The daemon grew both crash nets; the holder had
// NEITHER — and on a machine without tmux the holder, not the daemon, is what
// owns every node-pty, so the real PTY-crash path was the one left unprotected.
// Staying up keeps the session usable and the exit code deliverable.
process.on('uncaughtException', (err) => {
  process.stderr.write('[holder ' + ptyId + '] uncaught exception: ' + ((err && err.stack) || err) + '\n');
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write('[holder ' + ptyId + '] unhandled rejection: ' + reason + '\n');
});

// win32: CreateProcess can't run .cmd/.bat shims (npm installs agent CLIs as
// exactly those) — route them through the command interpreter, with args quoted
// for both cmd.exe and the target's parser. Identity on posix.
const [file, rest, spawnOpts] = cmdInvocation(args[0], args.slice(1));
// cmdInvocation hands back a command line that is already fully escaped, so
// node-pty must not re-escape it. It has no windowsVerbatimArguments option, but
// a STRING `args` IS its verbatim form: windowsPtyAgent.js does
// `argsToCommandLine(file, []) + ' ' + args`, i.e. it quotes only the file and
// appends our line untouched. Passing the array instead let node-pty rewrite our
// quotes as MSVC `\"`, which cmd.exe does not understand — a .cmd under a path
// with spaces then never launched. Array (normal quoting) on posix / non-.cmd.
const ptyArgs = spawnOpts.windowsVerbatimArguments ? rest.join(' ') : rest;

const proc = pty.spawn(file, ptyArgs, {
  name: 'xterm-256color',
  cols: cols || 80,
  rows: rows || 24,
  cwd,
  env: { ...process.env, ...(env || {}) },
});

/**
 * Kill the PTY's whole PROCESS GROUP, not just its leader.
 *
 * node-pty's proc.kill() signals one pid. forkpty() setsid()s the child, so that
 * pid is the session + process-group leader — but its descendants (a `npm run
 * dev` under a scratch shell, an agent's own subprocesses) are separate pids in
 * that group. Signalling only the leader left them running, still holding their
 * listening ports, after the session was "closed". kill(-pgid) reaches all of
 * them. SIGKILL follow-up covers anything that traps/ignores SIGHUP; it's a
 * no-op once the group is already gone.
 *
 * win32 has no process groups — node-pty's kill() tears down the conpty job
 * object (children included), so the plain path is already correct there.
 *
 * Callers that exit right after MUST wait KILL_ESCALATION_MS + a beat before
 * cleanup(): cleanup() ends in process.exit(0), which would take the pending
 * SIGKILL timer with it and leave the SIGHUP-ignoring child alive — the exact
 * orphan this exists to prevent.
 */
function killTree() {
  try {
    if (process.platform === 'win32') {
      proc.kill();
      return;
    }
    process.kill(-proc.pid, 'SIGHUP');
    setTimeout(() => {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // group already gone — the normal case
      }
    }, KILL_ESCALATION_MS).unref();
  } catch {
    // pgid gone (or not a leader): fall back to the single-pid kill.
    try {
      proc.kill();
    } catch {
      // already dead
    }
  }
}

// Same ring semantics (and same caps) as the daemon's — bytes are replayed
// verbatim, never re-lined, so escape sequences survive.
const ring = [];
let ringLines = 0;
let ringBytes = 0;

function countNewlines(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) === 10) n++;
  return n;
}

function appendRing(chunk) {
  ring.push(chunk);
  ringLines += countNewlines(chunk);
  ringBytes += chunk.length;
  while (ring.length > 1 && (ringLines > RING_BUFFER_LINES || ringBytes > RING_BUFFER_BYTES)) {
    const dropped = ring.shift();
    ringLines -= countNewlines(dropped);
    ringBytes -= dropped.length;
  }
}

/** @type {net.Socket|null} the single attached client (the daemon) */
let client = null;
/** @type {{code:number}|null} */
let exited = null;
let exitKnown = false; // a client saw the exit, or asked for the kill
let cleaning = false;
let cleanupTimer = null;

/** (Re)arm the post-exit grace. Shortened once a client has learned the exit —
 *  a short-lived process can exit before the daemon even finishes connecting,
 *  so the grace is re-armed on connect, not decided once at exit time. */
function scheduleCleanup(ms) {
  if (cleanupTimer) clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(cleanup, ms);
}

function send(msg) {
  if (client && !client.destroyed) client.write(encode(msg));
}

proc.onData((data) => {
  appendRing(data);
  send({ event: 'data', data });
});

proc.onExit(({ exitCode }) => {
  exited = { code: exitCode };
  if (client && !client.destroyed) exitKnown = true;
  send({ event: 'exit', code: exitCode });
  scheduleCleanup(exitKnown ? EXIT_GRACE_KNOWN_MS : EXIT_GRACE_MS);
});

/** Remove socket + json and go. Never leave orphan files behind. */
function cleanup() {
  if (cleaning) return;
  cleaning = true;
  try {
    server.close();
  } catch {
    // ignore
  }
  for (const p of [sockPath, jsonPath]) {
    try {
      fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
  process.exit(0);
}

function handle(msg) {
  switch (msg && msg.method) {
    case 'write':
      try {
        proc.write(msg.data);
      } catch {
        // pty already gone
      }
      return;
    case 'resize':
      try {
        proc.resize(msg.cols || cols || 80, msg.rows || rows || 24);
      } catch {
        // pty already gone
      }
      return;
    case 'kill':
      exitKnown = true;
      killTree(); // the session is being ENDED — nothing it spawned may outlive it
      return;
    default:
      // ignore unknown
  }
}

const server = net.createServer((s) => {
  // FIRST, before ANY write: an accepted socket with no 'error' listener turns a
  // failed write into an unhandled 'error' event, which takes THIS PROCESS down —
  // and this process is the only thing holding the user's agent PTY. The busy
  // write below is the one that bit: a peer that connects and vanishes (a probe,
  // a racing re-dial, an adopting second daemon) makes it fail EPIPE, and the
  // holder died — silently, since we run stdio:'ignore' — taking a live session
  // with it. The daemon then saw an attached-then-dropped socket and reported
  // `pty is not alive`. Reproduced deterministically: connect + destroy twice.
  // Not win32-specific — a posix peer that vanishes EPIPEs identically; Windows
  // named pipes just lose the race far more often.
  s.on('error', () => {
    if (client === s) client = null;
  });
  // Single-client rule: a second daemon can never attach the same holder.
  if (client && !client.destroyed) {
    s.write(encode({ event: 'busy' }));
    s.end();
    return;
  }
  client = s;
  const decoder = createDecoder();
  // setEncoding, not per-chunk toString: pasted unicode keystrokes can straddle
  // a chunk boundary; StringDecoder buffers the partial sequence.
  s.setEncoding('utf8');
  s.on('data', (chunk) => {
    for (const m of decoder.push(chunk)) handle(m);
  });
  s.on('close', () => {
    if (client === s) client = null;
    // The daemon that knew about the exit has gone; nothing left to tell.
    if (exited && exitKnown) cleanup();
  });

  // ready -> replay -> live, all in this tick: nothing can slip into the gap.
  s.write(encode({ event: 'ready', ptyId }));
  const replay = ring.join('');
  if (replay) s.write(encode({ event: 'data', data: replay }));
  if (exited) {
    exitKnown = true;
    s.write(encode({ event: 'exit', code: exited.code }));
    scheduleCleanup(EXIT_GRACE_KNOWN_MS); // this client now knows; don't loiter
  }
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    killTree();
    // Ref'd on purpose: cleanup()'s process.exit(0) would otherwise kill the
    // holder before killTree's SIGKILL escalation lands.
    setTimeout(cleanup, KILL_ESCALATION_MS + 100);
  });
}

try {
  fs.unlinkSync(sockPath);
} catch {
  // no stale socket — fine
}

server.listen(sockPath, () => {
  try {
    fs.chmodSync(sockPath, 0o600);
  } catch {
    // best effort
  }
  // Written AFTER listen, so a json on disk implies a socket to dial.
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      ptyId,
      pid: process.pid,
      sock: sockPath,
      cwd,
      args,
      cols: cols || 80,
      rows: rows || 24,
      startedAt: Date.now(),
    })
  );
});

server.on('error', () => {
  // Can't listen (path too long, dir gone): the PTY is unreachable, so don't
  // strand it — kill it and exit rather than leaving an invisible child.
  killTree();
  setTimeout(cleanup, KILL_ESCALATION_MS + 100); // see the SIGTERM handler
});

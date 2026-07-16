'use strict';
/**
 * seshmuxd PTY manager — owns all agent child processes.
 *
 * Provider-agnostic: spawns whatever argv it is handed (args come from the
 * server's provider.commands). NO agent binary names appear here.
 *
 * Two persistence tiers, BOTH of which survive the daemon's death:
 *   - holder tier (default): a detached `daemon/holder.js` process owns the
 *     PTY and speaks NDJSON over `<configDir>/holders/<ptyId>.sock`. The daemon
 *     is just a client. Kill the daemon and the agent never notices; the next
 *     daemon re-adopts the holder under its ORIGINAL ptyId (rehydrateHolders).
 *   - tmux tier (tmuxName present): `tmux new-session -A -s seshmux-<name>`,
 *     so the session survives a daemon restart and can be re-hydrated from
 *     `tmux ls` on startup. Unchanged.
 *
 * Externally (spawn/write/resize/kill/list/history RPCs, data/exit events, the
 * ring buffer served on attach) nothing about this changed — the holder tier is
 * internal re-plumbing. Daemon<->server protocol stays FROZEN at 1.
 *
 * Only dependency: @homebridge/node-pty-prebuilt-multiarch.
 */

const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const { execFile, spawn: spawnProcess } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const {
  TMUX_PREFIX,
  RING_BUFFER_LINES,
  RING_BUFFER_BYTES,
  encode,
  createDecoder,
} = require('./protocol');
const { ipcPath } = require('./ipc');

const HOLDER_ENTRY = path.join(__dirname, 'holder.js');
// Connect retries while a freshly-spawned holder boots node + binds its socket.
const HOLDER_CONNECT_TRIES = 100;
const HOLDER_CONNECT_DELAY_MS = 100;

/**
 * Path of a holder's unix socket. macOS caps sun_path at ~104 bytes, and a
 * config dir can be arbitrarily deep (tests use mkdtemp under /var/folders/...),
 * so fall back to a short /tmp name keyed by a hash of the holder dir when the
 * natural path would overflow. The holder records the path it actually bound in
 * its .json, so adoption never has to re-derive it.
 */
function holderSockPath(holderDir, ptyId) {
  const natural = path.join(holderDir, ptyId + '.sock');
  // win32: no unix sockets — map to a named pipe up front. The pipe name flows
  // through the holder spec, the holder's listen(), its .json, and adoption
  // unchanged; unlink/exists on it just no-op (pipes leave no fs entry).
  if (process.platform === 'win32') return ipcPath(natural);
  if (Buffer.byteLength(natural) <= 100) return natural;
  const h = crypto.createHash('sha1').update(holderDir).digest('hex').slice(0, 8);
  return path.join('/tmp', `smx-${h}-${ptyId}.sock`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM'; // alive, just not ours to signal
  }
}

function unlinkQuiet(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    // ignore
  }
}

/**
 * Client side of the holder link, shaped like a node-pty process (onData /
 * onExit / write / resize / kill) so PtyManager entries and _wireProc don't
 * care which tier they're on.
 *
 * Connects with retries (a just-spawned holder needs a moment to bind), queues
 * writes until connected, and buffers inbound frames until onData/onExit are
 * registered (adoption registers them AFTER awaiting ready()).
 */
class HolderClient {
  constructor(sockPath, opts = {}) {
    this._sockPath = sockPath;
    this._tries = opts.tries || HOLDER_CONNECT_TRIES;
    this._sock = null;
    this._queue = [];
    this._pendingData = [];
    this._pendingExit = null;
    this._onData = null;
    this._onExit = null;
    this._done = false; // exit delivered/queued — stop reconnecting
    this._detached = false;
    this._ready = false;
    this._readyResolve = null;
    this._readyPromise = new Promise((r) => {
      this._readyResolve = r;
    });
    this._connect(0);
  }

  /** @returns {Promise<boolean>} true once the holder accepted us as ITS client. */
  ready() {
    return this._readyPromise;
  }

  _settleReady(ok) {
    if (this._readyResolve) {
      const r = this._readyResolve;
      this._readyResolve = null;
      r(ok);
    }
  }

  _connect(attempt) {
    const s = net.connect(this._sockPath);
    const decoder = createDecoder();
    s.on('connect', () => {
      this._sock = s;
      for (const frame of this._queue) s.write(frame);
      this._queue = [];
    });
    // setEncoding, not per-chunk toString: this socket carries live PTY output
    // (dense with multibyte — emoji, CJK, box-drawing); a chunk boundary inside
    // a UTF-8 sequence otherwise corrupts the character to U+FFFD forever.
    s.setEncoding('utf8');
    s.on('data', (chunk) => {
      for (const m of decoder.push(chunk)) this._handle(m);
    });
    s.on('error', () => {});
    s.on('close', () => {
      if (this._sock === s) this._sock = null;
      if (this._done || this._detached) return;
      // Attached-then-dropped means the holder itself died — its PTY died with
      // it (master fd closed). Anything else is a not-yet-listening socket.
      if (this._ready || attempt >= this._tries) {
        this._settleReady(false);
        this._fail(1);
        return;
      }
      setTimeout(() => this._connect(attempt + 1), HOLDER_CONNECT_DELAY_MS);
    });
  }

  _handle(msg) {
    switch (msg && msg.event) {
      case 'ready':
        this._ready = true;
        this._settleReady(true);
        return;
      case 'busy':
        // Another daemon owns this holder. Never double-attach: give up on it.
        // (Adoption checks ready() and drops the client before it ever becomes
        // an entry; a spawn that somehow lost the race goes dead rather than
        // silently mute.)
        this._settleReady(false);
        this._fail(1);
        return;
      case 'data':
        if (this._onData) this._onData(msg.data);
        else this._pendingData.push(msg.data);
        return;
      case 'exit':
        this._fail(msg.code);
        return;
      default:
      // ignore
    }
  }

  _fail(code) {
    if (this._done) return;
    this._done = true;
    if (this._onExit) this._onExit({ exitCode: code });
    else this._pendingExit = { exitCode: code };
  }

  _send(msg) {
    const frame = encode(msg);
    if (this._sock && !this._sock.destroyed) this._sock.write(frame);
    else if (!this._done) this._queue.push(frame);
  }

  onData(fn) {
    this._onData = fn;
    const pending = this._pendingData;
    this._pendingData = [];
    for (const d of pending) fn(d);
  }

  onExit(fn) {
    this._onExit = fn;
    if (this._pendingExit) {
      const e = this._pendingExit;
      this._pendingExit = null;
      fn(e);
    }
  }

  write(data) {
    this._send({ method: 'write', data });
  }

  resize(cols, rows) {
    this._send({ method: 'resize', cols, rows });
  }

  kill() {
    this._send({ method: 'kill' });
  }

  /** Let go of the holder without touching its PTY (daemon shutting down). */
  detach() {
    this._detached = true;
    if (this._sock) {
      try {
        this._sock.end(); // end(), not destroy(): flush a queued kill first
      } catch {
        // ignore
      }
    }
  }
}

// Dead PTY entries (alive=false) linger so a recently-exited session can still
// be re-attached / rehydrated, then get swept once past this grace window —
// without it the _ptys Map (each entry holding its full ring) grows forever.
const DEAD_GRACE_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

// tmux-tier reconcile (BUG-11): when a tmux-tier PTY's node-pty client exits
// (e.g. `tmux detach-client`, or the user's default tmux server dropping the
// client) but the tmux SESSION itself survives, the agent is still running —
// so re-attach a fresh client instead of declaring the session dead. Before
// reviving, wait this long and re-check `has-session`: a genuinely-exiting
// agent tears its session down at almost the same instant its client exits, so
// the delay lets that teardown settle and keeps a dying session from flapping.
const RECONCILE_DELAY_MS = 300;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Env for tmux child processes: strip $TMUX/$TMUX_PANE so tmux talks to its
 * default server instead of nesting inside whatever tmux launched seshmux
 * (a user may run `npx seshmux` from inside a tmux pane). All tmux invocations
 * — spawn, rehydrate attach, and `tmux ls` — MUST use this so they agree on
 * which server they operate against.
 */
function tmuxEnv() {
  const e = { ...process.env };
  delete e.TMUX;
  delete e.TMUX_PANE;
  return e;
}

/**
 * Turn off tmux's built-in status bar for one session (seshmux draws its own).
 * Best-effort + one delayed retry: `new-session -A` runs inside the spawned
 * PTY, so `set-option` can lose the race and hit a not-yet-created session
 * (exit 1). One retry ~200ms later covers that without polling. tmux missing
 * (execFile ENOENT) → the callback swallows it; no status bar to hide anyway.
 * ponytail: single retry, not a poll loop — 200ms beats session create with
 * huge margin; bump if a slow box ever misses.
 */
function hideTmuxStatus(fullTmuxName) {
  const { execFile } = require('child_process');
  const run = (onDone) =>
    execFile(
      'tmux',
      ['set-option', '-t', fullTmuxName, 'status', 'off'],
      { env: tmuxEnv() },
      (err) => onDone(err),
    );
  run((err) => {
    if (err) setTimeout(() => run(() => {}), 200);
  });
}

/**
 * Config-dir ownership tag for tmux sessions. tmux servers are per-USER, so a
 * second daemon (isolated tests, a scratch SESHMUX_CONFIG_DIR) sees the live
 * daemon's `seshmux-*` sessions in `tmux ls` and would double-attach them on
 * rehydrate — two 80x24 clients fighting over pane size. Sessions are stamped
 * with their owning config dir as a tmux user option (@seshmux-config) at
 * spawn, and rehydrate only claims sessions whose stamp matches its own config
 * dir. Unstamped sessions (created before this fix) are claimed AND adopted —
 * stamped on claim — so the fleet converges without a respawn.
 */
function defaultConfigDirTag() {
  return process.env.SESHMUX_CONFIG_DIR || path.join(os.homedir(), '.config', 'seshmux');
}

/** Stamp a session as owned by this daemon's config dir. Races new-session -A
 * like hideTmuxStatus, but ownership is correctness (an unstamped window lets
 * a foreign daemon adopt the session), so retry until it lands — bounded, not
 * a single shot. ponytail: 10×200ms cap; a session slower than 2s to create
 * stays unstamped-legacy, which degrades to the pre-fix behavior, not a break. */
function markTmuxConfig(fullTmuxName, tag, attempt = 0) {
  execFile(
    'tmux',
    ['set-option', '-t', fullTmuxName, '@seshmux-config', tag],
    { env: tmuxEnv() },
    (err) => {
      if (err && attempt < 10) setTimeout(() => markTmuxConfig(fullTmuxName, tag, attempt + 1), 200);
    },
  );
}

/** True iff a tmux session by this exact name still exists on the shared
 *  (default) server. False on any tmux error/absence — a missing `tmux` binary
 *  or dead server means there is nothing to revive. */
function tmuxHasSession(sessionName) {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      ['has-session', '-t', sessionName],
      { timeout: 2000, env: tmuxEnv() },
      (err) => resolve(!err)
    );
  });
}

/** Read a session's @seshmux-config stamp. '' if unset or tmux errors. */
function tmuxConfigTag(sessionName) {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      ['show-options', '-qv', '-t', sessionName, '@seshmux-config'],
      { timeout: 2000, env: tmuxEnv() },
      (err, stdout) => resolve(err ? '' : (stdout || '').trim())
    );
  });
}

class PtyManager {
  /** @param {{configDir?:string}} [opts] configDir = ownership tag for tmux
   *  sessions (see configDirTag docs). Defaults to the env/HOME derivation so
   *  a bare `new PtyManager()` (and the production daemon, whose process env
   *  carries SESHMUX_CONFIG_DIR) behaves identically. */
  constructor(opts = {}) {
    /** @type {Map<string, object>} ptyId -> entry */
    this._ptys = new Map();
    this._nextId = 1;
    /** listeners: (event) => void, where event is a {event,...} object */
    this._onEvent = null;
    this._configDir = opts.configDir || defaultConfigDirTag();
    this._configTag = this._configDir;
    this._holderDir = path.join(this._configDir, 'holders');
    // ID stability: surviving holders keep their ORIGINAL ptyId when adopted
    // (the server and browser hold ptyIds). Reserve those ids synchronously
    // HERE — rehydrateHolders() is async and the daemon's socket is already
    // listening by then, so a spawn racing it must not hand out a colliding id.
    this._reserveHolderIds();
    // Unref'd so it never keeps the daemon process alive on its own.
    this._sweepTimer = setInterval(() => void this._sweepDead(), SWEEP_INTERVAL_MS);
    this._sweepTimer.unref();
  }

  /**
   * Drop dead entries whose grace window has elapsed. Live entries and
   * recently-exited ones (still re-attachable) are always kept.
   *
   * Backstop for BUG-11: a dead tmux-tier entry whose tmux session is still
   * alive gets revived here (same ptyId) rather than swept — covers the rare
   * case where the on-exit reconcile missed (transient `has-session` error, a
   * spontaneously-dropped client). A genuinely-gone or foreign session revives
   * false and sweeps normally once past grace.
   */
  async _sweepDead() {
    const cutoff = Date.now() - DEAD_GRACE_MS;
    for (const [id, e] of this._ptys) {
      if (e.alive) continue;
      if (e.tmuxName && !e.noRevive && (await this._reviveTmuxNow(e))) continue;
      if (e.deadAt != null && e.deadAt <= cutoff) this._ptys.delete(id);
    }
  }

  /** Bump _nextId past every ptyId already claimed by a holder on disk. */
  _reserveHolderIds() {
    let files = [];
    try {
      files = fs.readdirSync(this._holderDir);
    } catch {
      return; // no holders dir yet
    }
    for (const f of files) {
      const m = /^pty-(\d+)\.json$/.exec(f);
      if (m && Number(m[1]) >= this._nextId) this._nextId = Number(m[1]) + 1;
    }
  }

  /** Stop the background sweep, and let go of holders WITHOUT killing them —
   *  their PTYs are the whole point: they outlive this daemon. */
  close() {
    clearInterval(this._sweepTimer);
    for (const e of this._ptys.values()) {
      if (e.proc && typeof e.proc.detach === 'function') e.proc.detach();
    }
  }

  /** Register the sink that receives {event:'data'|'exit', ...} objects. */
  onEvent(fn) {
    this._onEvent = fn;
  }

  _emit(event) {
    if (this._onEvent) this._onEvent(event);
  }

  _nextPtyId() {
    return 'pty-' + this._nextId++;
  }

  /**
   * Append a raw chunk to a PTY's ring buffer, capping by total newline count.
   * Store RAW bytes verbatim — terminal escape/redraw sequences must replay
   * exactly, so we never parse or reconstruct lines.
   */
  _appendRing(entry, chunk) {
    entry.ring.push(chunk);
    entry.ringLines += countNewlines(chunk);
    entry.ringBytes += chunk.length;
    // Evict oldest while EITHER cap is exceeded — the byte cap catches
    // newline-free growth (spinners, one giant line) the line cap misses.
    while (
      entry.ring.length > 1 &&
      (entry.ringLines > RING_BUFFER_LINES || entry.ringBytes > RING_BUFFER_BYTES)
    ) {
      const dropped = entry.ring.shift();
      entry.ringLines -= countNewlines(dropped);
      entry.ringBytes -= dropped.length;
    }
  }

  /**
   * Wire a freshly-spawned node-pty into an entry: fan its data into the ring +
   * event sink, and route its exit through _onProcExit. Shared by spawn(),
   * rehydrateTmux(), and tmux revival so all three behave identically (and a
   * change to the entry event shape can't miss a construction site).
   */
  _wireProc(entry) {
    const { proc, ptyId } = entry;
    proc.onData((data) => {
      this._appendRing(entry, data);
      this._emit({ event: 'data', ptyId, data });
    });
    proc.onExit(({ exitCode }) => this._onProcExit(entry, exitCode));
  }

  /**
   * A node-pty exited. For a tmux-tier entry whose tmux session still exists,
   * this is a client detach — revive silently (re-attach a fresh client under
   * the SAME ptyId, no 'exit' emitted) so the server/UI never see the session
   * go dead. Only when the session is genuinely gone (or a plain PTY exits) do
   * we flip alive=false and emit 'exit'.
   */
  _onProcExit(entry, exitCode) {
    const die = () => {
      entry.alive = false;
      entry.deadAt = Date.now();
      entry.exitCode = exitCode; // kept for late attachers (see deadInfo)
      this._emit({ event: 'exit', ptyId: entry.ptyId, code: exitCode });
    };
    // An explicit kill()/killAll() means the caller wants this entry GONE — never
    // resurrect it, even though its tmux session detaches-but-survives by design.
    if (entry.noRevive || !entry.tmuxName) {
      die();
      return;
    }
    // Keep alive=true across the reconcile window so list()/`/api/sessions/live`
    // don't flicker the session away for a client detach we're about to heal.
    void this._maybeReviveTmux(entry).then((revived) => {
      if (!revived) die();
    });
  }

  /** Wait out the flap window, then try to revive. */
  async _maybeReviveTmux(entry) {
    await wait(RECONCILE_DELAY_MS);
    return this._reviveTmuxNow(entry);
  }

  /**
   * If entry's tmux session still exists AND is ours (ownership stamp), attach a
   * fresh node-pty to it under the SAME ptyId and mark it alive again. Returns
   * true on revive, false if the session is gone / foreign / attach failed (the
   * caller then declares the entry dead). No 'exit'/'spawn' event is emitted —
   * to every subscriber the revived PTY just keeps producing data on its ptyId.
   */
  async _reviveTmuxNow(entry) {
    // Re-check at fire time, not just at schedule time: kill() can set noRevive
    // during the RECONCILE_DELAY_MS window after the proc already exited (its
    // proc.kill() is then a no-op, so no second exit event re-runs the gate) —
    // without this the scheduled revive resurrected an explicitly-killed session.
    if (entry.noRevive) return false;
    if (!entry.tmuxName) return false;
    if (!(await tmuxHasSession(entry.tmuxName))) return false;
    // Never claim a session stamped by a DIFFERENT config dir (foreign daemon).
    const tag = await tmuxConfigTag(entry.tmuxName);
    if (tag && tag !== this._configTag) return false;
    let proc;
    try {
      proc = pty.spawn('tmux', ['attach-session', '-t', entry.tmuxName], {
        name: 'xterm-256color',
        cols: entry.cols,
        rows: entry.rows,
        cwd: os.homedir() || process.cwd(),
        env: tmuxEnv(),
      });
    } catch {
      return false;
    }
    entry.proc = proc;
    entry.alive = true;
    entry.deadAt = null;
    hideTmuxStatus(entry.tmuxName);
    this._wireProc(entry);
    return true;
  }

  /**
   * Launch a detached holder for this PTY and return a node-pty-shaped client
   * for it. detached + stdio:'ignore' + unref() + the holder's SIGHUP handler
   * are what make `kill -9 <daemon>` a non-event for the agent.
   */
  _spawnHolder({ ptyId, cwd, args, cols, rows }) {
    fs.mkdirSync(this._holderDir, { recursive: true, mode: 0o700 });
    const sock = holderSockPath(this._holderDir, ptyId);
    const spec = {
      holderDir: this._holderDir,
      ptyId,
      sock,
      cwd,
      args,
      cols,
      rows,
      env: { SESHMUX_PTY_ID: ptyId },
    };
    const child = spawnProcess(process.execPath, [HOLDER_ENTRY, JSON.stringify(spec)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true, // win32: detached would otherwise open a console window
      cwd,
      env: process.env,
    });
    child.unref();
    return new HolderClient(sock);
  }

  /**
   * Spawn a PTY running the given argv.
   * @param {{cwd?:string, args:string[], cols?:number, rows?:number, tmuxName?:string}} params
   * @returns {{ptyId:string}}
   */
  spawn({ cwd, args, cols, rows, tmuxName } = {}) {
    if (!Array.isArray(args) || args.length === 0) {
      throw new Error('spawn requires a non-empty args array');
    }
    const columns = cols || 80;
    const lines = rows || 24;
    const cwdResolved = cwd || os.homedir() || process.cwd();

    // ptyId assigned BEFORE spawn (not after) so it can be exported into the
    // child's env — status-hook scripts (Spec 2) read $SESHMUX_PTY_ID from
    // their own environment to self-locate without any sessionId->ptyId
    // mapping. Additive env var, not a wire-protocol change.
    const ptyId = this._nextPtyId();

    let proc;
    let fullTmuxName = null;
    if (tmuxName) {
      // tmux tier: attach-or-create a named session running the argv.
      //
      // IMPORTANT (verified empirically, not documented behavior to assume):
      // `pty.spawn('tmux', ...)` launching a NEW tmux CLIENT process does NOT
      // propagate that client's env into the pane — `new-session` asks the
      // tmux SERVER to create the pane, and the server does not inherit each
      // client's env. Plain `env:` on pty.spawn (as used for the non-tmux
      // branch below) silently no-ops here. The verified fix is explicit
      // `-e KEY=VALUE` flags on `new-session` itself, which DO seed the new
      // pane's environment. Only takes effect on a genuinely NEW session —
      // `-A` reattaching an EXISTING session ignores `-e` (that pane's env
      // was already set at its original creation; a daemon-restart rehydrate
      // of a surviving tmux session keeps its OLD ptyId in $SESHMUX_PTY_ID,
      // so its hook writes to a now-stale status file and that session
      // degrades to heuristics until it's respawned — graceful, not fatal).
      fullTmuxName = TMUX_PREFIX + tmuxName;
      const envFlags = ['-e', `SESHMUX_PTY_ID=${ptyId}`];
      if (process.env.SESHMUX_CONFIG_DIR) {
        envFlags.push('-e', `SESHMUX_CONFIG_DIR=${process.env.SESHMUX_CONFIG_DIR}`);
      }
      const argv = ['new-session', '-A', '-s', fullTmuxName, ...envFlags, '--', ...args];
      const baseEnv = tmuxEnv();
      baseEnv.SESHMUX_PTY_ID = ptyId;
      proc = pty.spawn('tmux', argv, {
        name: 'xterm-256color',
        cols: columns,
        rows: lines,
        cwd: cwdResolved,
        env: baseEnv,
      });
      // Hide tmux's own status bar for THIS session only — seshmux draws its
      // own statusbar, so the blue tmux chrome is redundant noise. Scoped to
      // the session (not -g) because we share the user's default tmux server.
      hideTmuxStatus(fullTmuxName);
      markTmuxConfig(fullTmuxName, this._configTag);
    } else {
      // Holder tier: a detached process owns the PTY, we're only its client.
      proc = this._spawnHolder({ ptyId, cwd: cwdResolved, args, cols: columns, rows: lines });
    }

    const entry = {
      ptyId,
      proc,
      cwd: cwdResolved,
      args,
      tmuxName: fullTmuxName,
      cols: columns,
      rows: lines,
      alive: true,
      deadAt: null,
      ring: [],
      ringLines: 0,
      ringBytes: 0,
    };
    this._ptys.set(ptyId, entry);
    this._wireProc(entry);

    return { ptyId };
  }

  /**
   * Return the concatenated raw scrollback for a PTY (for attach replay).
   * Empty string if unknown. Caller must write this synchronously right after
   * subscribing so live data can't race ahead of the snapshot.
   */
  scrollback(ptyId) {
    const entry = this._ptys.get(ptyId);
    if (!entry) return '';
    return entry.ring.join('');
  }

  /**
   * Deep history for a PTY (additive RPC, protocol stays 1 — "fetch history"
   * feature). tmux tier: `capture-pane -e` returns the session's OWN history,
   * already line-wrapped at the current window width — clean at any depth,
   * unlike the raw ring bytes (which mix widths). `-E -1` stops at the last
   * history line ABOVE the visible screen so the caller's follow-up repaint
   * doesn't duplicate the live rows. Plain-PTY tier: ring buffer, best effort.
   * @param {{ptyId:string, lines?:number}} params
   * @returns {Promise<{data:string}>}
   */
  history({ ptyId, lines } = {}) {
    const entry = this._ptys.get(ptyId);
    if (!entry) throw new Error('unknown ptyId: ' + ptyId);
    const cap = Math.min(Math.max(1, lines || 2000), 10000);
    if (!entry.tmuxName) return Promise.resolve({ data: this.scrollback(ptyId) });
    return new Promise((resolve) => {
      execFile(
        'tmux',
        ['capture-pane', '-p', '-e', '-t', entry.tmuxName, '-S', String(-cap), '-E', '-1'],
        { timeout: 3000, maxBuffer: 16 * 1024 * 1024, env: tmuxEnv() },
        (err, stdout) => {
          // tmux gone/errored → ring fallback rather than an error: history is
          // an enhancement, never worth failing an attach-adjacent flow over.
          if (err) resolve({ data: this.scrollback(ptyId) });
          else resolve({ data: stdout.split('\n').join('\r\n') });
        },
      );
    });
  }

  has(ptyId) {
    return this._ptys.has(ptyId);
  }

  write({ ptyId, data } = {}) {
    const entry = this._ptys.get(ptyId);
    if (!entry) throw new Error('unknown ptyId: ' + ptyId);
    if (!entry.alive) throw new Error('pty is not alive: ' + ptyId);
    entry.proc.write(data);
    return { ok: true };
  }

  resize({ ptyId, cols, rows } = {}) {
    const entry = this._ptys.get(ptyId);
    if (!entry) throw new Error('unknown ptyId: ' + ptyId);
    if (!entry.alive) throw new Error('pty is not alive: ' + ptyId);
    entry.cols = cols || entry.cols;
    entry.rows = rows || entry.rows;
    entry.proc.resize(entry.cols, entry.rows);
    return { ok: true };
  }

  /**
   * null while alive (or unknown id); {code} once the PTY died. Lets attach
   * replay the exit to a subscriber who connected AFTER the death broadcast
   * (dead entries linger for DEAD_GRACE_MS) — otherwise a reconnecting client
   * got scrollback and showed the terminal live forever.
   */
  deadInfo(ptyId) {
    const e = this._ptys.get(ptyId);
    if (!e || e.alive) return null;
    return { code: e.exitCode != null ? e.exitCode : -1 };
  }

  kill({ ptyId } = {}) {
    const entry = this._ptys.get(ptyId);
    if (!entry) throw new Error('unknown ptyId: ' + ptyId);
    entry.noRevive = true; // intent: stay dead, don't reconcile-revive (BUG-11 guard)
    try {
      entry.proc.kill();
    } catch {
      // Already dead — treat as success.
    }
    return { ok: true };
  }

  list() {
    const ptys = [];
    for (const e of this._ptys.values()) {
      ptys.push({
        ptyId: e.ptyId,
        cwd: e.cwd,
        args: e.args,
        tmuxName: e.tmuxName,
        alive: e.alive,
        // Additive (protocol stays 1; readers ignore extras): lets the browser
        // know the PTY's current geometry at attach, so a pane whose fitted
        // size differs can reset + force a clean redraw instead of painting
        // replayed scrollback at the wrong width.
        cols: e.cols,
        rows: e.rows,
      });
    }
    return { ptys };
  }

  aliveCount() {
    let n = 0;
    for (const e of this._ptys.values()) if (e.alive) n++;
    return n;
  }

  count() {
    return this._ptys.size;
  }

  /** Kill every PTY (used by shutdown({force:true})). tmux sessions detach, not die. */
  killAll() {
    for (const e of this._ptys.values()) {
      e.noRevive = true; // forced shutdown: no revival racing daemon teardown (BUG-11 guard)
      try {
        e.proc.kill();
      } catch {
        // ignore
      }
    }
  }

  /**
   * On daemon startup, adopt every surviving holder under its ORIGINAL ptyId.
   *
   * For each `<holderDir>/<ptyId>.json`:
   *   - pid dead        -> crash leftovers; delete json + socket, no entry
   *   - socket refuses  -> holder wedged; leave the files, no entry
   *   - {event:'busy'}  -> another daemon already holds it; skip (no double-attach)
   *   - ready           -> adopt: the holder replays its ring buffer, so bytes
   *                        produced while NO daemon was attached still reach
   *                        the client on reattach.
   */
  async rehydrateHolders() {
    let files = [];
    try {
      files = fs.readdirSync(this._holderDir);
    } catch {
      return this.count();
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const jsonPath = path.join(this._holderDir, f);
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch {
        unlinkQuiet(jsonPath);
        continue;
      }
      if (!meta || !meta.ptyId || !meta.pid || !meta.sock) {
        unlinkQuiet(jsonPath);
        continue;
      }
      if (this._ptys.has(meta.ptyId)) continue; // already ours
      if (!pidAlive(meta.pid)) {
        unlinkQuiet(jsonPath);
        unlinkQuiet(meta.sock);
        continue;
      }
      // Short retry budget: an existing holder is either listening now or isn't.
      const client = new HolderClient(meta.sock, { tries: 3 });
      if (!(await client.ready())) {
        client.detach();
        continue;
      }
      const entry = {
        ptyId: meta.ptyId,
        proc: client,
        cwd: meta.cwd,
        args: meta.args,
        tmuxName: null,
        cols: meta.cols || 80,
        rows: meta.rows || 24,
        alive: true,
        deadAt: null,
        ring: [],
        ringLines: 0,
        ringBytes: 0,
      };
      this._ptys.set(meta.ptyId, entry);
      this._wireProc(entry); // registers onData -> flushes the replayed ring
      const n = Number(String(meta.ptyId).replace('pty-', ''));
      if (Number.isFinite(n) && n >= this._nextId) this._nextId = n + 1;
    }
    return this.count();
  }

  /**
   * On daemon startup, re-hydrate tmux-tier sessions by attaching a fresh PTY
   * to each existing `seshmux-` tmux session. Ring buffers start empty (tmux
   * redraws on attach; its scrollback is not recoverable here — expected).
   * No-ops silently if tmux is absent.
   */
  async rehydrateTmux() {
    const names = await listTmuxSessions();
    for (const fullName of names) {
      if (!fullName.startsWith(TMUX_PREFIX)) continue;
      // Skip if already tracked.
      let already = false;
      for (const e of this._ptys.values()) {
        if (e.tmuxName === fullName) {
          already = true;
          break;
        }
      }
      if (already) continue;

      // Ownership check: never claim a session stamped by a DIFFERENT config
      // dir (see configDirTag docs). Unstamped = legacy → claim and adopt.
      const tag = await tmuxConfigTag(fullName);
      if (tag && tag !== this._configTag) continue;

      // Recover the session's real cwd from its active pane — the UI maps
      // cwd → project, so HOME here mislabels every rehydrated tab.
      const paneCwd = await tmuxPaneCwd(fullName);
      const cwd = paneCwd || os.homedir() || process.cwd();
      const proc = pty.spawn('tmux', ['attach-session', '-t', fullName], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: os.homedir() || process.cwd(),
        env: tmuxEnv(),
      });
      // Session already exists here (no create race) but may predate the
      // status-off fix — set it so old sessions lose the bar on rehydrate too.
      hideTmuxStatus(fullName);
      if (!tag) markTmuxConfig(fullName, this._configTag); // adopt legacy unstamped sessions
      const ptyId = this._nextPtyId();
      const entry = {
        ptyId,
        proc,
        cwd,
        args: ['tmux', 'attach-session', '-t', fullName],
        tmuxName: fullName,
        cols: 80,
        rows: 24,
        alive: true,
        deadAt: null,
        ring: [],
        ringLines: 0,
        ringBytes: 0,
      };
      this._ptys.set(ptyId, entry);
      this._wireProc(entry);
    }
    return this.count();
  }
}

function countNewlines(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Real working directory of a tmux session's active pane. Rehydrated sessions
 * lost their original spawn cwd (the daemon that knew it died) — the pane's
 * current path is the next best truth, and the UI keys projects off it.
 * Falls back to null (caller uses HOME) if tmux errors.
 */
function tmuxPaneCwd(sessionName) {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      ['display', '-t', sessionName, '-p', '#{pane_current_path}'],
      { timeout: 2000, env: tmuxEnv() },
      (err, stdout) => {
        const p = (stdout || '').trim();
        resolve(!err && p ? p : null);
      }
    );
  });
}

/** List tmux session names via `tmux ls`. Returns [] if tmux missing/no server. */
function listTmuxSessions() {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      ['ls', '-F', '#{session_name}'],
      { timeout: 2000, env: tmuxEnv() },
      (err, stdout) => {
        if (err || !stdout) {
          resolve([]);
          return;
        }
        resolve(
          stdout
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        );
      }
    );
  });
}

module.exports = { PtyManager };

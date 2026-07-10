'use strict';
/**
 * seshmuxd PTY manager — owns all agent child processes.
 *
 * Provider-agnostic: spawns whatever argv it is handed (args come from the
 * server's provider.commands). NO agent binary names appear here.
 *
 * Two persistence tiers:
 *   - plain PTY: reattach survives any number of server connections via the
 *     in-memory ring buffer, but dies with the daemon.
 *   - tmux tier (tmuxName present): `tmux new-session -A -s seshmux-<name>`,
 *     so the session survives a daemon restart and can be re-hydrated from
 *     `tmux ls` on startup.
 *
 * Only dependency: @homebridge/node-pty-prebuilt-multiarch.
 */

const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const { execFile } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { TMUX_PREFIX, RING_BUFFER_LINES } = require('./protocol');

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
    this._configTag = opts.configDir || defaultConfigDirTag();
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
    while (entry.ringLines > RING_BUFFER_LINES && entry.ring.length > 1) {
      const dropped = entry.ring.shift();
      entry.ringLines -= countNewlines(dropped);
    }
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
    const cwdResolved = cwd || process.env.HOME || process.cwd();

    // ptyId assigned BEFORE spawn (not after) so it can be exported into the
    // child's env — status-hook scripts (Spec 2) read $SESHMUX_PTY_ID from
    // their own environment to self-locate without any sessionId->ptyId
    // mapping. Additive env var, not a wire-protocol change.
    const ptyId = this._nextPtyId();

    let file;
    let argv;
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
      file = 'tmux';
      const envFlags = ['-e', `SESHMUX_PTY_ID=${ptyId}`];
      if (process.env.SESHMUX_CONFIG_DIR) {
        envFlags.push('-e', `SESHMUX_CONFIG_DIR=${process.env.SESHMUX_CONFIG_DIR}`);
      }
      argv = ['new-session', '-A', '-s', fullTmuxName, ...envFlags, '--', ...args];
    } else {
      file = args[0];
      argv = args.slice(1);
    }

    const baseEnv = tmuxName ? tmuxEnv() : { ...process.env };
    baseEnv.SESHMUX_PTY_ID = ptyId;

    const proc = pty.spawn(file, argv, {
      name: 'xterm-256color',
      cols: columns,
      rows: lines,
      cwd: cwdResolved,
      env: baseEnv,
    });

    if (fullTmuxName) {
      // Hide tmux's own status bar for THIS session only — seshmux draws its
      // own statusbar, so the blue tmux chrome is redundant noise. Scoped to
      // the session (not -g) because we share the user's default tmux server.
      hideTmuxStatus(fullTmuxName);
      markTmuxConfig(fullTmuxName, this._configTag);
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
      ring: [],
      ringLines: 0,
    };
    this._ptys.set(ptyId, entry);

    proc.onData((data) => {
      this._appendRing(entry, data);
      this._emit({ event: 'data', ptyId, data });
    });
    proc.onExit(({ exitCode }) => {
      entry.alive = false;
      this._emit({ event: 'exit', ptyId, code: exitCode });
    });

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

  kill({ ptyId } = {}) {
    const entry = this._ptys.get(ptyId);
    if (!entry) throw new Error('unknown ptyId: ' + ptyId);
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
      try {
        e.proc.kill();
      } catch {
        // ignore
      }
    }
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
      const cwd = paneCwd || process.env.HOME || process.cwd();
      const proc = pty.spawn('tmux', ['attach-session', '-t', fullName], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.env.HOME || process.cwd(),
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
        ring: [],
        ringLines: 0,
      };
      this._ptys.set(ptyId, entry);
      proc.onData((data) => {
        this._appendRing(entry, data);
        this._emit({ event: 'data', ptyId, data });
      });
      proc.onExit(({ exitCode }) => {
        entry.alive = false;
        this._emit({ event: 'exit', ptyId, code: exitCode });
      });
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

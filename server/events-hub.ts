// Server-lifetime event hub — the single source of app-wide push state.
//
// Owns:
//   • the events-ws subscriber set (one connection per browser)
//   • per-PTY needs-input status (statusByPty) + classify state (niStateByPty)
//   • ONE persistent "monitor" daemon connection that receives every PTY's
//     data/exit broadcast and drives needs-input classification
//   • a periodic empty-tick so needs-input can reach 'idle' / persist 'waiting'
//     (those transitions only fire on the empty-chunk path in classify())
//   • the watch (chokidar) → ctx/session-new/session-touch fan-out
//
// Items 1-3 of the wiring wave all read/write THIS module, so replay-on-connect
// has a single place to read from. Terminal I/O stays on the separate per-PTY
// /ws/term sockets (routes/term.ts) — this hub never carries terminal bytes.

import type { WebSocket } from '@fastify/websocket';
import { DaemonConnection, dial, socketPath } from './daemon-client';
import {
  classifyExplain,
  hookFileExists,
  initState,
  readHookStatusDetail,
  stripAnsi,
  type NIEvidence,
  type NIState,
  type NIStatus,
} from './lib/needs-input';
import { startWatching, type WatchEvent, type Watcher } from './lib/store/watch';
import { invalidateScanCache } from './lib/store/scan';
import { getProviders } from './lib/providers/types';
import { claudeStoreRoot, claudeSubagentWatchConfig } from './lib/providers/claude';
import { invalidateCodexSummaries } from './lib/providers/codex';
import chokidar from 'chokidar';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TICK_MS = 4000; // empty-tick cadence for idle/waiting-persist transitions

// Resolve a fresh hook status against the heuristic (R2-4). A fresh hook normally WINS
// (that's Spec 2 — hooks give higher-confidence prompt detection than the regex). The one
// exception: a 'waiting' hook can pin the UI to 'waiting' for up to 30s after the agent
// resumes, because no hook fires on resume. So if the heuristic sees a GENUINE working
// signal — a MATCHED working pattern (the "esc to interrupt" footer the agent redraws on
// resume), not mere output arrival — let 'working' override the stale 'waiting' hook.
//   • Only 'waiting' hooks are overridable; an 'idle' Stop-hook still wins (its design).
//   • Only a matched-pattern 'working' overrides; bare output/echo (matchedPattern null)
//     does NOT — that's exactly the miss the waiting hook exists to cover (keeps the
//     Spec 2 "regex broken on purpose" tests green: plain cat output has no match).
function resolveHookVsHeuristic(
  hookStatus: NIStatus,
  heuristicStatus: NIStatus,
  matchedPattern: string | null,
): NIStatus {
  if (hookStatus === 'waiting' && heuristicStatus === 'working' && matchedPattern) return 'working';
  return hookStatus;
}

function configDir(): string {
  return process.env.SESHMUX_CONFIG_DIR || path.join(os.homedir(), '.config', 'seshmux');
}
function statusDir(): string {
  return path.join(configDir(), 'status');
}

// Spec 6: what GET /api/term/:ptyId/status-explain returns. Latest evidence only
// (N=1 per PTY, no history) — the endpoint's whole point is "why is the dot THIS
// color right now," not an audit log.
export interface StatusExplain {
  status: NIStatus;
  evidence: NIEvidence;
  hookOverride: { path: string; ageMs: number | null; hookStatus: NIStatus } | null;
  lastLines: string[]; // last 20 stripped lines of the frame classified against
}

export interface EventsHub {
  addClient(ws: WebSocket): void;
  /** Ensure the monitor is attached to this PTY (called on spawn + startup). */
  trackPty(ptyId: string): void;
  /** Spec 6: latest classify evidence for a PTY, or null if never classified. */
  getStatusExplain(ptyId: string): StatusExplain | null;
  /**
   * Watch <repo>/.seshmux/handoff.md for a project with an open scratchpad tab
   * (plan 16.6) → emit {event:'scratchpad', projectId} so the UI refetches.
   * Idempotent per projectId. Called by the scratchpad GET route.
   */
  watchScratchpad(projectId: string, repoPath: string): void;
  /**
   * Close scratchpad + subagent watchers idle past the cutoff (default: last touched
   * over 15min ago); returns how many were closed. Runs automatically on a background
   * interval — exposed for tests and manual memory-pressure shedding. Re-opening a tab
   * re-arms its watcher transparently.
   */
  sweepIdleWatchers(cutoff?: number): Promise<number>;
  /**
   * Watch a claude session's subagents/ dir (incl. workflows/<wf>/) for a session
   * with an open subagent viewer → emit {event:'subagents', projectId, sessionId}
   * (ping-only; the client refetches GET /api/subagents). Idempotent per
   * projectId:sessionId. Called by the subagents GET route.
   */
  watchSubagents(projectId: string, sessionId: string): void;
  /**
   * Watch a team's config.json (absolute path resolved by the caller via
   * provider.teams.configPath — hard rule 3, the hub never builds the path
   * itself) → emit {event:'team', teamName, leadSessionId} on change (summary
   * only; client refetches GET /api/teams/members). Idempotent per teamName.
   * An unlink (lead session exited, config.json removed) broadcasts one final
   * event then disposes the watcher — "team ended" is not an error, don't retry.
   * Called by the teams GET /members route on first request for a team.
   */
  watchTeam(teamName: string, leadSessionId: string, configPath: string): void;
  /** Broadcast an arbitrary event to all clients (planoff stream, etc.). */
  emit(event: Record<string, unknown>): void;
  /**
   * Spec 5 (bridge `wait_for_status`): resolve when ptyId's status feed — the
   * SAME post-Spec-2-precedence feed that drives setStatus/broadcast, not a
   * fresh heuristic computation — reaches `status`. Already-at-status resolves
   * immediately. NEVER throws/rejects: caps at 600s and resolves 'timeout'
   * data instead, so a caller can treat it as data, not an exception.
   */
  waitForStatus(ptyId: string, status: NIStatus, timeoutSec?: number): Promise<{ status: NIStatus | 'timeout' }>;
  /** MCP approval (16.7): broadcast a request + await the UI's correlated reply. */
  requestApproval(info: {
    requestId: string;
    tool: string;
    question: string;
    cwd: string;
    hop: number;
    expiresAt: number;
  }): Promise<boolean>;
  /** Resolve a pending approval from the UI reply; false if unknown/expired. */
  resolveApproval(requestId: string, approved: boolean): boolean;
  broadcastRestarting(): void;
  close(): Promise<void>;
}

export async function createEventsHub(): Promise<EventsHub> {
  const subscribers = new Set<WebSocket>();
  const statusByPty = new Map<string, NIStatus>();
  const niStateByPty = new Map<string, NIState>();
  const attached = new Set<string>();
  // Spec 2: which PTYs currently have a hook status file at all (fresh or
  // stale — just "does the file exist"), refreshed once per tick. Gates the
  // data-path hook check so a PTY with no hook installed/firing takes the
  // OLD fully-synchronous classify() path (hooks off -> byte-identical
  // behavior, no per-chunk fs read on the hot path for the common case).
  const hooksActive = new Set<string>();
  // Spec 6: latest classify evidence per PTY (N=1, overwritten every classify —
  // no history kept, see StatusExplain doc comment).
  const explainByPty = new Map<string, StatusExplain>();

  // needs-input waiting patterns come from provider.needsInputPatterns (Task 15).
  // We don't know a PTY's provider from the daemon (provider-agnostic), so use
  // the union of all providers' patterns — a superset is safe for detection.
  const providers = await getProviders().catch(() => []);
  const waitingPatterns = providers.flatMap((p) => p.needsInputPatterns);

  const now = () => Date.now();

  function send(ws: WebSocket, obj: unknown) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }
  function broadcast(obj: unknown) {
    const frame = JSON.stringify(obj);
    for (const ws of subscribers) if (ws.readyState === ws.OPEN) ws.send(frame);
  }

  // Spec 5: pending wait_for_status subscribers, keyed by ptyId. A single ptyId
  // can have multiple concurrent waiters (different callers, different target
  // statuses) — each entry carries its own target + resolver + timeout handle.
  const statusWaiters = new Map<string, { target: NIStatus; resolve: (r: { status: NIStatus | 'timeout' }) => void; timer: ReturnType<typeof setTimeout> }[]>();

  function settleWaiters(ptyId: string, status: NIStatus) {
    const list = statusWaiters.get(ptyId);
    if (!list) return;
    const remaining = list.filter((w) => {
      if (w.target !== status) return true;
      clearTimeout(w.timer);
      w.resolve({ status });
      return false;
    });
    if (remaining.length) statusWaiters.set(ptyId, remaining);
    else statusWaiters.delete(ptyId);
  }

  function setStatus(ptyId: string, status: NIStatus) {
    if (statusByPty.get(ptyId) === status) return; // change-only
    statusByPty.set(ptyId, status);
    broadcast({ event: 'status', ptyId, status });
    settleWaiters(ptyId, status);
  }

  const MAX_WAIT_SEC = 600;
  function waitForStatus(ptyId: string, status: NIStatus, timeoutSec = 120): Promise<{ status: NIStatus | 'timeout' }> {
    // Already there — resolve immediately, no subscription needed.
    if (statusByPty.get(ptyId) === status) return Promise.resolve({ status });
    const capped = Math.min(Math.max(1, timeoutSec), MAX_WAIT_SEC);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = statusWaiters.get(ptyId);
        if (list) {
          const remaining = list.filter((w) => w.resolve !== resolve);
          if (remaining.length) statusWaiters.set(ptyId, remaining);
          else statusWaiters.delete(ptyId);
        }
        resolve({ status: 'timeout' });
      }, capped * 1000);
      const list = statusWaiters.get(ptyId) ?? [];
      list.push({ target: status, resolve, timer });
      statusWaiters.set(ptyId, list);
    });
  }

  // Spec 6: stash the latest classify evidence for a PTY (overwrites, N=1).
  // `chunk` may be '' (empty tick) — lastLines then stays whatever the previous
  // non-empty frame classified against (stripAnsi('') is '', so guard it).
  function recordExplain(
    ptyId: string,
    finalStatus: NIStatus,
    evidence: NIEvidence,
    chunk: string,
    hookOverride: StatusExplain['hookOverride'],
  ) {
    const prev = explainByPty.get(ptyId);
    // stripAnsi collapses ALL whitespace (including \n) into single spaces, so
    // split the RAW chunk into lines first, then strip each line individually —
    // otherwise there'd be no line breaks left to split on.
    const lastLines =
      chunk.length > 0
        ? chunk
            .split(/\r?\n/)
            .map((l) => stripAnsi(l))
            .filter((l) => l.length > 0)
        : prev?.lastLines;
    explainByPty.set(ptyId, {
      status: finalStatus,
      evidence,
      hookOverride,
      lastLines: (lastLines ?? []).slice(-20),
    });
  }

  function stateFor(ptyId: string): NIState {
    let s = niStateByPty.get(ptyId);
    if (!s) {
      s = initState(now());
      s.now = now; // real clock in production (tests inject their own)
      niStateByPty.set(ptyId, s);
    }
    return s;
  }

  // ── Monitor daemon connection: receives every PTY's data/exit broadcast ──────
  let monitor: DaemonConnection | null = null;
  // Set before an intentional close() so the reconnect-on-drop logic below
  // doesn't treat our own monitor.close() as a dropped connection and re-dial
  // a new one nothing will ever close (leaked socket keeps the daemon's
  // server.close() from resolving — see test/events-hub.test.ts afterAll).
  let closing = false;
  async function ensureMonitor() {
    if (monitor) return monitor;
    monitor = await dial(socketPath());
    monitor.onEvent((e) => {
      if (e.event === 'data' && typeof e.data === 'string') {
        const st = stateFor(e.ptyId);
        // classifyExplain() delegates the actual status decision to classify()
        // (byte-identical mutation/return), so wrapping it here to capture
        // evidence for Spec 6 cannot change Spec 2/hot-path behavior.
        const result = classifyExplain(e.data, st, waitingPatterns);
        const heuristic = result.status;
        recordExplain(e.ptyId, heuristic, result, e.data, null);
        if (!hooksActive.has(e.ptyId)) {
          setStatus(e.ptyId, heuristic);
          return;
        }
        // Hook file exists for this PTY — a fresh one WINS over heuristics
        // outright (never blended). Guarded by `attached.has` on resolve: the
        // PTY may have exited (and been deleted from statusByPty/attached)
        // between the read starting and finishing — never resurrect a dead
        // PTY's status after its 'exit' broadcast already fired 'idle'.
        const ptyId = e.ptyId;
        const chunk = e.data;
        void readHookStatusDetail(statusDir(), ptyId).then((detail) => {
          if (!attached.has(ptyId)) return;
          const hookWon = detail.fresh && detail.status
            ? resolveHookVsHeuristic(detail.status, heuristic, result.matchedPattern)
            : heuristic;
          const finalStatus = hookWon;
          // override reflects the ACTUAL winner: null when the heuristic overrode a stale
          // waiting hook (R2-4), so status-explain doesn't claim the hook decided it.
          const override =
            detail.fresh && detail.status && finalStatus === detail.status
              ? { path: detail.path, ageMs: detail.ageMs, hookStatus: detail.status }
              : null;
          recordExplain(ptyId, finalStatus, result, chunk, override);
          setStatus(ptyId, finalStatus);
        });
      } else if (e.event === 'exit') {
        statusByPty.delete(e.ptyId);
        niStateByPty.delete(e.ptyId);
        attached.delete(e.ptyId);
        hooksActive.delete(e.ptyId);
        explainByPty.delete(e.ptyId);
        broadcast({ event: 'status', ptyId: e.ptyId, status: 'idle' });
        settleWaiters(e.ptyId, 'idle');
      }
    });
    monitor.onClose(() => {
      monitor = null;
      attached.clear();
      if (closing) return; // intentional shutdown — don't reconnect
      // Daemon connection dropped (e.g. server-side hiccup) — re-dial + re-attach.
      setTimeout(() => void reattachAll(), 500);
    });
    return monitor;
  }

  async function attachPty(ptyId: string) {
    if (attached.has(ptyId)) return;
    const m = await ensureMonitor();
    // fromScrollback:false — the monitor wants LIVE output for classification,
    // not a scrollback replay (which would re-classify stale frames).
    await m.attach(ptyId, false).catch(() => {});
    attached.add(ptyId);
    if (!statusByPty.has(ptyId)) setStatus(ptyId, 'working');
    // Seed hooksActive immediately (don't wait up to TICK_MS) — matters for a
    // resumed/rehydrated session whose hook file may already exist at attach.
    void hookFileExists(statusDir(), ptyId).then((exists) => {
      if (exists) hooksActive.add(ptyId);
    });
  }

  async function reattachAll() {
    if (closing) return; // close() may land inside the 500ms reconnect delay
    try {
      const m = await ensureMonitor();
      const { ptys } = await m.list();
      for (const p of ptys) if (p.alive) await attachPty(p.ptyId);
    } catch {
      /* daemon not up yet — trackPty/tick will retry */
    }
  }

  function trackPty(ptyId: string) {
    void attachPty(ptyId);
  }

  // ── Periodic empty-tick: drives idle + waiting-persist, applies hook override ─
  // Also refreshes hooksActive (existence-only probe) so the data path knows,
  // without a per-chunk fs read, whether a given PTY has hooks installed/firing.
  const timer = setInterval(() => {
    for (const ptyId of statusByPty.keys()) {
      const st = stateFor(ptyId);
      const result = classifyExplain('', st, waitingPatterns);
      const heuristic = result.status;
      void hookFileExists(statusDir(), ptyId).then((exists) => {
        if (exists) hooksActive.add(ptyId);
        else hooksActive.delete(ptyId);
      });
      // Optional Notification-hook file is a higher-confidence override.
      void readHookStatusDetail(statusDir(), ptyId).then((detail) => {
        if (!attached.has(ptyId)) return; // exited between tick fire and resolve
        // Empty-tick: result.matchedPattern is always null, so resolveHookVsHeuristic never
        // overrides here (a genuine resume only shows up as a matched footer on the data
        // path) — a fresh hook still wins, same as before. Shared for shape consistency.
        const finalStatus = detail.fresh && detail.status
          ? resolveHookVsHeuristic(detail.status, heuristic, result.matchedPattern)
          : heuristic;
        const override =
          detail.fresh && detail.status && finalStatus === detail.status
            ? { path: detail.path, ageMs: detail.ageMs, hookStatus: detail.status }
            : null;
        recordExplain(ptyId, finalStatus, result, '', override);
        setStatus(ptyId, finalStatus);
      });
    }
  }, TICK_MS);

  // ── Watch (chokidar) → ctx / session-new / session-touch fan-out ─────────────
  let watcher: Watcher | null = null;
  try {
    watcher = startWatching({
      emit: (ev: WatchEvent) => {
        // A new/touched session file changes the store scan (new dir, bumped
        // mtime → rail sort). Drop that provider's cached scan so the next read
        // re-walks; staleness is now bounded by the watcher debounce, not the
        // TTL floor. ctx-only events don't affect the scan.
        if (ev.event === 'session-new' || ev.event === 'session-touch') {
          invalidateScanCache(ev.provider);
          // invalidateScanCache only covers scanRoot (claude); codex's store walk
          // is memoized separately in the provider.
          if (ev.provider === 'codex') invalidateCodexSummaries();
        }
        broadcast(ev);
      },
    });
  } catch {
    watcher = null; // stores absent — degrade quietly
  }

  // ── Status-dir watch (Spec 2 round 2): a hook's FIRST write for a PTY must flip
  //    status within ~1s, not wait for the next TICK_MS (4s). Mirrors the scratchpad
  //    watcher below: on add/change of status/<ptyId>.json, seed hooksActive right
  //    away and immediately run the same guarded async check the data-path uses.
  //    The per-chunk hot path is untouched — this only shortens the FIRST-fire gap.
  let statusWatcher: ReturnType<typeof chokidar.watch> | null = null;
  try {
    // The dir may not exist yet (hook script mkdir -p's it on its own first write,
    // e.g. hooks were just installed but no session has fired one) — chokidar only
    // picks up a path created AFTER watch() starts if the path already exists now.
    fsSync.mkdirSync(statusDir(), { recursive: true });
    statusWatcher = chokidar.watch(statusDir(), { ignoreInitial: true, depth: 0 });
    const onStatusFile = (filePath: string) => {
      const base = path.basename(filePath);
      if (!base.endsWith('.json')) return;
      const ptyId = base.slice(0, -'.json'.length);
      hooksActive.add(ptyId);
      void readHookStatusDetail(statusDir(), ptyId).then((detail) => {
        if (!attached.has(ptyId) || !detail.fresh || !detail.status) return;
        const prev = explainByPty.get(ptyId);
        if (prev) {
          recordExplain(ptyId, detail.status, prev.evidence, '', {
            path: detail.path,
            ageMs: detail.ageMs,
            hookStatus: detail.status,
          });
        }
        setStatus(ptyId, detail.status);
      });
    };
    statusWatcher.on('add', onStatusFile);
    statusWatcher.on('change', onStatusFile);
  } catch {
    statusWatcher = null; // watching unavailable — tick path still covers it
  }

  // Adopt any PTYs that survived a server restart.
  void reattachAll();

  function addClient(ws: WebSocket) {
    // Replay-on-connect: register THEN snapshot synchronously (no await between),
    // so a status change can't race ahead of the snapshot.
    subscribers.add(ws);
    for (const [ptyId, status] of statusByPty) send(ws, { event: 'status', ptyId, status });
    ws.on('close', () => subscribers.delete(ws));
    ws.on('error', () => subscribers.delete(ws));
  }

  // ── Scratchpad watch (plan 16.6): live-refresh the tab when either agent writes
  //    <repo>/.seshmux/handoff.md. One chokidar watcher per project, lazily added.
  const scratchpadWatched = new Map<string, { close(): Promise<void> }>();
  // Last-touched ms per watcher key, so the idle sweep (MEM-5/MEM-6) can evict
  // watchers no tab has re-opened in a while. A re-open transparently re-arms via
  // the existing lazy-create path below.
  const scratchpadTouched = new Map<string, number>();
  function watchScratchpad(projectId: string, repoPath: string) {
    scratchpadTouched.set(projectId, Date.now());
    if (scratchpadWatched.has(projectId)) return;
    const file = path.join(repoPath, '.seshmux', 'handoff.md');
    try {
      // awaitWriteFinish so a multi-write atomic rename settles to one event.
      const w = chokidar.watch(file, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200 },
      });
      w.on('add', () => broadcast({ event: 'scratchpad', projectId }));
      w.on('change', () => broadcast({ event: 'scratchpad', projectId }));
      scratchpadWatched.set(projectId, w);
    } catch {
      /* watching unavailable — the tab still works via manual refetch */
    }
  }

  // ── Subagent watch: live-refresh the viewer when a session's subagent files change.
  //    One chokidar watcher per projectId:sessionId, lazily added on first viewer-open.
  //    Ping-only — the client refetches GET /api/subagents. Debounced (workflow JSONs
  //    rewrite in bursts) so a rewrite storm collapses to one ping.
  const subagentWatched = new Map<string, { close(): Promise<void> }>();
  const subagentDebounce = new Map<string, NodeJS.Timeout>();
  const subagentTouched = new Map<string, number>();
  function watchSubagents(projectId: string, sessionId: string) {
    const key = `${projectId}:${sessionId}`;
    subagentTouched.set(key, Date.now());
    if (subagentWatched.has(key)) return;
    // The subagents/ layout stays in the provider (hard rule 3) — resolve the dir there.
    // Resolution is async (folded worktree sessions live in another dirent), so register
    // a handle synchronously: sweep/close before the dir resolves cancels the arm.
    let closed = false;
    let watcher: { close(): Promise<void> } | undefined;
    subagentWatched.set(key, {
      async close() {
        closed = true;
        if (watcher) await watcher.close().catch(() => {});
      },
    });
    // A failed arm must evict its stub so the next viewer touch retries.
    const evictStub = () => {
      if (!closed && !watcher) subagentWatched.delete(key);
    };
    void (async () => {
      try {
        const dir = await claudeSubagentWatchConfig.sessionDir(claudeStoreRoot(), projectId, sessionId);
        if (!dir || closed) {
          evictStub();
          return;
        }
        const w = chokidar.watch(dir, {
          ignoreInitial: true,
          depth: claudeSubagentWatchConfig.depth,
        });
        watcher = w;
        const ping = () => {
          const prev = subagentDebounce.get(key);
          if (prev) clearTimeout(prev);
          subagentDebounce.set(
            key,
            setTimeout(() => {
              subagentDebounce.delete(key);
              broadcast({ event: 'subagents', projectId, sessionId });
            }, 250),
          );
        };
        w.on('add', ping);
        w.on('change', ping);
        w.on('addDir', ping);
      } catch {
        /* watching unavailable — the viewer still works via manual refetch */
        evictStub();
      }
    })();
  }

  // ── Idle watcher eviction (MEM-5/MEM-6): scratchpad + subagent watchers were armed
  //    on first open and only released at hub close — an fd leak per tab ever opened
  //    over server uptime. Close any watcher not touched (re/opened) in IDLE_MS; a
  //    later re-open re-arms it transparently via the lazy-create guards above.
  const WATCHER_IDLE_MS = 15 * 60_000;
  // Close every watcher last touched before `cutoff` (default: idle > WATCHER_IDLE_MS).
  // Returns the count of watchers closed — exposed so tests can force a sweep and so a
  // caller could shed watchers under memory pressure.
  async function sweepIdleWatchers(cutoff = Date.now() - WATCHER_IDLE_MS): Promise<number> {
    let evicted = 0;
    for (const [projectId, at] of scratchpadTouched) {
      if (at > cutoff) continue;
      scratchpadTouched.delete(projectId);
      const w = scratchpadWatched.get(projectId);
      if (w) {
        scratchpadWatched.delete(projectId);
        await w.close().catch(() => {});
        evicted++;
      }
    }
    for (const [key, at] of subagentTouched) {
      if (at > cutoff) continue;
      subagentTouched.delete(key);
      const t = subagentDebounce.get(key);
      if (t) {
        clearTimeout(t);
        subagentDebounce.delete(key);
      }
      const w = subagentWatched.get(key);
      if (w) {
        subagentWatched.delete(key);
        await w.close().catch(() => {});
        evicted++;
      }
    }
    // Team watchers are deliberately NOT swept (R5-5). Unlike scratchpad/subagent watchers —
    // which re-arm on the next tab open — a team watcher is armed only by a /api/teams/members
    // request, and the ONLY thing that triggers a refetch is the `team` event that this very
    // watcher emits. Sweeping it is therefore self-defeating: the roster would silently stop
    // updating forever. It already self-prunes on config.json unlink (its normal end of life);
    // an abrupt lead-session death leaks one watcher, bounded by team churn — a far smaller
    // cost than a dead roster panel.
    return evicted;
  }
  const watcherSweep = setInterval(() => void sweepIdleWatchers(), 5 * 60_000);
  watcherSweep.unref?.(); // never keep the process alive for the sweep alone

  // ── Team watch (Task 4): live-refresh the roster panel when a team's
  //    config.json changes (member join / isActive flip). One chokidar watcher
  //    per teamName, lazily added on first /api/teams/members request. Unlike
  //    scratchpad/subagents (which stay armed until hub close), config.json is
  //    DELETED when the lead session exits — an unlink means "team ended," so
  //    we broadcast one final event and dispose right away instead of leaving
  //    a dead watcher around or treating ENOENT as an error to retry.
  const teamWatched = new Map<string, { close(): Promise<void> }>();
  // The CURRENT lead session per team, read by the watcher's ping at emit time rather than
  // captured in its closure. A team name can be reused by a NEW lead (the old lead died
  // abruptly, so config.json was never unlinked and its watcher was never disposed); the
  // has(teamName) early-return then reuses that watcher, and a closed-over leadSessionId
  // would keep pinging the DEAD lead's id forever — the client keys its refresh by lead id,
  // so the new team's roster would never live-update again (R6-3). Refreshing this map on
  // every watchTeam call is what actually heals a reused team; an idle sweep only papered
  // over it by forcing a re-arm.
  const teamLead = new Map<string, string>();
  function watchTeam(teamName: string, leadSessionId: string, configPath: string) {
    teamLead.set(teamName, leadSessionId);
    if (teamWatched.has(teamName)) return;
    try {
      const w = chokidar.watch(configPath, { ignoreInitial: true });
      const ping = () => broadcast({ event: 'team', teamName, leadSessionId: teamLead.get(teamName) ?? leadSessionId });
      w.on('add', ping);
      w.on('change', ping);
      w.on('unlink', () => {
        ping(); // one final event: the roster panel refetches and sees the team is gone
        teamWatched.delete(teamName);
        teamLead.delete(teamName);
        void w.close().catch(() => {});
      });
      teamWatched.set(teamName, w);
    } catch {
      /* watching unavailable — /api/teams/members still works via manual refetch */
    }
  }

  // ── MCP approval (plan 16.7): broadcast an approval request to the UI and await
  //    its correlated reply. lead-data's approval listener injects requestApproval
  //    as its onRequest; the UI POSTs {requestId, approved} to resolveApproval.
  //    FAIL-CLOSED: the listener owns the 120s timeout → deny; this only resolves
  //    on an explicit UI reply. A pending request left by a server restart simply
  //    never resolves here — the listener's timeout denies it (retryable call).
  const pendingApprovals = new Map<string, (approved: boolean) => void>();
  function requestApproval(info: {
    requestId: string;
    tool: string;
    question: string;
    cwd: string;
    hop: number;
    expiresAt: number;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      pendingApprovals.set(info.requestId, resolve);
      // Broadcast carries expiresAt so the UI toast can show a countdown +
      // auto-dismiss. The listener still owns the hard 120s deny.
      broadcast({ event: 'approval', ...info });
      // Self-expire at expiresAt so a late UI approve can't find a stale entry
      // and report false "approved" for a request the listener already denied.
      const ttl = Math.max(0, info.expiresAt - Date.now());
      const expiry = setTimeout(() => {
        if (pendingApprovals.get(info.requestId) === resolve) {
          pendingApprovals.delete(info.requestId);
          resolve(false); // self-expire matches the listener's timeout deny
        }
      }, ttl);
      if (typeof expiry.unref === 'function') expiry.unref();
    });
  }
  function resolveApproval(requestId: string, approved: boolean): boolean {
    const r = pendingApprovals.get(requestId);
    if (!r) return false; // unknown / already resolved / timed out
    pendingApprovals.delete(requestId);
    r(approved);
    return true;
  }

  function broadcastRestarting() {
    broadcast({ event: 'server-restarting' });
  }

  async function close() {
    closing = true;
    clearInterval(timer);
    clearInterval(watcherSweep);
    if (watcher) await watcher.close().catch(() => {});
    if (statusWatcher) await statusWatcher.close().catch(() => {});
    for (const w of scratchpadWatched.values()) await w.close().catch(() => {});
    scratchpadWatched.clear();
    scratchpadTouched.clear();
    for (const t of subagentDebounce.values()) clearTimeout(t);
    subagentDebounce.clear();
    for (const w of subagentWatched.values()) await w.close().catch(() => {});
    subagentWatched.clear();
    subagentTouched.clear();
    for (const w of teamWatched.values()) await w.close().catch(() => {});
    teamWatched.clear();
    if (monitor) monitor.close();
    for (const ws of subscribers) if (ws.readyState === ws.OPEN) ws.close();
    subscribers.clear();
    explainByPty.clear();
    for (const list of statusWaiters.values()) {
      for (const w of list) {
        clearTimeout(w.timer);
        w.resolve({ status: 'timeout' });
      }
    }
    statusWaiters.clear();
  }

  function getStatusExplain(ptyId: string): StatusExplain | null {
    return explainByPty.get(ptyId) ?? null;
  }

  return {
    addClient,
    trackPty,
    getStatusExplain,
    watchScratchpad,
    watchSubagents,
    watchTeam,
    sweepIdleWatchers,
    emit: (event) => broadcast(event),
    requestApproval,
    resolveApproval,
    waitForStatus,
    broadcastRestarting,
    close,
  };
}

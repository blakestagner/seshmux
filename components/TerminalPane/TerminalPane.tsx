'use client';
// Embedded terminal: xterm.js bound to a daemon PTY over /ws/term/:ptyId.
// xterm touches window/DOM, so this component is client-only and imports xterm
// dynamically inside useEffect (never at module scope — SSR would crash).
//
// Statusbar composes primitives (StatusDot, ProviderBadge, BranchLabel, MeterBar,
// CtxBadge) per mockup .term-statusbar. Live status/ctx feeds arrive in the
// events-ws wave (Tasks 15/16); until then status is driven by the socket
// lifecycle (live → done on exit).

import { useEffect, useRef, useState } from 'react';
// xterm's stylesheet — a static CSS side-effect import. Next handles CSS at
// build time (not executed as JS), so this is SSR-safe even in a client
// component; the xterm JS itself is still dynamically imported below.
import '@xterm/xterm/css/xterm.css';
import type { ProviderId } from '../../lib/client/types';
import { openTermSocket, type TermSocket } from '../../lib/client/ws-term';
import {
  bridgeHandoff,
  bridgeReview,
  getTermHistory,
  listWorkspaces,
  listWorkspacesShared,
  finishWorkspace,
  getSubagents,
  getGitChanges,
  type BridgeStart,
  type WorkspaceRecord,
  type WorkspaceFinishMode,
} from '../../lib/client/api';
import { useAppState } from '../../lib/client/store';
import { useDetectedProviders, bridgeTarget } from '../../lib/client/providers';
import { retryRepaintUntilReady } from '../../lib/client/repaint-retry';
import StatusDot from '../ui/StatusDot/StatusDot';
import ProviderBadge, { PROV } from '../ui/ProviderBadge/ProviderBadge';
import BranchLabel from '../ui/BranchLabel/BranchLabel';
import MeterBar from '../ui/MeterBar/MeterBar';
import CtxBadge from '../ui/CtxBadge/CtxBadge';
import Button from '../ui/Button/Button';
import BridgeMenu from '../BridgeMenu/BridgeMenu';
import { PrChip, useSessionPrs } from '../PrLinks/PrLinks';
import WorkspaceFinishPrompt from '../WorkspaceFinishPrompt/WorkspaceFinishPrompt';
import styles from './TerminalPane.module.scss';

export type TerminalPaneProps = {
  ptyId: string;
  // Bridge (handoff/review) targets a source session by project+sessionId. Only
  // resumed term tabs carry a sessionId (fresh spawns / bridge tabs don't), so
  // the bridge buttons hide when sessionId is absent.
  projectId?: string;
  sessionId?: string;
  provider?: ProviderId;
  branch?: string | null;
  tmuxName?: string | null;
  ctx?: { tokens: number; window: number } | null;
  // 'grid' = compact tile footer (live · provider · detach-safe); the grid tile
  // header already shows branch/ctx, so the footer stays minimal there.
  // Default (single-pane) keeps the rich statusbar (branch + ctx meter).
  variant?: 'default' | 'grid';
  // Clicking the `◦ N agents` chip opens the subagent viewer beside this terminal
  // (page.tsx owns the split). Absent → no chip (grid tiles, panes with no session).
  onOpenSubagents?: () => void;
  // Bumped by page.tsx when a {event:'subagents'} ping lands for this session, so the
  // chip's lazy poll re-runs live (not only on mount/focus).
  subagentPing?: number;
  // Teams v1.1: tmux teammateMode already tiles teammates INSIDE this terminal, so the
  // TeamPanel split is opt-in via this chip instead of auto-showing (mirrors the
  // subagent chip above, but toggles open/closed rather than open-only).
  isTeamLead?: boolean;
  teamMemberCount?: number;
  onOpenTeam?: () => void;
  // Clicking the +N/-N diff chip opens the changes panel beside this terminal
  // (page.tsx owns the split, same slot as the subagent viewer). Absent (grid
  // tiles) → the stats render as a plain non-clickable span.
  onOpenChanges?: () => void;
  // Clicking the `>_` chip opens (idempotently spawns) a scratch shell in this
  // session's cwd, in the right-pane tab strip. Absent → no chip (grid tiles,
  // and the scratch pane's own TerminalPane, which passes no owner context).
  onOpenTerminal?: () => void;
  // Right-pane tab strip visibility (scratch-terminal edge G): the keepMounted
  // scratch panel stays in the tree but hidden (display:none) when another tab
  // is active. Flipping this back to true re-fits xterm on the next frame, since
  // a tab switch neither resizes the container (RO stays silent) nor changes
  // state.view (the other reassert trigger). Default true → agent panes unaffected.
  visible?: boolean;
};

// Aperture terminal theme — values from tokens.scss --term-* / --accent.
// (xterm needs a JS theme object; we mirror the token values here.)
function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export default function TerminalPane({
  ptyId,
  projectId,
  sessionId,
  provider,
  branch,
  tmuxName,
  ctx,
  variant = 'default',
  onOpenSubagents,
  subagentPing,
  isTeamLead,
  teamMemberCount,
  onOpenTeam,
  onOpenChanges,
  onOpenTerminal,
  visible = true,
}: TerminalPaneProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'live' | 'done'>('live');
  // True from mount until the first content paints (snapshot backfill or the
  // first live chunk, whichever wins) — drives the connecting overlay.
  const [connecting, setConnecting] = useState(true);
  const { state, dispatch } = useAppState();
  const [bridging, setBridging] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  // Escape hatch for the view-switch effect below: the main effect stores its
  // pushSize closure here so size can be reasserted from outside it.
  const pushSizeRef = useRef<(() => void) | null>(null);

  // Reassert PTY size on EVERY tabs⇄grid⇄(future views) switch — panes that
  // survive a switch (or whose container math lands on the same px width)
  // won't fire the ResizeObserver, and a PTY shrunk by another client stays
  // narrow until poked. rAF lets the new layout settle before fitting.
  useEffect(() => {
    requestAnimationFrame(() => pushSizeRef.current?.());
  }, [state.view]);

  // Fit-on-reveal (scratch-terminal edge G): a right-pane tab switch un-hides
  // this pane without resizing its container (RO silent) or touching state.view,
  // so xterm keeps its stale geometry — MIN_FIT_COLS froze it while display:none.
  // Reassert size on the next frame once the reveal has laid out. No-op for
  // always-visible agent panes (visible defaults true and never flips).
  useEffect(() => {
    if (visible) requestAnimationFrame(() => pushSizeRef.current?.());
  }, [visible]);

  useEffect(() => {
    let disposed = false;
    let term: import('@xterm/xterm').Terminal | null = null;
    let fit: import('@xterm/addon-fit').FitAddon | null = null;
    let socket: TermSocket | null = null;
    let ro: ResizeObserver | null = null;
    let roTimer: ReturnType<typeof setTimeout> | null = null;
    let onFocus: (() => void) | null = null;
    let themeObserver: MutationObserver | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed || !mountRef.current) return;

      term = new Terminal({
        fontFamily: readVar('--mono', 'monospace'),
        fontSize: 12,
        theme: {
          background: readVar('--term-bg', '#0a0d11'),
          foreground: readVar('--term-text', '#c9d3dc'),
          cursor: readVar('--accent', '#2dd4bf'),
        },
        cursorBlink: true,
        scrollback: 5000,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(mountRef.current);

      // ATTACH FLOW (no raw replay — see ws-term.ts replay=0): raw ring bytes
      // are recorded at whatever widths the pane historically had, and painting
      // them into a differently-sized pane is what garbled every reattach. The
      // socket attaches SILENT; we resize tmux to OUR width first, then paint
      // ONE atomic width-correct capture-pane snapshot (the daemon's history
      // RPC), then WINCH tmux into repainting the live screen below it. Live
      // output streams on top from there — one width, no reset races.
      let ptyCols = 0;
      let backfillTimer: ReturnType<typeof setTimeout> | null = null;
      // True once the pane has provably painted (data frame, backfill success,
      // or the degrade path settled). Until then, any resize that lands must
      // also request a backfill: onSize's one-shot trigger can lose the race
      // against a 0×0 grid mount, and without this the pane sits on
      // "connecting…" with a healthy socket until something else repaints it.
      let backfillDone = false;

      // Fit the LOCAL xterm only when the container proposes sane dimensions.
      // A bare fit.fit() on a 0×0/hidden mount (grid panels render hidden
      // until GridView measures its workspace) shrinks the local xterm to
      // ~2 cols — the PTY guard below stops that reaching tmux, but any LIVE
      // output streaming in during that window hard-wraps at 2 cols into the
      // local scrollback and never reflows (the "shredded" scrollback bug).
      // Keeping the previous geometry while degenerate means incoming bytes
      // keep wrapping at the last real width.
      //
      // The floor is 24×3, not 10×3: fits that pass this gate get pushed to
      // the SHARED PTY (one tmux session feeds every view of this session),
      // and a momentarily ~100px pane at 12 cols is enough to shred every
      // other view's history one word per line (observed: tmux history with
      // the banner wrapped 1 char/row). Below 24 cols nothing is readable
      // anyway — freezing at the last real width is strictly better than
      // propagating it.
      const MIN_FIT_COLS = 24;
      const safeFit = (): boolean => {
        if (disposed || !fit || !term) return false;
        try {
          const dims = fit.proposeDimensions();
          if (!dims || !Number.isFinite(dims.cols) || dims.cols < MIN_FIT_COLS || dims.rows < 3) return false;
          fit.fit();
          return true;
        } catch {
          return false; // transient fit errors during teardown
        }
      };

      // Sanity-gated resize: never propagate teardown/zero-size fits (a
      // disposing grid pane firing its ResizeObserver once more must not
      // shrink the shared PTY under the pane that replaced it).
      const pushSize = () => {
        if (disposed || !fit || !term || !socket) return;
        if (!safeFit()) return;
        if (term.cols >= 10 && term.rows >= 3) {
          socket.resize(term.cols, term.rows);
          if (!backfillDone) scheduleBackfill();
        }
      };

      // Force tmux to repaint the current screen even if it's already at our
      // size (rows-1 → rows WINCH dance).
      const forceRepaint = () => {
        if (disposed || !term || !socket) return;
        if (term.cols < 10) return;
        socket.resize(term.cols, Math.max(2, term.rows - 1));
        socket.resize(term.cols, term.rows);
        ptyCols = term.cols;
      };

      // Paint history + live screen. RIS ('\x1bc') goes through the WRITE
      // QUEUE (never term.reset()) so bytes already queued can't paint after
      // the wipe. History failure (older daemon, tmux gone) degrades to just
      // the repaint — live screen only, still clean.
      const backfill = async () => {
        if (disposed || !term || !socket) return;
        // DEGRADE path (daemon predating the history RPC → 200 supported:false,
        // or a real failure): we just wiped the pane with NO data. If the initial
        // fit hasn't settled (cols<10) forceRepaint no-ops — retry until it's
        // paintable (or give up bounded) instead of clearing the overlay over a
        // permanently blank pane.
        const degrade = () => {
          if (disposed || !term) return;
          term.write('\x1bc');
          retryRepaintUntilReady(
            () => (disposed || !term ? 0 : term.cols),
            forceRepaint,
            () => {
              backfillDone = true;
              if (!disposed) setConnecting(false);
            },
            (cb) => requestAnimationFrame(cb),
          );
        };
        try {
          const { supported, data } = await getTermHistory(ptyId);
          if (disposed || !term || !socket) return;
          if (!supported) return degrade(); // expected on an old daemon — silent, no error
          term.write('\x1bc' + (data ? data + '\r\n' : ''));
          // SUCCESS path — unchanged: history painted data regardless of
          // repaint outcome, so forceRepaint's cols<10 no-op was never
          // observable here.
          forceRepaint();
          backfillDone = true;
          if (!disposed) setConnecting(false);
        } catch {
          degrade();
        }
      };

      // Debounced trigger: resize must land in tmux (and tmux rewrap) before
      // the capture, or the snapshot comes back at the OLD width.
      const scheduleBackfill = () => {
        if (backfillTimer) clearTimeout(backfillTimer);
        backfillTimer = setTimeout(() => {
          backfillTimer = null;
          if (!disposed) void backfill();
        }, 200);
      };

      // Defer the first fit to the next frame: run synchronously here the mount
      // may not have its final flex size yet, so cols/rows come out wrong and the
      // agent TUI paints squished. rAF lets layout settle first. The PTY resize
      // itself waits for the server's size frame (onSize) — see below.
      requestAnimationFrame(() => {
        safeFit(); // no-op if the mount isn't laid out yet
      });

      // Fallback for a server that never sends the size frame: just push our
      // size once the socket has been open a beat.
      let sizeFallback: ReturnType<typeof setTimeout> | null = null;

      socket = openTermSocket(ptyId, {
        onData: (data) => {
          term?.write(data);
          backfillDone = true;
          if (!disposed) setConnecting(false); // content on screen — overlay off
        },
        onSize: (cols) => {
          ptyCols = cols;
          if (sizeFallback) clearTimeout(sizeFallback);
          if (disposed || !fit || !term || !socket) return;
          if (!safeFit()) {
            // Mount not laid out yet (grid mounts N panes at once — this pane
            // can still measure 0 wide when the size frame lands). This is the
            // ONLY trigger for the initial backfill, so a bare return leaves
            // the pane stuck on "connecting…" forever (BUG B's unpatched
            // success-path twin). Poll until fit yields a paintable width,
            // then run the same resize+backfill; bounded so a genuinely
            // hidden pane gives up without wedging the overlay.
            retryRepaintUntilReady(
              () => (safeFit() && term ? term.cols : 0),
              () => {
                if (disposed || !term || !socket) return;
                socket.resize(term.cols, term.rows);
                scheduleBackfill();
              },
              () => {
                if (!disposed) setConnecting(false);
              },
              (cb) => requestAnimationFrame(cb),
            );
            return;
          }
          // Resize tmux to OUR width immediately — all live output from here
          // on is correct-width — then paint the atomic snapshot once tmux
          // has rewrapped (scheduleBackfill's small delay).
          socket.resize(term.cols, term.rows);
          scheduleBackfill();
        },
        onExit: () => {
          if (!disposed) {
            setStatus('done');
            setConnecting(false);
          }
        },
        onOpen: () => {
          if (sizeFallback) clearTimeout(sizeFallback);
          sizeFallback = setTimeout(() => {
            if (!ptyCols) {
              // No size frame (older server) — assert our size and backfill anyway.
              pushSize();
              scheduleBackfill();
            }
          }, 500);
        },
        onReconnect: () => {
          // Server restarted (Task 18) — PTY still alive, attach was silent
          // (replay=0). Re-run the same resize→snapshot flow.
          if (!disposed) setStatus('live');
          pushSize();
          scheduleBackfill();
        },
      });

      term.onData((data) => socket?.send(data));

      // Resize xterm to its container and tell the PTY.
      // RO fires per animation frame during a seam drag (grid workspace) — debounce
      // the PTY resize RPC so the daemon isn't resized 60×/s; trailing call lands
      // the final size. One-shot reassert paths (focus/reconnect) stay immediate.
      ro = new ResizeObserver(() => {
        if (roTimer) clearTimeout(roTimer);
        roTimer = setTimeout(() => pushSize(), 120);
      });
      ro.observe(mountRef.current);

      // Reassert our size on window focus: another client (second browser
      // window, grid pane) may have resized the shared PTY smaller while this
      // pane sat unchanged — the container never resizes, so the ResizeObserver
      // stays silent and the terminal paints narrow until the user pokes it.
      // Live theme/accent toggle (BUG-5): xterm's theme is read once at
      // creation and never told about data-theme/data-accent flipping on
      // <html> afterward — re-read the same CSS vars and reassign on change.
      themeObserver = new MutationObserver(() => {
        if (disposed || !term) return;
        term.options.theme = {
          background: readVar('--term-bg', '#0a0d11'),
          foreground: readVar('--term-text', '#c9d3dc'),
          cursor: readVar('--accent', '#2dd4bf'),
        };
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-accent'],
      });

      onFocus = () => pushSize();
      window.addEventListener('focus', onFocus);
      // …and on clicking INTO the terminal (focusin bubbles from xterm's
      // textarea): window-focus alone misses the departed-client case where
      // the window never blurred — the PTY stays narrow until a remount.
      mountRef.current.addEventListener('focusin', onFocus);
      pushSizeRef.current = pushSize;
    })();

    return () => {
      disposed = true;
      pushSizeRef.current = null;
      if (roTimer) clearTimeout(roTimer);
      ro?.disconnect();
      themeObserver?.disconnect();
      if (onFocus) {
        window.removeEventListener('focus', onFocus);
        mountRef.current?.removeEventListener('focusin', onFocus);
      }
      socket?.close();
      term?.dispose();
    };
    // (backfill/fallback timers guard on `disposed`, so firing post-unmount is harmless)
  }, [ptyId]);

  const pct = ctx && ctx.window ? Math.round((ctx.tokens / ctx.window) * 100) : null;

  // Bridge needs a source session. Tabs that don't know their own sessionId
  // (fresh spawns, rehydrated PTYs) send the 'latest' sentinel — the server
  // resolves it to the project's newest session, which is this live one in
  // the common case. Require a REAL matched project (rehydrated PTYs can carry
  // a raw-cwd fallback projectId that no session store knows → guaranteed 404).
  const project = state.projects.find((p) => p.id === projectId);
  const bridgeSessionId = sessionId ?? 'latest';
  // Bridge targets the opposite DETECTED provider (mirrors Transcript). Label flips
  // by source provider — from a codex session the buttons say ✳ claude. No other
  // provider on this machine → no bridge actions at all.
  const sourceProvider: ProviderId = provider ?? project?.provider ?? 'claude';
  const otherProvider = bridgeTarget(sourceProvider, useDetectedProviders());
  const other = otherProvider ? PROV[otherProvider] : null;
  const canBridge = !!project && !!other;

  // Workspace chip + finish flow (Spec 1). Record lookup (dir + dirty count) is
  // by branch match against the project's worktree list; polled lazily (mount +
  // window focus), not on every keystroke.
  //
  // The gate used to be `branch.startsWith('agent/')` — seshmux's own naming
  // convention. That made every worktree created outside seshmux (an agent
  // running `git worktree add`, or the user by hand) invisible here. The list
  // now comes from git itself, so ask for any branch and let the match decide;
  // a plain main-repo session simply finds nothing and shows no chip.
  const isWorkspace = !!branch;
  const [wsRecord, setWsRecord] = useState<WorkspaceRecord | null>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  const [finishBusy, setFinishBusy] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  // Shared fetch: dirty count MUST be current at the moment the user commits to
  // an action (not just on a lazy mount/focus poll), or the finish prompt's
  // typed-confirm gate can key off a stale (too-low) count and let a discard
  // through unconfirmed. Returns the fresh record so callers can act on it
  // immediately instead of racing React state.
  async function refreshWsRecord(): Promise<WorkspaceRecord | null> {
    if (!isWorkspace || !projectId) return null;
    try {
      const records = await listWorkspaces(projectId);
      const rec = records.find((r) => r.branch === branch) ?? null;
      setWsRecord(rec);
      return rec;
    } catch {
      return null; // best-effort chip data; terminal stays usable without it
    }
  }

  useEffect(() => {
    if (!isWorkspace || !projectId) return;
    let cancelled = false;
    const refresh = () => {
      listWorkspacesShared(projectId)
        .then((records) => {
          if (cancelled) return;
          setWsRecord(records.find((r) => r.branch === branch) ?? null);
        })
        .catch(() => {
          /* best-effort chip data; terminal stays usable without it */
        });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refresh);
    };
    // isWorkspace is derived from branch every render — including it as a dep
    // alongside branch would be redundant, not stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWorkspace, projectId, branch]);

  // Subagent chip: `◦ N agents` when this session spawned any subagents. N = running
  // count while a run is live, else the total. Polled lazily (mount + window focus, like
  // the workspace chip) plus on each {event:'subagents'} ping (subagentPing). Absent for
  // sessions with an empty tree — zero noise. Only a session-bearing default pane can open
  // the viewer, so gate the whole thing on a resolvable session + the open callback.
  const canShowSubagents = variant !== 'grid' && !!onOpenSubagents && !!projectId && !!sessionId;
  const [subagentCount, setSubagentCount] = useState<{ running: number; total: number }>({
    running: 0,
    total: 0,
  });
  useEffect(() => {
    if (!canShowSubagents || !projectId || !sessionId) return;
    let cancelled = false;
    const refresh = () => {
      getSubagents(projectId, sessionId)
        .then(({ nodes }) => {
          if (cancelled) return;
          setSubagentCount({
            running: nodes.filter((n) => n.status === 'running').length,
            total: nodes.length,
          });
        })
        .catch(() => {
          /* best-effort chip; terminal stays usable without it */
        });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refresh);
    };
  }, [canShowSubagents, projectId, sessionId, subagentPing]);
  const subagentChipCount = subagentCount.running || subagentCount.total;
  // Diff chip: +N/-N vs the repo's default branch (committed + dirty + untracked).
  // Polled while mounted — mounted == visible here (tabs view renders only the
  // active pane, grid renders every tile), so a tab switch remounts and fetches
  // fresh numbers immediately. Errors keep the last value; the bar never breaks.
  const [gitStats, setGitStats] = useState<{ added: number; removed: number; approx: boolean } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const refresh = () => {
      getGitChanges(projectId, branch)
        .then((res) => {
          // degraded = git failed server-side (index.lock contention etc) —
          // keep the last good numbers instead of blanking the chip.
          if (cancelled || res.degraded) return;
          setGitStats({
            added: res.added,
            removed: res.removed,
            approx: res.files.some((f) => f.approx),
          });
        })
        .catch(() => {
          /* best-effort chip; terminal stays usable without it */
        });
    };
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, branch]);
  // PRs created in this session (chip in the single-pane statusbar; grid tiles
  // stay minimal). Only session-bearing panes can resolve PRs.
  const prs = useSessionPrs(variant !== 'grid' ? projectId : undefined, sessionId);
  // Team chip: shown as soon as this tab is a team lead (isTeamLead resolves
  // synchronously on spawn — see store.ts), no fetch of its own. The member
  // count is best-effort — it only appears once the panel has been opened at
  // least once and its roster resolved (page.tsx lifts just the count, not
  // the fetch).
  const canShowTeam = variant !== 'grid' && !!isTeamLead && !!onOpenTeam;
  // Scratch-terminal chip: a generic `>_` glyph (rule 5 — no logo assets, but a
  // shell isn't provider-specific anyway). Only in the single-pane statusbar of
  // a session-bearing terminal (page.tsx gates onOpenTerminal on activeTab.ptyId).
  const canShowTerminal = variant !== 'grid' && !!onOpenTerminal;

  async function handleFinish(mode: WorkspaceFinishMode, force: boolean) {
    if (!wsRecord || finishBusy) return;
    setFinishBusy(true);
    setFinishError(null);
    try {
      await finishWorkspace(wsRecord.dir, mode, force);
      setFinishOpen(false);
      dispatch({ type: 'closeTab', id: 'term-' + ptyId });
    } catch (e) {
      // merge conflict etc — surfaced in the prompt, worktree/branch/record survive.
      setFinishError((e as Error).message || 'finish failed');
    } finally {
      setFinishBusy(false);
    }
  }

  async function runBridge(start: (p: string, s: string) => Promise<BridgeStart>) {
    if (!canBridge || bridging) return;
    setBridging(true);
    setBridgeError(null);
    try {
      const { ptyId: newPtyId, tabMeta, provider: target } = await start(projectId!, bridgeSessionId);
      // The server resolved 'latest' to a real session id (tabMeta.linkSrc).
      // Backfill it onto OUR tab so buildBlocks can pair source↔linked and
      // the tabs-view 50/50 split renders.
      const resolvedSrc = tabMeta.linkSrc ?? sessionId;
      if (!sessionId && resolvedSrc) {
        const ownTab = state.tabs.find((t) => t.kind === 'term' && t.ptyId === ptyId);
        if (ownTab) dispatch({ type: 'setTabSession', tabId: ownTab.id, sessionId: resolvedSrc });
      }
      dispatch({
        type: 'openTerm',
        ptyId: newPtyId,
        projectId: projectId!,
        label: project?.name ?? tabMeta.projectPath.split('/').filter(Boolean).pop() ?? 'session',
        provider: target,
        linked: tabMeta.linked ?? true,
        linkedKind: tabMeta.linkedKind,
        // Server resolved 'latest' to a real id — tabMeta.linkSrc carries it.
        linkSrc: resolvedSrc,
      });
    } catch (e) {
      // No dedicated error area in the statusbar — surface via the buttons' title
      // attr (console.error alone isn't enough per the task).
      setBridgeError((e as Error).message || 'bridge failed');
      console.error('bridge failed', e);
    } finally {
      setBridging(false);
    }
  }

  // Once this session already has a handoff pair, hide "Continue in …" (the
  // pair IS the continuation — the split shows it); Review stays available.
  const hasHandoff = state.tabs.some(
    (t) => t.linked && t.linkedKind === 'handoff' && !!sessionId && t.linkSrc === sessionId,
  );

  // Bridge actions collapsed into one dropdown shared by both statusbar
  // variants. Glyphs ⇄/⊙ match LinkChip handoff/review; label flips to the
  // opposite provider.
  const bridgeActions = canBridge ? (
    <span className={styles.bridge}>
      <BridgeMenu
        other={other}
        otherProvider={otherProvider!}
        hasHandoff={hasHandoff}
        disabled={bridging}
        title={bridgeError ?? undefined}
        variant="chip"
        className={styles.bridgeBtn}
        up
        onHandoff={() => runBridge(bridgeHandoff)}
        onReview={() => runBridge(bridgeReview)}
      />
    </span>
  ) : null;

  return (
    <div className={styles.pane}>
      <div className={styles.termWrap}>
        <div ref={mountRef} className={styles.term} />
        {connecting ? (
          <div className={styles.loading} aria-live="polite">
            <StatusDot status="live" size={7} pulse />
            <span>connecting…</span>
          </div>
        ) : null}
      </div>
      <div className={`${styles.statusbar} ${variant === 'grid' ? styles.grid : ''}`}>
        {/* Grid footer stays minimal: the tile HEADER already carries the provider
            icon + status dot, so repeat neither — only a dead PTY ("exited") is
            worth a footer flag there. Single-pane keeps the full state + badge. */}
        {variant !== 'grid' || status !== 'live' ? (
          <span className={styles.state}>
            {/* Single-pane statusbar dot pulses (design L160); the compact grid
                footer dot is static (design L205). */}
            <StatusDot status={status === 'live' ? 'live' : 'done'} size={7} pulse={variant !== 'grid'} />
            <span className={status === 'live' ? styles.live : styles.done}>
              {status === 'live' ? 'live' : 'exited'}
            </span>
          </span>
        ) : null}
        {provider && variant !== 'grid' ? <ProviderBadge provider={provider} withName /> : null}
        {/* Grid tiles show branch + ctx in the tile HEADER, so the footer stays
            minimal there. Single-pane keeps the rich statusbar. */}
        {variant !== 'grid' ? (
          <>
            {tmuxName ? <span className={styles.tmux}>tmux: {tmuxName}</span> : null}
            {/* mock's segment list omits branch (its data is model/cost/mode we
                don't have); branch IS real, so kept behind a divider. */}
            {branch ? (
              <>
                <span className={styles.divider} aria-hidden="true" />
                <BranchLabel branch={branch} />
              </>
            ) : null}
            {ctx && pct != null ? (
              <span className={styles.ctx}>
                <span className={styles.ctxLabel}>ctx</span>
                <span className={styles.meterSlot}>
                  <MeterBar pct={pct} tone="ctx" />
                </span>
                <CtxBadge tokens={ctx.tokens} window={ctx.window} />
              </span>
            ) : null}
          </>
        ) : null}
        {/* Subagent chip: only when this session spawned agents. Opens the viewer
            split beside the terminal. Count = running while live, else total. */}
        {canShowSubagents && subagentChipCount > 0 ? (
          <>
            <span className={styles.divider} aria-hidden="true" />
            <Button variant="chip" title="View subagents" onClick={() => onOpenSubagents?.()}>
              ◦ {subagentChipCount} agent{subagentChipCount === 1 ? '' : 's'}
            </Button>
          </>
        ) : null}
        {/* Team chip: opt-in TeamPanel split (tmux teammateMode already tiles
            teammates inside this terminal — see components/TerminalPane.tsx docstring). */}
        {canShowTeam ? (
          <>
            <span className={styles.divider} aria-hidden="true" />
            <Button variant="chip" title="View team roster" onClick={() => onOpenTeam?.()}>
              ⚑ {teamMemberCount != null ? `${teamMemberCount} ` : ''}team
            </Button>
          </>
        ) : null}
        {/* Diff stats: +N/-N vs the default branch. Clickable chip (opens the
            changes panel) in the single-pane statusbar; plain span in grid.
            Rendered even at +0/−0 — the chip is also the ONLY way into the file
            browser/search, which is just as useful on a clean branch. */}
        {gitStats ? (
          <>
            {variant !== 'grid' ? <span className={styles.divider} aria-hidden="true" /> : null}
            {(() => {
              // approx: an untracked file's count was size-capped — the total
              // is a lower bound, say so with a trailing +.
              const stats = (
                <>
                  <span className={styles.diffAdded}>
                    +{gitStats.added}
                    {gitStats.approx ? '+' : ''}
                  </span>
                  <span className={styles.diffRemoved}>−{gitStats.removed}</span>
                </>
              );
              return variant !== 'grid' && onOpenChanges ? (
                <Button
                  variant="chip"
                  className={styles.diffChip}
                  title="Browse and search files"
                  onClick={onOpenChanges}
                >
                  {/* Generic file glyph (hard rule 5) — signals the chip opens something. */}
                  <span className={styles.diffChipGlyph} aria-hidden="true">
                    ▤
                  </span>
                  {stats}
                </Button>
              ) : (
                <span className={styles.diffChip}>{stats}</span>
              );
            })()}
          </>
        ) : null}
        {/* Scratch terminal chip: opens a plain shell in this session's cwd in
            the right-pane tab strip (page.tsx owns spawn + panel). Generic glyph. */}
        {canShowTerminal ? (
          <>
            <span className={styles.divider} aria-hidden="true" />
            <Button variant="chip" title="Open scratch terminal" onClick={() => onOpenTerminal?.()}>
              {'>_'}
            </Button>
          </>
        ) : null}
        {/* PRs created in this session: 1 = direct-open chip, >1 = dropdown. */}
        {variant !== 'grid' && prs.length > 0 ? (
          <>
            <span className={styles.divider} aria-hidden="true" />
            <PrChip prs={prs} />
          </>
        ) : null}
        {/* Bridge actions cluster on the right, before the tail. In grid the
            two buttons collapse to glyph + provider via CSS. */}
        {bridgeActions}
        {/* Gated on the RECORD, not on `isWorkspace`: that's now true for any
            branch (see above), so an ordinary main-repo session would otherwise
            label itself "workspace · master". A match means git really does
            report this branch as a worktree of the project. */}
        {wsRecord ? (
          <span className={styles.tail}>
            <span className={styles.workspaceTail}>
              {wsRecord.external ? 'worktree' : 'workspace'} · {branch}
              {wsRecord.external ? '' : ` · ${wsRecord.filesChanged} file${wsRecord.filesChanged === 1 ? '' : 's'} changed`}
            </span>
            <Button
              variant="chip"
              className={styles.finishBtn}
              disabled={wsRecord.external}
              title={
                wsRecord.external
                  ? 'Created outside seshmux — finish it with git, or from the session that made it'
                  : 'Finish workspace'
              }
              onClick={() => {
                // Freshen the dirty count right before the decision point —
                // the lazy mount/focus poll above is not enough to gate a
                // destructive discard safely.
                void refreshWsRecord().then(() => setFinishOpen(true));
              }}
            >
              ⌫
            </Button>
          </span>
        ) : null}
      </div>
      {wsRecord && !wsRecord.external ? (
        <WorkspaceFinishPrompt
          open={finishOpen}
          branch={branch ?? ''}
          filesChanged={wsRecord?.filesChanged ?? 0}
          busy={finishBusy}
          error={finishError}
          onFinish={handleFinish}
          onClose={() => {
            setFinishOpen(false);
            setFinishError(null);
          }}
        />
      ) : null}
    </div>
  );
}

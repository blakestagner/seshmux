'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AppStateProvider, useAppState, activePair, activeTeam, shouldMarkUnviewed, shouldShowRestoreBanner, findTabToBindSession, type Tab } from '../lib/client/store';
import { getProjects, getConfig, getEnv, getLive, notify, resolveApproval, putConfig, getTeamMembers, startScratchTerminal, killScratchTerminal, type SearchHit, type LiveSession } from '../lib/client/api';
import { openEventsSocket } from '../lib/client/ws';
import type { EventMessage } from '../lib/client/ws';
import TopNav from '../components/TopNav/TopNav';
import CustomizationsModal from '../components/CustomizationsModal/CustomizationsModal';
import Rail from '../components/Rail/Rail';
import Tabs from '../components/Tabs/Tabs';
import Transcript from '../components/Transcript/Transcript';
import Settings from '../components/Settings/Settings';
import Scratchpad from '../components/Scratchpad/Scratchpad';
import Planoff from '../components/Planoff/Planoff';
import Toast from '../components/Toast/Toast';
import RestoredBanner from '../components/RestoredBanner/RestoredBanner';
import ApprovalToast from '../components/ApprovalToast/ApprovalToast';
import TerminalPane from '../components/TerminalPane/TerminalPane';
import SubagentViewer from '../components/SubagentViewer/SubagentViewer';
import ChangesPanel from '../components/ChangesPanel/ChangesPanel';
import PortsPanel from '../components/PortsPanel/PortsPanel';
import GridView from '../components/GridView/GridView';
import AgentsView from '../components/AgentsView/AgentsView';
import TeamPanel from '../components/TeamPanel/TeamPanel';
import RightPane from '../components/RightPane/RightPane';
import ScratchTerminal from '../components/ScratchTerminal/ScratchTerminal';
import EmptyComposer from '../components/EmptyComposer/EmptyComposer';
import type { ProviderId } from '../lib/client/types';
import { DetectedProvidersProvider, providersFromEnv } from '../lib/client/providers';
import Card from '../components/ui/Card/Card';
import Button from '../components/ui/Button/Button';
import { clampSize, readPersistedSize, clampSplit } from '../lib/client/drag-resize';
import { persistDebounced } from '../lib/client/persist';
import { useDragResize } from '../lib/client/use-drag-resize';
import {
  openPanel,
  togglePanel,
  closePanel,
  pruneTab,
  resolveActive,
  routeScratchLive,
  terminalPanel,
  isTerminalPanel,
  panelPtyId,
  type PanelId,
  type RightPaneRecord,
} from '../lib/client/right-pane';
import styles from './page.module.scss';

// Right-pane tab labels (Stage 2). Insertion-ordered `open` drives strip order.
const PANEL_LABELS: Record<string, string> = {
  agents: 'Subagents',
  team: 'Team',
  changes: 'Folder',
  ports: 'Ports',
};

// Rail drag-resize bounds. MIN matches Rail.module.scss's fixed 288px (the
// pre-resize width) so the rail never gets smaller than it always was.
const RAIL_MIN = 288;
const RAIL_MAX = 560;
const RAIL_DEFAULT = 288;

// Term↔viewer split bounds (Task 2). Ratio (left fraction) persisted instead of
// px since the split's container width isn't known outside a resize.
const TERM_MIN = 360;
const VIEWER_MIN = 300;
const DEFAULT_RATIO = 0.5;

// Mirrors server/lib/detect.ts AgentEnv/detectEnv return shape (hard rule 3:
// client never imports server/ code, so this is an independent local mirror,
// same pattern as lib/client/types.ts mirroring server Project/SessionMeta).
type AgentEnv = { found: boolean; path?: string; version?: string; store: { found: boolean; projects: number; bytes: number } };
// `commands` keys = the providers the server actually detected (see lib/client/providers).
type EnvResponse = {
  claude: AgentEnv;
  codex: AgentEnv;
  tmux: { found: boolean };
  rg: { found: boolean };
  commands?: Record<string, unknown>;
};

function SetupGate({ onRescan }: { onRescan: () => void }) {
  return (
    <div className={styles.setupWrap}>
      <Card title="Set up seshmux">
        <div className={styles.setupBody}>
          <p className={styles.setupIntro}>
            No agent CLI was found on your PATH. Install Claude Code or Codex CLI, then rescan.
          </p>
          <div className={styles.installBlock}>{'npm install -g @anthropic-ai/claude-code'}</div>
          <div className={styles.installBlock}>{'npm install -g @openai/codex'}</div>
          <div className={styles.setupActions}>
            <Button variant="primary" onClick={onRescan}>
              Rescan
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function AppShell() {
  const { state, dispatch } = useAppState();
  const [jumpTo, setJumpTo] = useState<{ projectId: string; sessionId: string } | null>(null);
  // ALL currently-waiting sessions, oldest first — the toast aggregates them
  // ("2 sessions need input") and Jump walks the queue front-to-back.
  const [waitingToasts, setWaitingToasts] = useState<{ ptyId: string; repo: string }[]>([]);
  const [custOpen, setCustOpen] = useState<{ projectId?: string; projectName?: string } | null>(null);
  const [approval, setApproval] = useState<Extract<EventMessage, { event: 'approval' }> | null>(null);
  // Right-pane panel model (scratch-terminal Stage 2): a per-tab {open, active}
  // record (lib/client/right-pane.ts) replaces the three exclusive open*For
  // flags. Agents/team/changes now coexist as a tab strip instead of a single
  // mutually-exclusive slot; a per-session ping counter still drives the
  // subagent chip + open viewer's live refetch.
  const [rightPane, setRightPane] = useState<RightPaneRecord>({});
  // Scratch-terminal Stage 5: tabId → its scratch PTY ids (⌘T can open several).
  // Kept OUT of right-pane.ts
  // (the panel model stays panel-only) — the pane record just knows a 'terminal'
  // panel is open; this map holds which shell backs it. The server owns the
  // shell's lifetime (decision 2): tab dismissal drops this mapping without
  // killing, an explicit × kills, and owner-PTY exit kills server-side.
  const [scratchByTab, setScratchByTab] = useState<Record<string, string[]>>({});
  const [subagentPings, setSubagentPings] = useState<Record<string, number>>({});
  // Chip member count, keyed by leadSessionId (mirrors teamPings) — lifted from
  // TeamPanel's own roster fetch the FIRST time it resolves, so it only populates
  // once the panel has been opened at least once (no new fetch added).
  const [teamMemberCounts, setTeamMemberCounts] = useState<Record<string, number>>({});
  // Teams v1 (Task 6): teamPings (keyed by leadSessionId) bump on each {event:'team'} —
  // TeamPanel's refreshKey, mirroring subagentPings/SubagentViewer's refreshKey. touchPings
  // (keyed by sessionId) piggyback the EXISTING session-new/session-touch handling so
  // TeamPanel can refetch the currently-open member's transcript on its own jsonl growth
  // (Task 4's session-touch, not a bespoke poller).
  const [teamPings, setTeamPings] = useState<Record<string, number>>({});
  const [touchPings, setTouchPings] = useState<Record<string, number>>({});
  const [scratchpadPings, setScratchpadPings] = useState<Record<string, number>>({});
  // BUG-3: true from {event:'server-restarting'} until the first event after
  // auto-reconnect (the server replays events on reconnect, so the next
  // message proves the server is back) — no timer, no fake progress.
  const [restarting, setRestarting] = useState(false);
  // Startup auto-restore count (latched + replayed server-side). The banner is
  // gated on the opt-in `restoreNotice` setting at render; the event always flows.
  const [restoredCount, setRestoredCount] = useState(0);
  const activeTab = state.tabs.find((t) => t.id === state.activeTab);

  // Mirrors Rail's handleTogglePin: optimistic dispatch + persist. Lives here
  // (not in the modal) so the modal stays store-agnostic per Task 6/7.
  function handleToggleHidden(id: string) {
    dispatch({ type: 'toggleHidden', id });
    const hidden = state.config.hidden.includes(id)
      ? state.config.hidden.filter((x) => x !== id)
      : [...state.config.hidden, id];
    putConfig({ ...state.config, hidden });
  }
  // Tabs view only: when the active tab is one half of a bridge pair, render
  // both members side by side (source LEFT, linked RIGHT). Null → single pane.
  const pair = activePair(state.tabs, state.activeTab);
  // Teams v1 (Task 6): tabs view only, and only when there's no linked-pair split
  // active (a lead being both a bridge partner and a team lead simultaneously is an
  // edge case the pair-split wins for — team members aren't attachable as terminals
  // anyway, so there's nothing lost by the pair taking priority there).
  const team = pair ? null : activeTeam(state.tabs, state.activeTab);

  // Providers offered in the empty-pane composer: every provider seen across
  // projects (claude always present; codex only when its store was detected).
  const availableProviders: ProviderId[] = (() => {
    const seen = new Set<ProviderId>(state.projects.map((p) => p.provider));
    const list = (['claude', 'codex'] as ProviderId[]).filter((p) => seen.has(p));
    return list.length ? list : ['claude'];
  })();

  // Refs so the long-lived events-ws callback reads current tabs/config without
  // re-subscribing on every state change (which would drop replayed status).
  const tabsRef = useRef(state.tabs);
  tabsRef.current = state.tabs;
  // Same reason as tabsRef: the events-ws callback needs the CURRENT project
  // list to notice a session arriving for a project the rail has never seen.
  const projectsRef = useRef(state.projects);
  projectsRef.current = state.projects;
  const projectsRefetchRef = useRef(false);
  const notifyOnRef = useRef(true);
  notifyOnRef.current = state.config.settings?.macNotifications !== false;
  const notifyOnDoneRef = useRef(true);
  notifyOnDoneRef.current = state.config.settings?.notifyOnDone !== false;
  const activeTabRef = useRef(state.activeTab);
  activeTabRef.current = state.activeTab;
  // Spec 3: raw NIStatus per ptyId, tracked outside the reducer (the reducer
  // only ever sees the already-collapsed Tab['status'], which can't tell
  // working apart from idle) so a working→idle/waiting transition can be
  // detected here and turned into markUnviewed + the notify-on-done trigger.
  const prevNIRef = useRef<Record<string, 'working' | 'waiting' | 'idle'>>({});

  // Remember the view across reloads (UI preference → localStorage, same
  // posture as dismissed-ptys). Restored via dispatch AFTER mount (not in
  // initialState — reading localStorage during hydration would mismatch SSR),
  // which also fires TerminalPane's view-switch size reassert, so a reload
  // into grid view re-sizes every pane correctly.
  //
  // ONE effect owns read AND write: with a separate persist-effect, React
  // StrictMode's double-invoked mount ran the persist FIRST and clobbered the
  // saved value with the default before the restore read it (the "grid view
  // doesn't stick" bug). Here the restore run returns WITHOUT persisting; the
  // post-dispatch re-run persists the restored value.
  const viewLoadedRef = useRef(false);
  useEffect(() => {
    if (!viewLoadedRef.current) {
      viewLoadedRef.current = true;
      const saved = localStorage.getItem('seshmux-view');
      if ((saved === 'grid' || saved === 'tabs' || saved === 'agents') && saved !== state.view) {
        dispatch({ type: 'setView', view: saved });
        return;
      }
    }
    localStorage.setItem('seshmux-view', state.view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.view]);

  // Rail width: same SSR-safe read+write-in-one-effect pattern as the view
  // effect above (avoids the StrictMode double-mount clobber).
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT);
  const railLoadedRef = useRef(false);
  useEffect(() => {
    if (!railLoadedRef.current) {
      railLoadedRef.current = true;
      const saved = readPersistedSize(localStorage.getItem('seshmux-rail-width'), RAIL_MIN, RAIL_MAX, RAIL_DEFAULT);
      if (saved !== railWidth) {
        setRailWidth(saved);
        return;
      }
    }
    persistDebounced('seshmux-rail-width', String(railWidth));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railWidth]);

  // Drag start snapshots the pre-drag width; onDrag is a pure function of
  // that snapshot + delta (never of the latest railWidth, which would drift
  // under rAF-throttled updates).
  const railDragStartRef = useRef(RAIL_DEFAULT);
  const railDrag = useDragResize({
    onDragStart: () => {
      railDragStartRef.current = railWidth;
    },
    onDrag: (deltaX) => {
      setRailWidth(clampSize(railDragStartRef.current + deltaX, RAIL_MIN, RAIL_MAX));
    },
  });

  // Term↔viewer split ratio (Task 2): same SSR-safe read+write-in-one-effect
  // pattern as railWidth above. Stored as a RATIO (not px) since container
  // width is only known at drag time; clamp inline (not readPersistedSize,
  // which clamps px) to a sane band so a corrupt/extreme value can't hide a pane.
  const [viewerRatio, setViewerRatio] = useState(DEFAULT_RATIO);
  const viewerRatioLoadedRef = useRef(false);
  useEffect(() => {
    if (!viewerRatioLoadedRef.current) {
      viewerRatioLoadedRef.current = true;
      const raw = localStorage.getItem('seshmux-viewer-split');
      const n = raw == null ? NaN : Number(raw);
      const saved = Number.isFinite(n) ? clampSize(n, 0.15, 0.85) : DEFAULT_RATIO;
      if (saved !== viewerRatio) {
        setViewerRatio(saved);
        return;
      }
    }
    persistDebounced('seshmux-viewer-split', String(viewerRatio));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerRatio]);

  // Measured container width, refreshed at drag start (not on every render —
  // avoids a measure-render loop; see page.tsx Task 2 notes).
  const viewerSplitRef = useRef<HTMLDivElement | null>(null);
  const viewerContainerWidthRef = useRef(0);
  const viewerDragStartRatioRef = useRef(DEFAULT_RATIO);
  const viewerDrag = useDragResize({
    onDragStart: () => {
      viewerDragStartRatioRef.current = viewerRatio;
      viewerContainerWidthRef.current = viewerSplitRef.current?.getBoundingClientRect().width ?? 0;
    },
    onDrag: (deltaX) => {
      const w = viewerContainerWidthRef.current;
      if (!w) return;
      const startLeftPx = viewerDragStartRatioRef.current * w;
      const nextLeftPx = clampSplit(startLeftPx + deltaX, w, TERM_MIN, VIEWER_MIN);
      setViewerRatio(clampSize(nextLeftPx / w, 0.15, 0.85));
    },
  });

  // Remember the ACTIVE TAB across reloads the same way. Tab ids are stable
  // for live PTYs ('term-<ptyId>'), so the saved id survives a reload as long
  // as the session is still alive; restore happens after rehydrate re-opens
  // the term tabs (see the rehydrate effect below).
  const activeLoadedRef = useRef(false);
  useEffect(() => {
    if (!activeLoadedRef.current) return; // rehydrate owns the restore
    if (state.activeTab) localStorage.setItem('seshmux-active-tab', state.activeTab);
  }, [state.activeTab]);

  useEffect(() => {
    getConfig().then((config) => {
      dispatch({ type: 'setConfig', config });
      // Marks the store "hydrated" — GridView gates every disk PUT on this so
      // a term tab arriving before this resolves (tabs→config race) can't PUT
      // a preset built from the store DEFAULT config over the real
      // config.json. Deliberately NOT set inside the setConfig reducer arm:
      // GridView/Settings/Rail also dispatch setConfig for in-memory syncs,
      // and those must not fake "loaded".
      dispatch({ type: 'markConfigLoaded' });
    });

    // Tab rehydrate on load (acceptance item 3): the daemon holds live PTYs
    // across a page reload, so reopen a term tab per live PTY — openTerm is
    // ptyId-keyed, so TerminalPane's attach + scrollback replay just works.
    // Needs projects FIRST: the tab's projectId must be a real provider project
    // id (matched by cwd), not the raw path — bridge/session lookups key on it.
    // Tabs the user explicitly closed stay closed across reloads (the PTY is
    // still alive + in the rail; dismissal is a UI preference, localStorage).
    Promise.all([getProjects(), getLive().catch(() => ({ live: [] as LiveSession[] }))])
      .then(([projects, { live }]) => {
        dispatch({ type: 'setProjects', projects });
        let dismissed: string[] = [];
        try {
          dismissed = JSON.parse(localStorage.getItem('seshmux-dismissed-ptys') || '[]');
        } catch {
          /* corrupt entry → treat as none */
        }
        // Scratch shells never become their own tab — routeScratchLive splits them
        // out and maps each surviving one to its owner tab's right pane (matched by
        // ownerPtyId, or ownerTmuxName after a daemon-restart ptyId reassignment).
        const { agents, scratchByOwnerTab } = routeScratchLive(live);
        for (const s of agents) {
          if (dismissed.includes(s.ptyId)) continue;
          // Prefer the server-resolved owning project id: a worktree PTY's cwd never
          // equals any project.path (folded into the parent), so the path match alone
          // left the tab keyed on a raw cwd that no bridge/session lookup understands.
          const proj = projects.find((p) => p.id === s.projectId) ?? projects.find((p) => p.path === s.cwd);
          const label = proj?.name ?? s.cwd.split('/').filter(Boolean).pop() ?? 'session';
          dispatch({
            type: 'openTerm',
            ptyId: s.ptyId,
            projectId: proj?.id ?? s.projectId ?? s.cwd,
            label,
            provider: proj?.provider,
            sessionId: s.sessionId,
            branch: s.branch ?? null,
          });
          // Teams v1 (Task 6) reload case: a rehydrated live tab carries no
          // isTeamLead marker (getLive()'s LiveSession has no team field) — one-shot
          // check per rehydrated session so a reloaded team-lead tab re-arms its
          // roster panel instead of staying a plain terminal until the user resumes it.
          if (s.sessionId) {
            const tabId = 'term-' + s.ptyId;
            getTeamMembers(s.sessionId)
              .then((info) => info && dispatch({ type: 'setTabTeam', tabId, teamName: info.teamName }))
              .catch(() => {});
          }
        }
        // Re-attach each surviving scratch into its owner tab's right pane (open
        // + active), but only where the owner tab was actually opened above — a
        // dismissed owner keeps its shell alive server-side without re-showing it.
        for (const [tabId, scratchPtyIds] of Object.entries(scratchByOwnerTab)) {
          const ownerPtyId = tabId.slice('term-'.length);
          if (dismissed.includes(ownerPtyId)) continue;
          setScratchByTab((m) => ({ ...m, [tabId]: scratchPtyIds }));
          // One strip tab per surviving shell, in live order.
          for (const ptyId of scratchPtyIds) setRightPane((r) => openPanel(r, tabId, terminalPanel(ptyId)));
        }
        // Restore the pre-reload active tab (openTerm activated the LAST
        // rehydrated tab otherwise). Only if its PTY is still alive; then
        // enable persistence so this restore can't be clobbered (StrictMode
        // runs this whole effect twice — the ref survives both runs).
        const savedActive = localStorage.getItem('seshmux-active-tab');
        if (savedActive && live.some((s) => 'term-' + s.ptyId === savedActive && !dismissed.includes(s.ptyId))) {
          dispatch({ type: 'activateTab', id: savedActive });
        }
        activeLoadedRef.current = true;
      })
      .catch(() => {
        // No daemon / getProjects failed → nothing to rehydrate, but persistence
        // must still arm: leaving the ref false killed active-tab saving for the
        // whole session (next reload silently lost the active tab).
        activeLoadedRef.current = true;
      });

    // Live events: needs-input status → tab dots, ctx → statusbar meter. On every
    // (re)connect the server replays status for ALL live PTYs, so dots self-heal
    // after a server restart with no page reload.
    const WS_STATUS: Record<'working' | 'waiting' | 'idle', 'live' | 'waiting' | 'done'> = {
      working: 'live',
      waiting: 'waiting',
      idle: 'live',
    };
    const client = openEventsSocket(
      (e) => {
      setRestarting(e.event === 'server-restarting');
      switch (e.event) {
        case 'status': {
          dispatch({ type: 'setTermStatus', ptyId: e.ptyId, status: WS_STATUS[e.status], ni: e.status, ts: Date.now() });

          const tab = tabsRef.current.find((t) => t.kind === 'term' && t.ptyId === e.ptyId);
          const repo = tab?.label ?? 'A session';
          const prevNI = prevNIRef.current[e.ptyId];
          const isActiveTab = !!tab && tab.id === activeTabRef.current;
          // Spec 3: working → idle/waiting while not the focused tab = done-
          // unviewed. Client-side derived state only; no wire/NIStatus change.
          if (shouldMarkUnviewed(prevNI, e.status, isActiveTab, document.hidden)) {
            dispatch({ type: 'markUnviewed', ptyId: e.ptyId });
            if (e.status === 'idle' && document.hidden && notifyOnRef.current && notifyOnDoneRef.current) {
              notify(`${repo} finished`, 'The session finished and is waiting for you.').catch(() => {});
            }
          }
          prevNIRef.current[e.ptyId] = e.status;

          if (e.status === 'waiting') {
            setWaitingToasts((cur) =>
              cur.some((w) => w.ptyId === e.ptyId) ? cur : [...cur, { ptyId: e.ptyId, repo }],
            );
            // OS-level surface only when the tab is backgrounded; the server
            // decides delivery (darwin + config), so call unconditionally.
            if (document.hidden && notifyOnRef.current) {
              notify(`${repo} needs input`, 'A session is waiting for your input.').catch(() => {});
            }
          } else {
            // drop the session from the toast once it's no longer waiting
            setWaitingToasts((cur) => cur.filter((w) => w.ptyId !== e.ptyId));
          }
          break;
        }
        case 'ctx':
          dispatch({ type: 'setTermCtx', sessionId: e.sessionId, ctx: e.ctx });
          break;
        case 'restored':
          // Latched + replayed on every reconnect; the render gate + the banner's
          // own auto-dismiss handle showing it once (a re-replay after dismiss
          // re-shows — accepted, per plan).
          setRestoredCount(e.count);
          break;
        case 'approval':
          // MCP bridge cross-agent call awaiting approval — show the toast.
          setApproval(e);
          break;
        case 'subagents':
          // A session's subagent tree changed — bump its ping so the chip + any open
          // viewer refetch (ping-only; transcripts fetch on detail-open, not streamed).
          setSubagentPings((prev) => ({
            ...prev,
            [e.sessionId]: (prev[e.sessionId] ?? 0) + 1,
          }));
          break;
        // session-new/touch: also consumed by the rail. BUG A part 1 — bind the
        // matching unbound live term tab (fresh spawn has no sessionId until the
        // agent writes jsonl) so the subagent chip gate (canShowSubagents) is
        // satisfied without waiting for a reload. tabsRef (not state.tabs) so
        // this effect doesn't need to re-subscribe the socket on every tab change.
        case 'session-new':
        case 'session-touch': {
          const tabId = findTabToBindSession(tabsRef.current, e.projectId);
          if (tabId) dispatch({ type: 'setTabSession', tabId, sessionId: e.sessionId });
          // First session in a directory the rail doesn't know about (a folder
          // just made by "+ New project", or any repo an agent was started in
          // elsewhere) — a project only EXISTS once a session has been written
          // there, so this is the moment it becomes listable. Refetch the list
          // instead of making the user reload. Guarded so a burst of touches
          // on an unknown project fires one fetch, not one per event.
          if (!projectsRef.current.some((p) => p.id === e.projectId) && !projectsRefetchRef.current) {
            projectsRefetchRef.current = true;
            getProjects()
              .then((projects) => dispatch({ type: 'setProjects', projects }))
              .catch(() => {})
              .finally(() => {
                projectsRefetchRef.current = false;
              });
          }
          // Teams v1 (Task 6): a touched session's jsonl may be an open team member's
          // transcript growing — TeamPanel watches this map (keyed by sessionId) to
          // bump its Transcript's remount key, mirroring subagentPings above.
          setTouchPings((prev) => ({ ...prev, [e.sessionId]: (prev[e.sessionId] ?? 0) + 1 }));
          break;
        }
        // A team's config.json changed (member joined/finished) or the team ended
        // (unlink → one final ping then the hub disposes its watcher). Bump the
        // ping keyed by leadSessionId — the event carries it directly, so no tab
        // lookup is needed (mirrors the subagents ping pattern).
        case 'team':
          setTeamPings((prev) => ({ ...prev, [e.leadSessionId]: (prev[e.leadSessionId] ?? 0) + 1 }));
          break;
        case 'scratchpad':
          setScratchpadPings((prev) => ({ ...prev, [e.projectId]: (prev[e.projectId] ?? 0) + 1 }));
          break;
        // server-restarting is handled above (top of this callback), before the switch.
        default:
          break;
      }
      },
      // onOpen: with zero live PTYs a reconnect replays no events, so the
      // event-based reset above never fires and the banner stuck forever.
      () => setRestarting(false),
    );

    // A background BROWSER tab can mark the currently-active seshmux tab
    // unviewed (activateTab-clear alone can't catch that — the tab was never
    // re-activated, the browser just regained focus). Clear on return.
    function handleVisible() {
      if (document.hidden) return;
      const activeId = activeTabRef.current;
      if (activeId) dispatch({ type: 'activateTab', id: activeId });
    }
    document.addEventListener('visibilitychange', handleVisible);

    return () => {
      client.close();
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, [dispatch]);

  // closeTab is dispatched from Tabs.tsx and TerminalPane.handleFinish (not
  // routed through page.tsx), so prune the right-pane record via effect: any tab
  // that's no longer live loses its pane state, so reopening the same session
  // starts from a fresh record (edge D). Also drop the scratch mapping for that
  // tab — but deliberately do NOT kill the shell (decision 2: a tab dismissal is
  // a UI action, the agent PTY survives it and so does its scratch; the server
  // map still owns it, and reopening the owner tab + the chip re-adopts it via
  // the idempotent spawn route).
  useEffect(() => {
    const liveIds = new Set(state.tabs.map((t) => t.id));
    setRightPane((r) => {
      let next = r;
      for (const id of Object.keys(r)) if (!liveIds.has(id)) next = pruneTab(next, id);
      return next;
    });
    setScratchByTab((m) => {
      const stale = Object.keys(m).filter((id) => !liveIds.has(id));
      if (stale.length === 0) return m;
      const next = { ...m };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [state.tabs]);

  // Activate the OLDEST waiting session and pop it — the toast stays up with
  // the rest so repeated clicks chain through the queue. A vanished tab
  // (closed while waiting) just pops and the next click moves on.
  async function jumpToWaiting() {
    const next = waitingToasts[0];
    if (!next) return;
    // Agents view shows no terminals — always fall back to tabs so the jump lands.
    if (state.view === 'agents') dispatch({ type: 'setView', view: 'tabs' });
    const tab = state.tabs.find((t) => t.kind === 'term' && t.ptyId === next.ptyId);
    if (tab) {
      dispatch({ type: 'activateTab', id: tab.id }); // activateTab closes settings too
    } else {
      // No open TERMINAL for this waiting PTY — it was dismissed, is open only as a
      // read-only transcript, or a tmux-tier daemon restart reassigned its ptyId. Open
      // the live terminal from getLive() so Jump ALWAYS lands on what needs input,
      // instead of silently doing nothing.
      try {
        const { live } = await getLive();
        const s = live.find((l) => l.ptyId === next.ptyId);
        if (s) {
          // Un-dismiss so the reopened tab isn't immediately skipped on reload.
          try {
            const raw = localStorage.getItem('seshmux-dismissed-ptys');
            const dismissed: string[] = raw ? JSON.parse(raw) : [];
            if (dismissed.includes(next.ptyId)) {
              localStorage.setItem('seshmux-dismissed-ptys', JSON.stringify(dismissed.filter((x) => x !== next.ptyId)));
            }
          } catch {
            /* corrupt entry — ignore */
          }
          const proj = state.projects.find((p) => p.id === s.projectId || p.path === s.cwd);
          dispatch({
            type: 'openTerm',
            ptyId: s.ptyId,
            projectId: proj?.id ?? s.projectId ?? s.cwd,
            label: next.repo !== 'A session' ? next.repo : proj?.name ?? s.cwd.split('/').filter(Boolean).pop() ?? 'session',
            provider: proj?.provider,
            sessionId: s.sessionId,
            branch: s.branch ?? null,
          });
        }
      } catch {
        /* best-effort — worst case the toast just pops */
      }
    }
    setWaitingToasts((cur) => cur.filter((w) => w.ptyId !== next.ptyId));
  }

  function resolveApprovalToast(approved: boolean) {
    if (!approval) return;
    resolveApproval(approval.requestId, approved).catch(() => {}); // 404 = already expired
    setApproval(null);
  }

  // All four statusbar chips route here — each TOGGLES its panel in the tab
  // strip (decision 6: the subagent viewer was open-only before; clicking the
  // agents chip while it's active now closes it, the ONE sanctioned behavior
  // change). Panels coexist; toggling the active one collapses it.
  function handleTogglePanel(tabId: string, id: PanelId) {
    setRightPane((r) => togglePanel(r, tabId, id));
  }
  // A panel's own close button (× on the strip tab, or a panel header's close):
  // remove it from the pane, active falls back to the last remaining panel.
  // Closing the terminal panel is an EXPLICIT kill (one of the two sanctioned
  // kill triggers, decision 2): terminate the shell, drop its mapping, then
  // close the panel. Reopening the chip spawns a fresh shell (server map pruned).
  function handleClosePanel(tabId: string, id: PanelId) {
    if (isTerminalPanel(id)) {
      // Only THIS shell dies; the tab's other terminals are untouched.
      const ptyId = panelPtyId(id);
      if (ptyId) killScratchTerminal(ptyId).catch(() => {});
      setScratchByTab((m) => {
        const rest = (m[tabId] ?? []).filter((p) => p !== ptyId);
        if (rest.length === (m[tabId] ?? []).length) return m;
        const next = { ...m };
        if (rest.length) next[tabId] = rest;
        else delete next[tabId];
        return next;
      });
    }
    setRightPane((r) => closePanel(r, tabId, id));
  }

  // The `>_` chip / ⌘T / the strip's +: open a scratch shell for this tab.
  //
  // With NO shell open yet the spawn is the idempotent one, so reopening an
  // owner tab re-adopts the live shell the server still holds (decision 2's
  // reopen path). With one already open, every one of these adds ANOTHER —
  // the chip stopped being a toggle once a tab could hold several terminals.
  async function handleOpenTerminal(tab: Tab, fresh = false) {
    if (!tab.ptyId) return;
    const open = scratchByTab[tab.id] ?? [];
    const wantFresh = fresh || open.length > 0;
    try {
      const { ptyId } = await startScratchTerminal(tab.ptyId, wantFresh);
      setScratchByTab((m) => ({ ...m, [tab.id]: [...(m[tab.id] ?? []).filter((p) => p !== ptyId), ptyId] }));
      setRightPane((r) => openPanel(r, tab.id, terminalPanel(ptyId)));
    } catch (e) {
      // Fail closed (decision 1: gone cwd / owner missing → 400). No dedicated
      // error surface on the generic chip yet; log it (parity with a failed
      // bridge, which also only console.errors when its title has no room).
      console.error('scratch terminal failed', e);
    }
  }

  // ⌘T / Ctrl+T while a terminal panel is the active right-pane tab → another
  // shell. Scoped deliberately: anywhere else the browser's own new-tab keeps
  // working. Chrome reserves ⌘T at the browser level and will NOT hand it to a
  // page (it does reach us in an installed/standalone window) — the strip's +
  // button is the always-available path.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 't') return;
      const tab = state.tabs.find((t) => t.id === state.activeTab);
      const active = tab ? rightPane[tab.id]?.active : null;
      if (!tab?.ptyId || !active || !isTerminalPanel(active)) return;
      e.preventDefault();
      void handleOpenTerminal(tab, true);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Plain function (NOT a nested component) so key={tab.id} reconciliation is
  // preserved — a nested component type would remount both panes every render.
  // Every reference is parameterized on `tab`, never the closed-over activeTab,
  // so it renders correctly for either side of a split.
  function renderPane(tab: Tab) {
    // A rail session marked "live" (recent jsonl) that seshmux did NOT
    // spawn has no daemon PTY, so it opens as a term tab with no ptyId.
    // Fall back to the read-only transcript instead of a blank pane.
    if (
      (tab.kind === 'transcript' || (tab.kind === 'term' && !tab.ptyId)) &&
      tab.sessionId &&
      tab.projectId
    ) {
      return (
        <Transcript
          key={tab.id}
          projectId={tab.projectId}
          sessionId={tab.sessionId}
          title={tab.label}
          provider={tab.provider}
        />
      );
    }
    if (tab.kind === 'term' && tab.ptyId) {
      // The chip opens the viewer only for a session-bearing claude term tab. Codex has
      // no subagents capability (route returns []), so its chip never appears anyway.
      const canViewSubagents = !!tab.projectId && !!tab.sessionId && tab.provider !== 'codex';
      return (
        <TerminalPane
          key={tab.id}
          ptyId={tab.ptyId}
          projectId={tab.projectId}
          sessionId={tab.sessionId}
          provider={tab.provider}
          branch={tab.branch}
          ctx={tab.ctx}
          onOpenSubagents={canViewSubagents ? () => handleTogglePanel(tab.id, 'agents') : undefined}
          subagentPing={tab.sessionId ? subagentPings[tab.sessionId] : undefined}
          isTeamLead={tab.isTeamLead}
          teamMemberCount={tab.sessionId ? teamMemberCounts[tab.sessionId] : undefined}
          onOpenTeam={tab.isTeamLead ? () => handleTogglePanel(tab.id, 'team') : undefined}
          onOpenChanges={tab.projectId ? () => handleTogglePanel(tab.id, 'changes') : undefined}
          onOpenPorts={tab.projectId ? () => handleTogglePanel(tab.id, 'ports') : undefined}
          onOpenTerminal={tab.ptyId ? () => handleOpenTerminal(tab) : undefined}
        />
      );
    }
    if (tab.kind === 'scratchpad' && tab.projectId) {
      return (
        <Scratchpad key={tab.id} projectId={tab.projectId} path={tab.label} refreshKey={scratchpadPings[tab.projectId]} />
      );
    }
    if (tab.kind === 'planoff' && tab.projectId) {
      return (
        <Planoff
          key={tab.id}
          projectId={tab.projectId}
          repo={tab.label}
          sessionId={tab.sessionId}
          onExecute={(provider, ptyId) =>
            dispatch({
              type: 'openTerm',
              ptyId,
              projectId: tab.projectId!,
              label: tab.label,
              provider,
            })
          }
        />
      );
    }
    return (
      <div key={tab.id} className={styles.paneEmpty}>
        <div className={styles.mainPlaceholder}>{tab.label}</div>
      </div>
    );
  }

  function handlePickHit(hit: SearchHit) {
    setJumpTo({ projectId: hit.project, sessionId: hit.sessionId });
    dispatch({
      type: 'openSession',
      sessionId: hit.sessionId,
      projectId: hit.project,
      label: hit.title || 'untitled',
      kind: 'transcript',
      provider: hit.provider,
    });
  }

  return (
    <div className={styles.shell}>
      {restarting ? <div className={styles.restartBanner}>Updating — reconnecting…</div> : null}
      <TopNav onPickHit={handlePickHit} onOpenCustomizations={() => setCustOpen({})} />
      <div className={styles.app}>
        {/* Settings is a full-page overlay: hide the rail so it reads as its own
            page. Sibling of <main>, so gate it here. */}
        {state.settingsOpen ? null : (
          <>
            <Rail
              width={railWidth}
              jumpTo={jumpTo}
              onJumped={() => setJumpTo(null)}
              onOpenCustomizations={setCustOpen}
              onOpenGlobalCustomizations={() => setCustOpen({})}
            />
            <div
              className={styles.railHandle}
              onPointerDown={railDrag.onPointerDown}
              onDoubleClick={() => setRailWidth(RAIL_DEFAULT)}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
            />
          </>
        )}
        <main className={styles.main}>
          {/* Settings short-circuits BEFORE the grid/tabs branches — the grid
              branch used to win, so opening settings from grid rendered nothing.
              Full-page: no tab bar either. */}
          {state.settingsOpen ? (
            <div className={styles.pane}>
              <Settings />
            </div>
          ) : (
            <>
          {/* Tab strip hides in grid view — every tile carries its own header
              and the tabs⇄grid toggle lives in TopNav, so it's redundant there. */}
          {state.tabs.length > 0 && state.view === 'tabs' ? <Tabs /> : null}
          {/* Grid mode replaces the single-pane view over the same term-tab set. */}
          {state.view === 'grid' ? (
            <div className={styles.pane}>
              <GridView />
            </div>
          ) : state.view === 'agents' ? (
            <div className={styles.pane}>
              <AgentsView />
            </div>
          ) : pair ? (
            // Linked-pair split: source LEFT, linked RIGHT, 50/50. Both panes
            // render simultaneously (keyed by tab id) so flipping active between
            // the two members of the SAME pair never remounts either side.
            <div className={styles.split}>
              <div className={styles.splitSide}>{renderPane(pair.source)}</div>
              <div className={`${styles.splitSide} ${styles.splitSideRight}`}>
                {renderPane(pair.linked)}
              </div>
            </div>
          ) : activeTab && activeTab.kind === 'term' ? (
            // Term tabs ALWAYS render inside the split host so the terminal's tree
            // position (and its live xterm/PTY) never remounts when a right-pane
            // panel opens/closes — only the conditional RightPane mounts/unmounts.
            // The accent divider appears only WITH a right pane (splitSolo drops
            // it otherwise). Panels (agents/team/changes; terminal in Stage 5) now
            // coexist as a tab strip: the per-tab {open, active} record decides
            // what shows, gate-resolved every render so a panel whose gate fails
            // (team dissolves, session lost) falls through instead of blanking.
            (() => {
              // Gates mirror the previous per-panel open conditions exactly. `team`
              // is pair-gated above (null when a bridge pair is active), so this
              // branch only runs with no pair — same precedence as before.
              const openShells = scratchByTab[activeTab.id] ?? [];
              const gate = (id: PanelId): boolean => {
                // A terminal panel is gated on ITS shell still being mapped —
                // a killed/exited shell's tab disappears, its siblings stay.
                if (isTerminalPanel(id)) return !!activeTab.ptyId && openShells.includes(panelPtyId(id));
                switch (id) {
                  case 'agents':
                    return !!activeTab.sessionId && !!activeTab.projectId && activeTab.provider !== 'codex';
                  case 'team':
                    return !!team;
                  case 'changes':
                  case 'ports':
                    return !!activeTab.projectId;
                  default:
                    return false;
                }
              };
              const pane = rightPane[activeTab.id];
              const shown = resolveActive(pane, gate);
              const rightOpen = shown !== null;
              // Percentage flex-basis (not px) since container width is unknown at
              // render; min-width enforces TERM_MIN/VIEWER_MIN without measuring.
              // clampSize guards against a stored extreme hiding a pane on reload.
              const leftPct = clampSize(viewerRatio, 0.15, 0.85) * 100;
              // Strip tabs = open panels whose gate currently passes, insertion
              // order. A panel in `open` whose gate fails gets no tab while failed.
              // Terminals are numbered by their position among THIS tab's
              // terminal panels, so the labels read Terminal / Terminal 2 / …
              let termNo = 0;
              const stripTabs = (pane?.open ?? [])
                .filter(gate)
                .map((id) => ({
                  id,
                  label: isTerminalPanel(id) ? `Terminal${++termNo > 1 ? ` ${termNo}` : ''}` : PANEL_LABELS[id],
                  closable: isTerminalPanel(id),
                }));
              // Node per gated-open panel; only the active one actually mounts
              // (RightPane renders non-keepMounted panels only when active), so
              // ChangesPanel's poll / SubagentViewer's fetch keep today's semantics.
              const panelNode = (id: PanelId): ReactNode => {
                if (isTerminalPanel(id))
                  return <ScratchTerminal ptyId={panelPtyId(id)} visible={shown === id} />;
                switch (id) {
                  case 'agents':
                    return (
                      <SubagentViewer
                        projectId={activeTab.projectId!}
                        sessionId={activeTab.sessionId!}
                        refreshKey={subagentPings[activeTab.sessionId!]}
                        onClose={() => handleClosePanel(activeTab.id, 'agents')}
                      />
                    );
                  case 'team':
                    return (
                      <TeamPanel
                        leadSessionId={team!.leadSessionId}
                        projectId={team!.tab.projectId ?? ''}
                        refreshKey={teamPings[team!.leadSessionId]}
                        touchPings={touchPings}
                        onMembersResolved={(count) =>
                          setTeamMemberCounts((prev) => ({ ...prev, [team!.leadSessionId]: count }))
                        }
                      />
                    );
                  case 'changes':
                    return (
                      <ChangesPanel
                        projectId={activeTab.projectId!}
                        branch={activeTab.branch}
                        onClose={() => handleClosePanel(activeTab.id, 'changes')}
                      />
                    );
                  case 'ports':
                    return (
                      <PortsPanel
                        projectId={activeTab.projectId!}
                        branch={activeTab.branch}
                        ptyId={activeTab.ptyId}
                        onClose={() => handleClosePanel(activeTab.id, 'ports')}
                      />
                    );
                }
              };
              // The terminal panel is the ONLY keepMounted one: its shell must
              // survive a tab switch (hidden via display:none), unlike the
              // agents/team/changes panels which remount/refetch on re-activate.
              const panels = stripTabs.map((t) => ({
                id: t.id,
                node: panelNode(t.id),
                keepMounted: isTerminalPanel(t.id),
              }));
              return (
                <div
                  ref={viewerSplitRef}
                  className={`${styles.split} ${rightOpen ? '' : styles.splitSolo}`}
                >
                  <div
                    className={styles.splitSide}
                    style={rightOpen ? { flex: `0 0 ${leftPct}%`, minWidth: `${TERM_MIN}px` } : undefined}
                  >
                    {renderPane(activeTab)}
                  </div>
                  {rightOpen ? (
                    <>
                      {/* ONE divider, hoisted out of the old three duplicated branches. */}
                      <div
                        className={styles.splitHandle}
                        onPointerDown={viewerDrag.onPointerDown}
                        onDoubleClick={() => setViewerRatio(DEFAULT_RATIO)}
                        role="separator"
                        aria-orientation="vertical"
                        aria-label="Resize terminal / panel split"
                      />
                      <div
                        className={`${styles.splitSide} ${styles.splitSideRight}`}
                        style={{ flex: '1 1 0', minWidth: `${VIEWER_MIN}px` }}
                      >
                        <RightPane
                          tabs={stripTabs}
                          active={shown}
                          onSelect={(id) => setRightPane((r) => openPanel(r, activeTab.id, id))}
                          onClose={(id) => handleClosePanel(activeTab.id, id)}
                          onNewTerminal={activeTab.ptyId ? () => void handleOpenTerminal(activeTab, true) : undefined}
                          panels={panels}
                        />
                      </div>
                    </>
                  ) : null}
                </div>
              );
            })()
          ) : activeTab ? (
            <div className={styles.pane}>{renderPane(activeTab)}</div>
          ) : (
            <div className={styles.paneEmpty}>
              <EmptyComposer projects={state.projects} providers={availableProviders} />
            </div>
          )}
            </>
          )}
        </main>
      </div>
      <Toast
        open={waitingToasts.length > 0}
        repos={waitingToasts.map((w) => w.repo)}
        reason="permission prompt"
        onJump={jumpToWaiting}
        onClose={() => setWaitingToasts([])}
      />
      {shouldShowRestoreBanner(state.config.settings, restoredCount) && (
        <RestoredBanner count={restoredCount} onDone={() => setRestoredCount(0)} />
      )}
      {approval ? (
        <ApprovalToast
          open
          tool={approval.tool}
          question={approval.question}
          cwd={approval.cwd}
          hop={approval.hop}
          expiresAt={approval.expiresAt}
          onResolve={resolveApprovalToast}
          onExpire={() => setApproval(null)}
        />
      ) : null}
      <CustomizationsModal
        open={!!custOpen}
        projectId={custOpen?.projectId}
        projectName={custOpen?.projectName}
        projects={state.projects}
        hidden={state.config.hidden}
        onToggleHidden={handleToggleHidden}
        onClose={() => setCustOpen(null)}
      />
    </div>
  );
}

export default function Page() {
  const [env, setEnv] = useState<EnvResponse | null>(null);
  const [checking, setChecking] = useState(true);

  function rescan() {
    setChecking(true);
    (getEnv() as Promise<EnvResponse>).then((e) => {
      setEnv(e);
      setChecking(false);
    });
  }

  useEffect(() => {
    rescan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (checking) return null;

  const noAgentFound = env ? !env.claude.found && !env.codex.found : false;
  if (noAgentFound) return <SetupGate onRescan={rescan} />;

  // env is resolved here (the `checking` gate above guarantees it) — thread the
  // detected-provider set down once so no component re-fetches /api/env and no
  // cross-agent button renders before detection is known.
  return (
    <DetectedProvidersProvider value={providersFromEnv(env)}>
      <AppStateProvider>
        <AppShell />
      </AppStateProvider>
    </DetectedProvidersProvider>
  );
}

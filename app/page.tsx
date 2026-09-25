'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AppStateProvider, useAppState, activePair, activeTeam, shouldMarkUnviewed, shouldShowRestoreBanner, findTabToBindSession, dismissalKey, type Tab } from '../lib/client/store';
import { getProjects, getConfig, getEnv, getLive, liveIsAuthoritative, notify, resolveApproval, putConfig, getTeamMembers, startScratchTerminal, killScratchTerminal, endTermSession, type SearchHit, type LiveSession } from '../lib/client/api';
import { pruneDismissed, readDismissed, removeDismissed } from '../lib/client/dismissed';
import { readTabLayout, persistTabLayout, orderByLayout, minimizedFromLayout, type TabLayoutEntry } from '../lib/client/tab-layout';
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
import BrowserPanel from '../components/BrowserPanel/BrowserPanel';
import MemoryPanel from '../components/MemoryPanel/MemoryPanel';
import GridView from '../components/GridView/GridView';
import AgentsView from '../components/AgentsView/AgentsView';
import TeamPanel from '../components/TeamPanel/TeamPanel';
import RightPane from '../components/RightPane/RightPane';
import MobileNav, { type MobileScreen } from '../components/MobileNav/MobileNav';
import MobileSessionHeader from '../components/MobileSessionHeader/MobileSessionHeader';
import MobileActionSheet, { type SheetItem } from '../components/MobileActionSheet/MobileActionSheet';
import ScratchTerminal from '../components/ScratchTerminal/ScratchTerminal';
import EmptyComposer from '../components/EmptyComposer/EmptyComposer';
import type { ProviderId } from '../lib/client/types';
import { DetectedProvidersProvider, providersFromEnv } from '../lib/client/providers';
import Card from '../components/ui/Card/Card';
import Button from '../components/ui/Button/Button';
import { clampSize, readPersistedSize, clampSplit, shouldSnapClosed } from '../lib/client/drag-resize';
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
  browser: 'Browser',
  memory: 'Memory',
};

// Rail drag-resize bounds. MIN matches Rail.module.scss's fixed 288px (the
// pre-resize width) so the rail never gets smaller than it always was.
const RAIL_MIN = 288;
const RAIL_MAX = 560;
const RAIL_DEFAULT = 288;
// Drag the handle this far below RAIL_MIN and release → the rail collapses.
const RAIL_SNAP = 96;

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
  const [jumpTo, setJumpTo] = useState<{ projectId: string; sessionId: string; provider?: ProviderId } | null>(null);
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
  // shell's lifetime: this map is local bookkeeping only. The chip's × kills a
  // shell directly; closing the session tab kills the owner PTY, and the shells
  // it owns die server-side with it (handleScratchOnExit).
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
  // Bumped by {event:'memory'} — harvested, distilled, edited here, or written by an agent
  // through the `remember` MCP tool in a different process. A single counter, not a map:
  // the store watcher reports that the store changed, not which project changed.
  const [memoryPings, setMemoryPings] = useState(0);
  // Memory settings live in the free-form config.settings bag, same as the notification
  // prefs above. Read here rather than in TerminalPane so the dropdown stays a dumb
  // presentational component with no config dependency of its own.
  const memoryBudgetTokens = Number(state.config.settings?.memoryBudgetTokens) || 1500;
  const memorySubmitOnLoad = state.config.settings?.memorySubmitOnLoad === true;
  // BUG-3: true from {event:'server-restarting'} until the first event after
  // auto-reconnect (the server replays events on reconnect, so the next
  // message proves the server is back) — no timer, no fake progress.
  const [restarting, setRestarting] = useState(false);
  // Startup auto-restore count (latched + replayed server-side). The banner is
  // gated on the opt-in `restoreNotice` setting at render; the event always flows.
  const [restoredCount, setRestoredCount] = useState(0);
  const activeTab = state.tabs.find((t) => t.id === state.activeTab);

  // Mobile responsive layer (mockup "Seshmux Mobile"). isMobile drives the
  // grid gate + rail-width fallback; mobileScreen picks which of rail/main the
  // single-column layout shows. SSR renders desktop (isMobile=false) so first
  // paint matches; the media listener flips it after mount.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = matchMedia('(max-width: 640px)');
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>('sessions');
  // Mobile-only overlays: the projects drawer (hamburger) and the per-session
  // action sheet (⋯ in the session header).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Opening a session (rail tap, search jump, bridge) sets activeTab — on mobile
  // that means "show the session", so follow it to the Active screen. But the
  // landing IS the session list (mockup), so the rehydrate-restored active tab
  // on load must NOT yank us to Active — only later user-driven opens do.
  const prevActiveRef = useRef(state.activeTab);
  const followArmedRef = useRef(false);
  useEffect(() => {
    // ponytail: 1.2s arm window, not a restore-complete signal — the async tab
    // rehydrate lands well within it; human taps land after. Bump if a cold
    // rehydrate ever runs longer.
    const t = setTimeout(() => {
      followArmedRef.current = true;
    }, 1200);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (followArmedRef.current && state.activeTab && state.activeTab !== prevActiveRef.current) {
      setMobileScreen('active');
      // Picking a session from the projects drawer lands you on it — close it.
      setDrawerOpen(false);
    }
    prevActiveRef.current = state.activeTab;
  }, [state.activeTab]);
  function handleMobileNav(screen: MobileScreen) {
    setMobileScreen(screen);
    setDrawerOpen(false);
    if (state.settingsOpen) dispatch({ type: 'closeSettings' });
    if (screen === 'agents') dispatch({ type: 'setView', view: 'agents' });
    else if (state.view === 'agents') dispatch({ type: 'setView', view: 'tabs' });
  }
  // Grid is desktop-only (mockup): on a phone a stored 'grid' view falls back to
  // tabs for rendering (the segment is hidden too, so it can't be re-picked).
  const view = isMobile && state.view === 'grid' ? 'tabs' : state.view;

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
  // Snap-to-close: while armed the rail sits at RAIL_MIN, dimmed; the decision
  // is made on release (not mid-drag) so the handle holding pointer capture is
  // never hidden under the pointer. Ref mirrors state for onDragEnd.
  const [railSnapping, setRailSnapping] = useState(false);
  const railSnapRef = useRef(false);
  const railDrag = useDragResize({
    onDragStart: () => {
      railDragStartRef.current = railWidth;
    },
    onDrag: (deltaX) => {
      const proposed = railDragStartRef.current + deltaX;
      railSnapRef.current = shouldSnapClosed(proposed, RAIL_MIN, RAIL_SNAP);
      setRailSnapping(railSnapRef.current);
      setRailWidth(clampSize(proposed, RAIL_MIN, RAIL_MAX));
    },
    onDragEnd: () => {
      if (!railSnapRef.current) return;
      railSnapRef.current = false;
      setRailSnapping(false);
      // Reopen at the width the user had before this drag, not RAIL_MIN.
      setRailWidth(railDragStartRef.current);
      setRailCollapsed(true);
    },
  });

  // Rail collapse (desktop only): same SSR-safe read+write-in-one-effect pattern.
  // Collapsing hides the rail rather than unmounting it, so its scroll position
  // and expanded projects survive a close/open.
  const [railCollapsed, setRailCollapsed] = useState(false);
  const railCollapsedLoadedRef = useRef(false);
  useEffect(() => {
    if (!railCollapsedLoadedRef.current) {
      railCollapsedLoadedRef.current = true;
      if (localStorage.getItem('seshmux-rail-collapsed') === '1') {
        setRailCollapsed(true);
        return;
      }
    }
    localStorage.setItem('seshmux-rail-collapsed', railCollapsed ? '1' : '0');
  }, [railCollapsed]);
  const railHidden = railCollapsed && !isMobile;

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

  // Same posture for the strip's own layout — the DnD order and which tabs are
  // minimized. Writing before rehydrate has run would persist the empty initial
  // tab list over the saved layout (the "grid view doesn't stick" bug in another
  // costume), so it is gated behind a ref like the active tab above.
  //
  // Its OWN ref, though, armed only on the rehydrate SUCCESS path: when the
  // daemon is unreachable the tab list is legitimately empty, and arming here
  // would overwrite a perfectly good saved layout with `[]` — losing the order
  // for the next load, which would have restored it fine.
  const layoutLoadedRef = useRef(false);
  // Keyed on 'term-<ptyId>' — the id REHYDRATE will regenerate — not on t.id.
  // resumeToTerm converts a transcript tab into a live terminal in place and
  // keeps its 'tab-<sessionId>' id, so persisting t.id wrote an entry rehydrate
  // could never match: a resumed session the user had minimized came back
  // un-minimized, appended last, and (being the final openTerm) stole focus.
  const layoutEntries = state.tabs
    .filter((t) => t.kind === 'term' && t.ptyId)
    .map((t) => ({ id: 'term-' + t.ptyId, minimized: t.minimized === true }));
  // The effect keys on this signature rather than on `state.tabs`: setTermStatus /
  // setTermCtx / markUnviewed all map() over the tabs and hand back a fresh array
  // on every events-hub tick, so a `state.tabs` dep re-ran this several times a
  // second per live agent while only id/minimized — which change rarely — are
  // actually persisted.
  const layoutSig = JSON.stringify(layoutEntries);
  useEffect(() => {
    if (!layoutLoadedRef.current) return; // rehydrate owns the restore
    persistTabLayout(JSON.parse(layoutSig) as TabLayoutEntry[]);
  }, [layoutSig]);

  // Looking at a terminal IS acknowledging it — drop its pending "needs input"
  // toast on focus, not only when the next status event happens to arrive.
  useEffect(() => {
    const tab = state.tabs.find((t) => t.id === state.activeTab);
    if (tab?.kind !== 'term' || !tab.ptyId) return;
    setWaitingToasts((cur) => (cur.some((w) => w.ptyId === tab.ptyId) ? cur.filter((w) => w.ptyId !== tab.ptyId) : cur));
  }, [state.activeTab, state.tabs]);

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
    Promise.all([
      getProjects(),
      getLive().catch(() => ({ live: [] as LiveSession[], authoritative: false })),
    ])
      .then(([projects, liveRes]) => {
        const { live } = liveRes;
        dispatch({ type: 'setProjects', projects });
        // An empty live list means "nothing is running" ONLY when the server
        // actually reached the daemon. On a boot that races the daemon (browser
        // opened before the socket listens, a reload during a daemon relaunch)
        // it means "unknown" — and pruning against it would delete state for
        // sessions that are alive and about to reappear. Everything below that
        // DESTROYS persisted state is gated on this.
        const trustLive = liveIsAuthoritative(liveRes);
        // Prune: a dismissal whose PTY is no longer alive has nothing left to
        // suppress, and keeping it is what let a RECYCLED ptyId inherit it — a
        // fresh daemon numbers from pty-1 again, so a long-dead `pty-1`
        // dismissal silently hid the next session handed that id, on every
        // single refresh. See lib/client/dismissed.ts.
        const dismissed = trustLive ? pruneDismissed(live.map(dismissalKey)) : readDismissed();
        // Scratch shells never become their own tab — routeScratchLive splits them
        // out and maps each surviving one to its owner tab's right pane (matched by
        // ownerPtyId, or ownerTmuxName after a daemon-restart ptyId reassignment).
        const { agents, scratchByOwnerTab } = routeScratchLive(live);
        // Owner tab id -> its dismissal key, so the scratch re-attach below can
        // honor a dismissed owner even after a daemon restart reassigned ptyIds.
        const ownerKeyByTab = new Map(agents.map((a) => ['term-' + a.ptyId, dismissalKey(a)]));
        // getLive() answers in daemon order and knows nothing about the strip, so
        // replay the saved DnD order over it (unknown sessions append, exactly as
        // openTerm would have). openTerm appends, so dispatching in this order IS
        // the restored order.
        const layout = readTabLayout();
        const openedTabIds: string[] = [];
        for (const s of orderByLayout(agents, (a) => 'term-' + a.ptyId, layout)) {
          if (dismissed.includes(dismissalKey(s))) continue;
          openedTabIds.push('term-' + s.ptyId);
          // Prefer the server-resolved owning project id: a worktree PTY's cwd never
          // equals any project.path (folded into the parent), so the path match alone
          // left the tab keyed on a raw cwd that no bridge/session lookup understands.
          const proj = projects.find((p) => p.id === s.projectId) ?? projects.find((p) => p.path === s.cwd);
          const label = proj?.name ?? s.cwd.split('/').filter(Boolean).pop() ?? 'session';
          dispatch({
            type: 'openTerm',
            ptyId: s.ptyId,
            tmuxName: s.tmuxName,
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
          if (dismissed.includes(ownerKeyByTab.get(tabId) ?? tabId.slice('term-'.length))) continue;
          setScratchByTab((m) => ({ ...m, [tabId]: scratchPtyIds }));
          // One strip tab per surviving shell, in live order.
          for (const ptyId of scratchPtyIds) setRightPane((r) => openPanel(r, tabId, terminalPanel(ptyId)));
        }
        // Re-minimize what was minimized. AFTER the scratch re-attach above, which
        // keys off the tab existing, and BEFORE the active-tab restore below —
        // minimizeTab hands the active tab onward, and activateTab un-minimizes.
        const minimized = minimizedFromLayout(layout, openedTabIds);
        for (const id of minimized) dispatch({ type: 'minimizeTab', id });
        // Restore the pre-reload active tab (openTerm activated the LAST
        // rehydrated tab otherwise). Only if its PTY is still alive; then
        // enable persistence so this restore can't be clobbered (StrictMode
        // runs this whole effect twice — the ref survives both runs).
        // Never onto a tab we just minimized: 'seshmux-active-tab' is only ever
        // written with a truthy id, so minimizing the LAST visible tab leaves it
        // holding a now-minimized id — activating that would silently un-minimize
        // a tab the user had put away.
        const savedActive = localStorage.getItem('seshmux-active-tab');
        if (
          savedActive &&
          !minimized.includes(savedActive) &&
          live.some((s) => 'term-' + s.ptyId === savedActive && !dismissed.includes(dismissalKey(s)))
        ) {
          dispatch({ type: 'activateTab', id: savedActive });
        } else if (minimized.length) {
          // Land on a VISIBLE tab. openTerm activates each tab as it dispatches,
          // so the active tab is whichever was opened last — and on StrictMode's
          // second pass every openTerm takes the dedup branch, which sets
          // activeTab WITHOUT clearing `minimized`, so that last tab can already
          // be minimized (minimizeTab then no-ops on it). The result was an
          // active session with no entry in the strip. Only engages when
          // minimizing actually happened, so the ordinary path is untouched.
          const visible = openedTabIds.filter((id) => !minimized.includes(id));
          if (visible.length) dispatch({ type: 'activateTab', id: visible[visible.length - 1] });
        }
        activeLoadedRef.current = true;
        // Only arm layout persistence when the live list was the daemon's real
        // answer — otherwise the first write (an empty or partial tab list)
        // would overwrite the saved order and minimized flags for sessions that
        // are actually alive, and the feature would silently self-destruct.
        if (trustLive) layoutLoadedRef.current = true;
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

          // Toast on the TRANSITION into waiting only, and never for the terminal
          // you are already looking at. Every (re)connect replays status for all
          // live PTYs, so without the prevNI gate a reload queued a toast for every
          // long-idle session sitting at a prompt — and Jump then landed on the
          // oldest of those instead of the thing that just asked for you.
          if (e.status === 'waiting' && prevNI !== undefined && prevNI !== 'waiting' && !(isActiveTab && !document.hidden)) {
            setWaitingToasts((cur) =>
              cur.some((w) => w.ptyId === e.ptyId) ? cur : [...cur, { ptyId: e.ptyId, repo }],
            );
            // OS-level surface only when the tab is backgrounded; the server
            // decides delivery (darwin + config), so call unconditionally.
            if (document.hidden && notifyOnRef.current) {
              notify(`${repo} needs input`, 'A session is waiting for your input.').catch(() => {});
            }
          } else if (e.status !== 'waiting' || (isActiveTab && !document.hidden)) {
            // drop the session from the toast once it's no longer waiting, or once
            // you're actually sitting on it. A replayed still-waiting event for an
            // unfocused tab keeps its pending toast.
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
        case 'memory':
          setMemoryPings((n) => n + 1);
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
  // tab — this effect only prunes LOCAL bookkeeping and never kills anything:
  // the kill is endTermSession()'s job at the close sites, and the shells that
  // tab owned die server-side off the owner's exit (handleScratchOnExit).
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
          removeDismissed(dismissalKey(s));
          const proj = state.projects.find((p) => p.id === s.projectId || p.path === s.cwd);
          dispatch({
            type: 'openTerm',
            ptyId: s.ptyId,
            tmuxName: s.tmuxName,
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

  // A shell someone else spawned for this tab (the browser panel's Run button):
  // register it so the strip shows its terminal, then re-activate the panel that
  // asked for it. openPanel() always activates, so without the second call the
  // click would silently navigate away from the surface it was made on.
  function handleShellStarted(tab: Tab, scratchPtyId: string, restore: PanelId = 'browser') {
    setScratchByTab((m) => ({
      ...m,
      [tab.id]: [...(m[tab.id] ?? []).filter((p) => p !== scratchPtyId), scratchPtyId],
    }));
    setRightPane((r) => openPanel(openPanel(r, tab.id, terminalPanel(scratchPtyId)), tab.id, restore));
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
          onOpenBrowser={tab.projectId ? () => handleTogglePanel(tab.id, 'browser') : undefined}
          onOpenMemory={tab.projectId ? () => handleTogglePanel(tab.id, 'memory') : undefined}
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
    setJumpTo({ projectId: hit.project, sessionId: hit.sessionId, provider: hit.provider });
    dispatch({
      type: 'openSession',
      sessionId: hit.sessionId,
      projectId: hit.project,
      label: hit.title || 'untitled',
      kind: 'transcript',
      provider: hit.provider,
    });
  }

  // Mobile "Close session" (action sheet): same as the desktop tab × — ENDS the
  // session (kills the PTY + any tmux session behind it), not just the view.
  function closeActiveSession(tab: Tab) {
    endTermSession(tab);
    dispatch({ type: 'closeTab', id: tab.id });
    setMobileScreen('sessions');
  }

  // Action-sheet items for the active session — each maps onto an existing
  // capability (the same toggles the desktop status-bar chips fire). A failed
  // gate drops the row; grid stays as a disabled "desktop only" affordance.
  const sheetItems: SheetItem[] = activeTab
    ? ([
        activeTab.projectId && {
          key: 'ports',
          icon: '⇄',
          label: 'Ports',
          onClick: () => handleTogglePanel(activeTab.id, 'ports'),
        },
        activeTab.ptyId && {
          key: 'terminal',
          icon: '›_',
          label: 'Open terminal',
          onClick: () => void handleOpenTerminal(activeTab),
        },
        activeTab.sessionId && activeTab.projectId && activeTab.provider !== 'codex' && {
          key: 'agents',
          icon: '◈',
          label: 'Subagents',
          onClick: () => handleTogglePanel(activeTab.id, 'agents'),
        },
        activeTab.projectId && {
          key: 'changes',
          icon: '▤',
          label: 'Folder / changes',
          onClick: () => handleTogglePanel(activeTab.id, 'changes'),
        },
        activeTab.projectId && {
          key: 'browser',
          icon: '⧉',
          label: 'Browser',
          onClick: () => handleTogglePanel(activeTab.id, 'browser'),
        },
        activeTab.projectId && {
          key: 'memory',
          icon: '◆',
          label: 'Memory',
          onClick: () => handleTogglePanel(activeTab.id, 'memory'),
        },
        { key: 'grid', icon: '▦', label: 'Grid / split view', hint: 'desktop only', disabled: true },
        { key: 'close', icon: '✕', label: 'Close session', danger: true, onClick: () => closeActiveSession(activeTab) },
      ].filter(Boolean) as SheetItem[])
    : [];

  return (
    <div className={styles.shell}>
      {restarting ? <div className={styles.restartBanner}>Updating — reconnecting…</div> : null}
      <TopNav
        onPickHit={handlePickHit}
        onOpenCustomizations={() => setCustOpen({})}
        onOpenMenu={isMobile && mobileScreen !== 'sessions' ? () => setDrawerOpen(true) : undefined}
      />
      {/* data-screen drives the mobile single-column layout (page.module.scss):
          'sessions' shows the rail full-width, anything else shows main. */}
      <div className={styles.app} data-screen={mobileScreen} data-drawer={drawerOpen ? 'open' : 'closed'}>
        {/* Settings is a full-page overlay: hide the rail so it reads as its own
            page. Sibling of <main>, so gate it here. */}
        {state.settingsOpen || !railHidden ? null : (
          // The whole 24px strip is one button: a hit target the full height of the
          // window, and a single tab stop for keyboard users.
          <button
            type="button"
            className={styles.railSliver}
            onClick={() => setRailCollapsed(false)}
            aria-label="Show sidebar"
            title="Show sidebar"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
        {state.settingsOpen ? null : (
          <div className={`${styles.railCol} ${railHidden ? styles.railColHidden : ''} ${railSnapping ? styles.railColSnapping : ''}`}>
            <Rail
              width={isMobile ? undefined : railWidth}
              jumpTo={jumpTo}
              onJumped={() => setJumpTo(null)}
              onOpenCustomizations={setCustOpen}
              onOpenGlobalCustomizations={() => setCustOpen({})}
              onCollapse={isMobile ? undefined : () => setRailCollapsed(true)}
            />
            <div
              className={styles.railHandle}
              onPointerDown={railDrag.onPointerDown}
              onDoubleClick={() => setRailWidth(RAIL_DEFAULT)}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
            />
          </div>
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
          {/* Desktop: tab strip. Mobile: a single-session header (back + ⋯) —
              multi-tab is gated, so the strip is replaced, not shrunk. */}
          {state.tabs.some((t) => !t.minimized) && view === 'tabs' && !isMobile ? <Tabs /> : null}
          {isMobile && view === 'tabs' && activeTab ? (
            <MobileSessionHeader
              tab={activeTab}
              onBack={() => setMobileScreen('sessions')}
              onMenu={() => setSheetOpen(true)}
            />
          ) : null}
          {/* Grid mode replaces the single-pane view over the same term-tab set. */}
          {view === 'grid' ? (
            <div className={styles.pane}>
              <GridView />
            </div>
          ) : view === 'agents' ? (
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
                  case 'memory':
                  case 'browser':
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
                  case 'browser':
                    return (
                      // key: RightPane keys panels by PANEL id ('browser'), which is
                      // the same string for every session tab, and nothing above it
                      // is keyed by tab. Switching between two tabs that both have
                      // this panel open would otherwise reconcile ONE instance with
                      // new props while its nav/groups state — none of it derived
                      // from props — kept pointing at the other project's app.
                      <BrowserPanel
                        key={activeTab.id}
                        projectId={activeTab.projectId!}
                        ptyId={activeTab.ptyId}
                        // keepMounted keeps this alive behind other strip tabs, so
                        // it must be told when it is off-screen or it polls a
                        // daemon-history scan forever for a panel nobody sees.
                        visible={shown === 'browser'}
                        onShellStarted={(scratchPtyId) => handleShellStarted(activeTab, scratchPtyId)}
                        onClose={() => handleClosePanel(activeTab.id, 'browser')}
                      />
                    );
                  case 'memory':
                    return (
                      <MemoryPanel
                        projectId={activeTab.projectId!}
                        sessionId={activeTab.sessionId}
                        provider={activeTab.provider}
                        branch={activeTab.branch}
                        refreshKey={memoryPings}
                        // The right pane is a sibling of the terminal, not its parent, so
                        // the panel resolves the writer itself from the registry
                        // TerminalPane publishes to while its socket is up.
                        ptyId={activeTab.ptyId}
                        canLoad={activeTab.status !== 'done'}
                        budgetTokens={memoryBudgetTokens}
                        submitOnLoad={memorySubmitOnLoad}
                        onClose={() => handleClosePanel(activeTab.id, 'memory')}
                      />
                    );
                }
              };
              // Terminal and browser panels are keepMounted: a shell must survive
              // a tab switch (hidden via display:none), and so must a previewed
              // page — remounting its iframe would throw away scroll position,
              // form state and the app's own client-side route. The
              // agents/team/changes panels still remount/refetch on re-activate.
              const panels = stripTabs.map((t) => ({
                id: t.id,
                node: panelNode(t.id),
                keepMounted: isTerminalPanel(t.id) || t.id === 'browser',
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
        {/* Projects drawer backdrop — the railCol becomes a fixed overlay on
            mobile when data-drawer=open (page.module.scss); this dims behind it. */}
        {isMobile && drawerOpen ? (
          <div className={styles.drawerBackdrop} onClick={() => setDrawerOpen(false)} role="presentation" />
        ) : null}
      </div>
      {/* Bottom tab bar — mobile only (CSS-hidden on desktop). */}
      <MobileNav value={mobileScreen} onChange={handleMobileNav} />
      <MobileActionSheet
        open={sheetOpen && isMobile && !!activeTab}
        title={activeTab?.label}
        subtitle={[activeTab?.branch, activeTab?.provider].filter(Boolean).join(' · ') || undefined}
        items={sheetItems}
        onClose={() => setSheetOpen(false)}
      />
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

'use client';

import { useEffect, useRef, useState } from 'react';
import { AppStateProvider, useAppState, activePair, activeTeam, shouldMarkUnviewed, findTabToBindSession, type Tab } from '../lib/client/store';
import { getProjects, getConfig, getEnv, getLive, notify, resolveApproval, putConfig, getTeamMembers, type SearchHit, type LiveSession } from '../lib/client/api';
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
import ApprovalToast from '../components/ApprovalToast/ApprovalToast';
import TerminalPane from '../components/TerminalPane/TerminalPane';
import SubagentViewer from '../components/SubagentViewer/SubagentViewer';
import ChangesPanel from '../components/ChangesPanel/ChangesPanel';
import GridView from '../components/GridView/GridView';
import AgentsView from '../components/AgentsView/AgentsView';
import TeamPanel from '../components/TeamPanel/TeamPanel';
import EmptyComposer from '../components/EmptyComposer/EmptyComposer';
import type { ProviderId } from '../lib/client/types';
import { DetectedProvidersProvider, providersFromEnv } from '../lib/client/providers';
import Card from '../components/ui/Card/Card';
import Button from '../components/ui/Button/Button';
import { clampSize, readPersistedSize, clampSplit } from '../lib/client/drag-resize';
import { persistDebounced } from '../lib/client/persist';
import { useDragResize } from '../lib/client/use-drag-resize';
import styles from './page.module.scss';

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
  // Subagent viewer: which term tab has its viewer open (synthetic right-pane, NOT a Tab —
  // keeps tab semantics/rollup untouched, mirrors how `pair` is derived locally). Plus a
  // per-session ping counter bumped on each {event:'subagents'} so the chip + open viewer
  // refetch live.
  const [openViewerFor, setOpenViewerFor] = useState<string | null>(null);
  const [subagentPings, setSubagentPings] = useState<Record<string, number>>({});
  // Teams v1.1: TeamPanel is opt-in via a statusbar chip (tmux teammateMode already
  // tiles teammates inside the lead terminal — the auto-split was redundant screen
  // space). openTeamFor mirrors openViewerFor exactly (keyed by tab id, default
  // closed); the two are mutually exclusive — opening one closes the other, same
  // precedence as the pair-split winning over both (see `team` below).
  const [openTeamFor, setOpenTeamFor] = useState<string | null>(null);
  // Changes panel (branch diff file tree): third occupant of the same exclusive
  // right-pane slot, keyed by tab id like the two above.
  const [openChangesFor, setOpenChangesFor] = useState<string | null>(null);
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
        for (const s of live) {
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

  // Activate the OLDEST waiting session and pop it — the toast stays up with
  // the rest so repeated clicks chain through the queue. A vanished tab
  // (closed while waiting) just pops and the next click moves on.
  function jumpToWaiting() {
    const next = waitingToasts[0];
    if (!next) return;
    const tab = state.tabs.find((t) => t.kind === 'term' && t.ptyId === next.ptyId);
    if (tab) dispatch({ type: 'activateTab', id: tab.id });
    setWaitingToasts((cur) => cur.filter((w) => w.ptyId !== next.ptyId));
  }

  function resolveApprovalToast(approved: boolean) {
    if (!approval) return;
    resolveApproval(approval.requestId, approved).catch(() => {}); // 404 = already expired
    setApproval(null);
  }

  // Chip handlers: only one right-pane panel open at a time, so opening either
  // closes the other (exclusivity requirement — mirrors the pair-split winning
  // over the term/viewer split above it).
  function toggleTeamPanel(tabId: string) {
    setOpenViewerFor(null);
    setOpenChangesFor(null);
    setOpenTeamFor((cur) => (cur === tabId ? null : tabId));
  }
  function openSubagentViewer(tabId: string) {
    setOpenTeamFor(null);
    setOpenChangesFor(null);
    setOpenViewerFor(tabId);
  }
  function toggleChangesPanel(tabId: string) {
    setOpenViewerFor(null);
    setOpenTeamFor(null);
    setOpenChangesFor((cur) => (cur === tabId ? null : tabId));
  }

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
          onOpenSubagents={canViewSubagents ? () => openSubagentViewer(tab.id) : undefined}
          subagentPing={tab.sessionId ? subagentPings[tab.sessionId] : undefined}
          isTeamLead={tab.isTeamLead}
          teamMemberCount={tab.sessionId ? teamMemberCounts[tab.sessionId] : undefined}
          onOpenTeam={tab.isTeamLead ? () => toggleTeamPanel(tab.id) : undefined}
          onOpenChanges={tab.projectId ? () => toggleChangesPanel(tab.id) : undefined}
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
            // position (and its live xterm/PTY) never remounts when the subagent viewer
            // or team panel opens/closes — only the conditional right pane mounts/
            // unmounts. The accent divider appears only WITH a right pane (viewerSplit
            // modifier). Teams v1.1: the team split is opt-in (statusbar chip, default
            // closed — tmux teammateMode already tiles teammates inside the terminal),
            // so it shares this same right-pane slot with the subagent viewer instead
            // of forcing its own always-on split; `team` (pair-gated above) supplies
            // the leadSessionId once openTeamFor confirms the user actually opened it.
            (() => {
              const teamOpen = !!team && openTeamFor === activeTab.id;
              const viewerOpen =
                !teamOpen &&
                openViewerFor === activeTab.id &&
                !!activeTab.sessionId &&
                !!activeTab.projectId;
              const changesOpen =
                !teamOpen && !viewerOpen && openChangesFor === activeTab.id && !!activeTab.projectId;
              const rightOpen = teamOpen || viewerOpen || changesOpen;
              // Percentage flex-basis (not px) since container width is unknown at
              // render; min-width enforces TERM_MIN/VIEWER_MIN without measuring.
              // clampSize guards against a stored extreme hiding a pane on reload.
              const leftPct = clampSize(viewerRatio, 0.15, 0.85) * 100;
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
                  {teamOpen ? (
                    <>
                      <div
                        className={styles.splitHandle}
                        onPointerDown={viewerDrag.onPointerDown}
                        onDoubleClick={() => setViewerRatio(DEFAULT_RATIO)}
                        role="separator"
                        aria-orientation="vertical"
                        aria-label="Resize terminal / team split"
                      />
                      <div
                        className={`${styles.splitSide} ${styles.splitSideRight}`}
                        style={{ flex: '1 1 0', minWidth: `${VIEWER_MIN}px` }}
                      >
                        <TeamPanel
                          leadSessionId={team!.leadSessionId}
                          projectId={team!.tab.projectId ?? ''}
                          refreshKey={teamPings[team!.leadSessionId]}
                          touchPings={touchPings}
                          onMembersResolved={(count) =>
                            setTeamMemberCounts((prev) => ({ ...prev, [team!.leadSessionId]: count }))
                          }
                        />
                      </div>
                    </>
                  ) : viewerOpen ? (
                    <>
                      <div
                        className={styles.splitHandle}
                        onPointerDown={viewerDrag.onPointerDown}
                        onDoubleClick={() => setViewerRatio(DEFAULT_RATIO)}
                        role="separator"
                        aria-orientation="vertical"
                        aria-label="Resize terminal / subagent split"
                      />
                      <div
                        className={`${styles.splitSide} ${styles.splitSideRight}`}
                        style={{ flex: '1 1 0', minWidth: `${VIEWER_MIN}px` }}
                      >
                        <SubagentViewer
                          projectId={activeTab.projectId!}
                          sessionId={activeTab.sessionId!}
                          refreshKey={subagentPings[activeTab.sessionId!]}
                          onClose={() => setOpenViewerFor(null)}
                        />
                      </div>
                    </>
                  ) : changesOpen ? (
                    <>
                      <div
                        className={styles.splitHandle}
                        onPointerDown={viewerDrag.onPointerDown}
                        onDoubleClick={() => setViewerRatio(DEFAULT_RATIO)}
                        role="separator"
                        aria-orientation="vertical"
                        aria-label="Resize terminal / changes split"
                      />
                      <div
                        className={`${styles.splitSide} ${styles.splitSideRight}`}
                        style={{ flex: '1 1 0', minWidth: `${VIEWER_MIN}px` }}
                      >
                        <ChangesPanel
                          projectId={activeTab.projectId!}
                          branch={activeTab.branch}
                          onClose={() => setOpenChangesFor(null)}
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

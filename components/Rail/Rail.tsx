'use client';

import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useDragResize } from '../../lib/client/use-drag-resize';
import { clampSize, readPersistedSize } from '../../lib/client/drag-resize';
import { persistDebounced } from '../../lib/client/persist';
import TextInput from '../ui/TextInput/TextInput';
import StatusDot from '../ui/StatusDot/StatusDot';
import IconButton from '../ui/IconButton/IconButton';
import { getSessions, startSession, createWorkspace, getEnvTeams, startTeam } from '../../lib/client/api';
import type { TeamStartPayload } from '../../lib/client/api';
import type { SessionMeta, Project, Config, ProviderId } from '../../lib/client/types';
import { useAppState } from '../../lib/client/store';
import { useDetectedProviders, provFilterOptions, showsProviderIdentity } from '../../lib/client/providers';
import type { RailSort, Tab } from '../../lib/client/store';
import NewSessionModal, { type SessionMode } from '../NewSessionModal/NewSessionModal';
import TeamModal, { teamsAllowed } from '../TeamModal/TeamModal';
import FilterMenu from '../FilterMenu/FilterMenu';
import { PrList } from '../PrLinks/PrLinks';
import styles from './Rail.module.scss';


const CHUNK = 5;
const FILTER_THRESHOLD = 6;

const PIN_SVG = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
  </svg>
);

// All rail-row icons are same-box SVGs (11×11, stroke 2) so they baseline-align
// — mixing text glyphs (≡ +) with SVGs misaligned the row.
const LINES_SVG = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="4" y1="6" x2="20" y2="6" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="18" x2="20" y2="18" />
  </svg>
);

const PLUS_SVG = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const DOTS_V_SVG = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <circle cx="12" cy="5" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="12" cy="19" r="2" />
  </svg>
);

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
}

// Rollup precedence (Spec 3): waiting > done-unviewed > live > neutral. Rail
// session rows have no live tab (fresh/unopened sessions) — those stay
// neutral/live off SessionMeta.live exactly as before.
function sessDotStatus(s: SessionMeta, projTabs: Tab[]): 'waiting' | 'unviewed' | 'live' | 'neutral' {
  const tab = projTabs.find((t) => t.sessionId === s.id);
  if (tab?.status === 'waiting') return 'waiting';
  if (tab?.unviewed) return 'unviewed';
  return s.live ? 'live' : 'neutral';
}

// Open-tab row dot: same rollup precedence as sessDotStatus, but straight off the tab.
function tabDotStatus(t: Tab): 'waiting' | 'unviewed' | 'live' | 'neutral' {
  if (t.status === 'waiting') return 'waiting';
  if (t.unviewed) return 'unviewed';
  return t.status === 'live' ? 'live' : 'neutral';
}

const SESSIONS_H_MIN = 76;
const SESSIONS_H_MAX = 480;
const SESSIONS_H_DEFAULT = 180;

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

type ProjSessions = { sessions: SessionMeta[]; cursor: number | null; hasMore: boolean; loaded: boolean };

function railOrder(projects: Project[], config: Config, sort: RailSort): Project[] {
  const pinSet = new Set(config.pins);
  const orderIndex = new Map(config.projectOrder.map((id, i) => [id, i]));
  return [...projects].sort((a, b) => {
    const pa = pinSet.has(a.id) ? 0 : 1;
    const pb = pinSet.has(b.id) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    // An active timestamp sort overrides the manual drag order (projectOrder);
    // pins still float to the top above it.
    const ta = sort === 'created' ? a.createdAt : a.updatedAt;
    const tb = sort === 'created' ? b.createdAt : b.updatedAt;
    if (ta !== tb) return tb - ta; // newest first
    const ia = orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const ib = orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return a.name.localeCompare(b.name);
  });
}

export type RailProps = {
  jumpTo?: { projectId: string; sessionId: string } | null;
  onJumped?: () => void;
  onOpenCustomizations?: (scope: { projectId: string; projectName: string }) => void;
  onOpenGlobalCustomizations?: () => void;
  // Drag-resize (page.tsx owns the state + persistence); undefined falls back
  // to the CSS 288px default for SSR/first paint.
  width?: number;
};

export default function Rail({ jumpTo, onJumped, onOpenCustomizations, onOpenGlobalCustomizations, width }: RailProps) {
  const { state, dispatch } = useAppState();
  const { config, provFilter, railSort } = state;
  // Hide repos whose folder no longer exists on disk (deleted worktrees, /tmp
  // probes) and projects the user hid (unless the FilterMenu bypass is on).
  // Derive once so counts/empty-states/fetch effects all agree.
  const projects = state.projects.filter(
    (p) => !p.missing && (state.showHidden || !config.hidden.includes(p.id)),
  );
  // The session open in the active tab — its rail row gets the accent-soft fill.
  const activeSessionId = state.tabs.find((t) => t.id === state.activeTab)?.sessionId ?? null;
  const [byProject, setByProject] = useState<Record<string, ProjSessions>>({});
  const [dragProjId, setDragProjId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [projFilter, setProjFilterState] = useState<Record<string, string>>({});
  // Sidebar-wide filter: narrows sessions across ALL projects by title/branch.
  // Local state only (no persistence) — the per-project filter above still works.
  const [railFilter, setRailFilter] = useState('');
  // "+" opens NewSessionModal for one project; null = closed.
  const [modalProject, setModalProject] = useState<Project | null>(null);
  // "⚑" (or NewSessionModal's "Team…") opens TeamModal for one project.
  const [teamProject, setTeamProject] = useState<Project | null>(null);
  // Task 5 Step 1b: claude's claude-swarm teammate backend — Teams entry
  // points gate on this (only 'tmux'/'iterm2' produce attachable jsonls).
  const [teammateMode, setTeammateMode] = useState<string | undefined>(undefined);
  useEffect(() => {
    getEnvTeams()
      .then((teams) => setTeammateMode(teams.claude?.teammateMode ?? undefined))
      .catch(() => {});
  }, []);
  const teamsGateOk = teamsAllowed(teammateMode);

  // Providers offered in the modal / the filter chips: the env-detected set (a
  // detected agent with zero sessions yet must still be offerable, so this is
  // NOT derived from the loaded projects' providers).
  const availableProviders = useDetectedProviders();
  const provOptions = provFilterOptions(availableProviders);
  // Per-session agent label: only tells you something when there are two agents.
  const showProvider = showsProviderIdentity(availableProviders);

  async function handleStartSession(provider: ProviderId, mode: SessionMode) {
    const project = modalProject;
    setModalProject(null);
    if (!project) return;
    try {
      const { tabMeta } = await startSession({ projectPath: project.path, provider, mode });
      dispatch({
        type: 'openTerm',
        ptyId: tabMeta.ptyId,
        projectId: project.id,
        label: project.name,
        provider,
      });
    } catch {
      // Surfacing errors as a toast lands with the events-ws wave (Task 15).
    }
  }

  // Team modal's Start button (Task 5) — same split as handleStartSession:
  // the modal only builds the payload, this does the POST + opens the lead
  // tab + switches to tabs view (the modal doesn't own view state). Close the
  // modal ONLY on success — a rejection propagates back to TeamModal, which
  // stays open, shows the error inline, and keeps everything the user typed.
  async function handleStartTeam(payload: Omit<TeamStartPayload, 'projectId'>) {
    const project = teamProject;
    if (!project) return;
    const { tabMeta } = await startTeam({ ...payload, projectId: project.id });
    setTeamProject(null);
    dispatch({ type: 'openTerm', ptyId: tabMeta.ptyId, projectId: project.id, label: project.name, provider: 'claude', isTeamLead: true });
    dispatch({ type: 'setView', view: 'tabs' });
  }

  const [workspaceBusy, setWorkspaceBusy] = useState<string | null>(null);

  // One click, no dialog: auto-name everything (project's dominant provider,
  // same spawn defaults as "+"). Never couples worktree creation to ordinary
  // session spawn — this is its own explicit POST, still through the shared
  // startSession() server-side.
  async function doCreateWorkspace(p: Project, provider?: ProviderId, mode?: SessionMode) {
    if (workspaceBusy) return;
    setWorkspaceBusy(p.id);
    try {
      const { tabMeta, workspace } = await createWorkspace(p.id, provider, mode);
      dispatch({
        type: 'openTerm',
        ptyId: tabMeta.ptyId,
        projectId: p.id,
        label: `${p.name} · ${workspace.branch}`,
        provider: tabMeta.provider,
        branch: workspace.branch,
      });
    } catch {
      // Surfacing errors as a toast lands with the events-ws wave (Task 15).
    } finally {
      setWorkspaceBusy(null);
    }
  }

  // In-flight guard: the filter fan-out effects re-run per render (fresh
  // `projects` array ref) and `loaded` only flips on completion, so every
  // render during the fetch window re-fired a duplicate GET per project.
  const firstPageInFlight = useRef(new Set<string>());
  async function loadFirstPage(projectId: string) {
    if (firstPageInFlight.current.has(projectId)) return;
    firstPageInFlight.current.add(projectId);
    try {
      const sessions = await getSessions(projectId, { limit: CHUNK });
      setByProject((prev) => ({
        ...prev,
        [projectId]: {
          sessions,
          cursor: sessions.length ? sessions[sessions.length - 1].mtime : null,
          hasMore: sessions.length === CHUNK,
          loaded: true,
        },
      }));
    } finally {
      firstPageInFlight.current.delete(projectId);
    }
  }

  async function loadMore(projectId: string) {
    const entry = byProject[projectId];
    if (!entry || entry.cursor == null) return;
    const more = await getSessions(projectId, { before: entry.cursor, limit: CHUNK });
    setByProject((prev) => ({
      ...prev,
      [projectId]: {
        sessions: [...entry.sessions, ...more],
        cursor: more.length ? more[more.length - 1].mtime : entry.cursor,
        hasMore: more.length === CHUNK,
        loaded: true,
      },
    }));
  }

  // Provider filter needs to know every project's sessions to decide which
  // projects to hide (provider lives only on SessionMeta, not Project) — fan
  // out fetches for any project not yet loaded when a filter activates.
  useEffect(() => {
    if (provFilter === 'all') return;
    for (const p of projects) {
      if (!byProject[p.id]?.loaded) loadFirstPage(p.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provFilter, projects]);

  // The sidebar-wide filter can't match sessions it hasn't loaded — fan out
  // first-page fetches for every project when it's active (same as provFilter).
  useEffect(() => {
    if (!railFilter.trim()) return;
    for (const p of projects) {
      if (!byProject[p.id]?.loaded) loadFirstPage(p.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railFilter, projects]);

  useEffect(() => {
    if (!jumpTo) return;
    const p = projects.find((x) => x.id === jumpTo.projectId);
    if (p && !(p as Project & { open?: boolean }).open) dispatch({ type: 'toggleProject', id: jumpTo.projectId });
    if (!byProject[jumpTo.projectId]?.loaded) loadFirstPage(jumpTo.projectId);
    onJumped?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);

  function handleToggleProj(p: Project & { open?: boolean }) {
    dispatch({ type: 'toggleProject', id: p.id });
    if (!p.open && !byProject[p.id]?.loaded) loadFirstPage(p.id);
  }

  function persistConfig(next: Config) {
    dispatch({ type: 'setConfig', config: next });
    import('../../lib/client/api').then(({ putConfig }) => putConfig(next));
  }

  function handleTogglePin(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    dispatch({ type: 'togglePin', id });
    const pins = config.pins.includes(id) ? config.pins.filter((x) => x !== id) : [...config.pins, id];
    persistConfig({ ...config, pins });
  }

  function handleProjDrop(targetId: string) {
    if (!dragProjId || dragProjId === targetId) {
      setDragProjId(null);
      setDragOverId(null);
      return;
    }
    const ordered = railOrder(projects, config, railSort).map((p) => p.id);
    const from = ordered.indexOf(dragProjId);
    const to = ordered.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...ordered];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    // dropping across the pin boundary adopts the target's pin state
    const targetPinned = config.pins.includes(targetId);
    const draggedPinned = config.pins.includes(dragProjId);
    let pins = config.pins;
    if (draggedPinned !== targetPinned) {
      pins = targetPinned ? [...config.pins, dragProjId] : config.pins.filter((x) => x !== dragProjId);
    }
    dispatch({ type: 'moveProject', from: dragProjId, to: targetId });
    persistConfig({ ...config, projectOrder: next, pins });
    setDragProjId(null);
    setDragOverId(null);
  }

  function matchQuery(s: SessionMeta, q: string): boolean {
    return (s.title || '').toLowerCase().includes(q) || (s.branch || '').toLowerCase().includes(q);
  }

  function visibleSessions(p: Project & { filter?: string; loaded?: number }) {
    const entry = byProject[p.id];
    const all = entry?.sessions ?? [];
    let list = provFilter === 'all' ? all : all.filter((s) => s.provider === provFilter);
    // Sidebar-wide filter narrows first (across all projects); the per-project
    // filter narrows further. Either being active disables load-more paging.
    const rail = railFilter.trim().toLowerCase();
    const projVal = projFilter[p.id]?.toLowerCase();
    if (rail) list = list.filter((s) => matchQuery(s, rail));
    if (projVal) list = list.filter((s) => matchQuery(s, projVal));
    const filtered = !!rail || !!projVal;
    return { shown: list, hasMore: filtered ? false : entry?.hasMore ?? false, filtered };
  }

  const ordered = railOrder(projects, config, railSort);
  const railActive = railFilter.trim().length > 0;
  // Provider filter: key off the server's per-provider counts (always present),
  // not the lazily-loaded session pages — otherwise unloaded projects vanish.
  let filteredProjects =
    provFilter === 'all' ? ordered : ordered.filter((p) => (p.sessionCountByProvider?.[provFilter] ?? 0) > 0);
  // When the sidebar-wide filter is active, hide projects with no match — and
  // (below) force the matching ones open regardless of collapse state.
  if (railActive) filteredProjects = filteredProjects.filter((p) => visibleSessions(p as Project).shown.length > 0);

  const totalProjects = projects.length;
  const hasAnySessions = projects.some((p) => p.sessionCount > 0);

  // Open-sessions panel (VS Code Outline-style): every open tab across
  // tabs/grid/agents, resizable via a drag handle on its top edge. Same
  // SSR-safe read+write-in-one-effect persistence pattern as railWidth.
  const openTabs = state.tabs;
  const [sessionsH, setSessionsH] = useState(SESSIONS_H_DEFAULT);
  const sessionsHLoadedRef = useRef(false);
  useEffect(() => {
    if (!sessionsHLoadedRef.current) {
      sessionsHLoadedRef.current = true;
      const saved = readPersistedSize(
        localStorage.getItem('seshmux-rail-sessions-height'),
        SESSIONS_H_MIN,
        SESSIONS_H_MAX,
        SESSIONS_H_DEFAULT,
      );
      if (saved !== sessionsH) {
        setSessionsH(saved);
        return;
      }
    }
    persistDebounced('seshmux-rail-sessions-height', String(sessionsH));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsH]);
  // Dock side (default bottom). Dragging either section's header across the
  // other swaps them — same idea as VS Code sidebar section reordering.
  const [sessionsPos, setSessionsPos] = useState<'top' | 'bottom'>('bottom');
  const sessionsPosLoadedRef = useRef(false);
  useEffect(() => {
    if (!sessionsPosLoadedRef.current) {
      sessionsPosLoadedRef.current = true;
      const saved = localStorage.getItem('seshmux-rail-sessions-pos');
      if (saved === 'top' && sessionsPos !== 'top') {
        setSessionsPos('top');
        return;
      }
    }
    localStorage.setItem('seshmux-rail-sessions-pos', sessionsPos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsPos]);
  const [sectionDrag, setSectionDrag] = useState<'sessions' | 'projects' | null>(null);
  // Drop-zone highlight while a section header is dragged over the other
  // section — same accent-soft + outline treatment as GridView's .zone.
  const [sectionDragOver, setSectionDragOver] = useState<'sessions' | 'projects' | null>(null);
  function sectionDropProps(self: 'sessions' | 'projects') {
    return {
      onDragOver: (e: DragEvent) => {
        if (sectionDrag && sectionDrag !== self) {
          e.preventDefault();
          setSectionDragOver(self);
        }
      },
      onDragLeave: () => setSectionDragOver((cur) => (cur === self ? null : cur)),
      onDrop: (e: DragEvent) => {
        setSectionDragOver(null);
        if (!sectionDrag || sectionDrag === self) return;
        e.preventDefault();
        setSessionsPos((p) => (p === 'top' ? 'bottom' : 'top'));
        setSectionDrag(null);
      },
    };
  }
  const sectionZone = (self: 'sessions' | 'projects') =>
    sectionDragOver === self && sectionDrag && sectionDrag !== self ? styles.sectionDropZone : '';

  const sessionsDragStartRef = useRef(SESSIONS_H_DEFAULT);
  const sessionsDrag = useDragResize({
    axis: 'y',
    onDragStart: () => {
      sessionsDragStartRef.current = sessionsH;
    },
    // The handle sits on the edge FACING the project list: bottom-docked panel
    // grows when dragged up (-deltaY), top-docked grows when dragged down.
    onDrag: (deltaY) => {
      const grown = sessionsPos === 'bottom' ? -deltaY : deltaY;
      setSessionsH(clampSize(sessionsDragStartRef.current + grown, SESSIONS_H_MIN, SESSIONS_H_MAX));
    },
  });

  function handleOpenTab(t: Tab) {
    dispatch({ type: 'activateTab', id: t.id });
    // Agents view has no tab surface — jump to tabs so the click lands somewhere visible.
    if (state.view === 'agents') dispatch({ type: 'setView', view: 'tabs' });
  }

  const sessionsPanel = openTabs.length ? (
    <div
      className={`${styles.openSessions} ${sessionsPos === 'top' ? styles.dockTop : styles.dockBottom} ${sectionZone('sessions')}`}
      style={{ height: sessionsH }}
      {...sectionDropProps('sessions')}
    >
      <div
        className={`${styles.sessionsHandle} ${sessionsPos === 'top' ? styles.handleBottom : styles.handleTop}`}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize sessions panel"
        onPointerDown={sessionsDrag.onPointerDown}
      />
      <div
        className={styles.sessionsHead}
        draggable
        onDragStart={() => setSectionDrag('sessions')}
        onDragEnd={() => setSectionDrag(null)}
      >
        <h2>Sessions</h2>
        <span className={styles.scan}>{openTabs.length}</span>
      </div>
      <div className={styles.sessionsList}>
        {openTabs.map((t) => (
          <div key={t.id}>
            <button
              type="button"
              className={`${styles.openTab} ${t.id === state.activeTab ? styles.selected : ''}`}
              title={t.branch ? `${t.label} · ${t.branch}` : t.label}
              onClick={() => handleOpenTab(t)}
            >
              <StatusDot status={tabDotStatus(t)} size={7} />
              <span className={styles.openTabInfo}>
                <span className={styles.openTabLabel}>{t.label}</span>
                {t.branch ? <span className={styles.openTabBranch}>⎇ {t.branch}</span> : null}
              </span>
              {showProvider && t.provider ? (
                <span className={`${styles.sessAgent} ${styles[t.provider]}`}>{t.provider}</span>
              ) : null}
            </button>
            {/* PRs created in this session — same surface as the project list. Anchors
                can't nest in the row <button>, so they render as a sibling below it. */}
            {t.projectId && t.sessionId ? <PrList projectId={t.projectId} sessionId={t.sessionId} /> : null}
          </div>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <aside className={styles.rail} style={width != null ? { width, flex: `0 0 ${width}px` } : undefined}>
      {sessionsPos === 'top' ? sessionsPanel : null}
      <div className={`${styles.projectsSection} ${sectionZone('projects')}`} {...sectionDropProps('projects')}>
      <div
        className={styles.head}
        draggable
        onDragStart={() => setSectionDrag('projects')}
        onDragEnd={() => setSectionDrag(null)}
      >
        <h2>Projects</h2>
        <span className={styles.scan}>{totalProjects}</span>
      </div>
      <div className={styles.provFilter}>
        {provOptions.length ? (
          <div className={styles.provChips} role="group" aria-label="Filter by provider">
            {provOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`${styles.chip} ${provFilter === opt.id ? styles.chipActive : ''}`}
                aria-pressed={provFilter === opt.id}
                onClick={() => dispatch({ type: 'setProvFilter', filter: opt.id })}
              >
                {opt.label}
              </button>
            ))}
          </div>
        ) : null}
        <FilterMenu />
        {/* Global (user-level) customizations + marketplace — same modal the
            per-project gear opens, unscoped. Its Projects section carries the
            show/hide list the old ProjectVisibilityModal held. */}
        <IconButton label="User customizations & marketplace" variant="boxed" size={28} onClick={() => onOpenGlobalCustomizations?.()}>
          {DOTS_V_SVG}
        </IconButton>
      </div>
      <div className={styles.railFilter}>
        <TextInput value={railFilter} onChange={setRailFilter} placeholder="filter sessions…" />
      </div>
      <div className={styles.body}>
        {totalProjects === 0 ? (
          <div className={styles.empty}>No projects yet — start a session with claude or codex in a repo to see it here.</div>
        ) : !hasAnySessions ? (
          <div className={styles.empty}>No sessions yet in any project.</div>
        ) : railActive && filteredProjects.length === 0 ? (
          <div className={styles.empty}>No sessions match “{railFilter.trim()}”.</div>
        ) : (
          filteredProjects.map((p) => {
            const proj = p as Project & { open?: boolean };
            const entry = byProject[p.id];
            const { shown, hasMore, filtered } = visibleSessions(p);
            // A sidebar-wide match forces the project open even if collapsed.
            const open = proj.open || railActive;
            const pinned = config.pins.includes(p.id);
            const isHidden = config.hidden.includes(p.id);
            // Rollup precedence (Spec 3): waiting > done-unviewed > working/live.
            // SessionMeta (server) has no waiting/unviewed concept — those live
            // only on the client's term tabs, so derive from state.tabs for this
            // project and fall back to SessionMeta.live for the plain-live case.
            const projTabs = state.tabs.filter((t) => t.kind === 'term' && t.projectId === p.id);
            const anyWaiting = projTabs.some((t) => t.status === 'waiting');
            const anyUnviewed = projTabs.some((t) => t.unviewed);
            const anyLive = projTabs.some((t) => t.status !== 'waiting') || (entry?.sessions ?? []).some((s) => s.live);
            const projDotStatus: 'waiting' | 'unviewed' | 'live' = anyWaiting ? 'waiting' : anyUnviewed ? 'unviewed' : 'live';
            const showFilterInput = p.sessionCount > FILTER_THRESHOLD;

            return (
              <div
                key={p.id}
                className={`${styles.proj} ${dragOverId === p.id ? styles.dragOver : ''} ${dragProjId === p.id ? styles.dragging : ''} ${isHidden ? styles.hidden : ''}`}
                onDragOver={(e: DragEvent) => {
                  if (!dragProjId || dragProjId === p.id) return;
                  e.preventDefault();
                  setDragOverId(p.id);
                }}
                onDrop={(e: DragEvent) => {
                  e.preventDefault();
                  handleProjDrop(p.id);
                }}
                onDragLeave={() => setDragOverId(null)}
              >
                <div
                  role="button"
                  tabIndex={0}
                  className={styles.projHead}
                  draggable
                  title={p.path}
                  onClick={() => handleToggleProj(proj)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleToggleProj(proj);
                    }
                  }}
                  onDragStart={() => setDragProjId(p.id)}
                  onDragEnd={() => {
                    setDragProjId(null);
                    setDragOverId(null);
                  }}
                >
                  {/* Two-row head: name row keeps full width (no button squeeze),
                      actions get their OWN line below, hover-revealed. */}
                  <span className={styles.headRow}>
                    <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`}>▶</span>
                    <span className={styles.name}>{p.name}</span>
                    {pinned ? (
                      <span className={styles.pinnedAlways}>
                        <IconButton label="Unpin" active onClick={(e) => handleTogglePin(e, p.id)}>
                          {PIN_SVG}
                        </IconButton>
                      </span>
                    ) : null}
                    {anyLive ? <StatusDot status={projDotStatus} size={7} /> : null}
                    {/* Provider filter active → show that provider's count, not the total. */}
                    <span className={styles.count}>
                      {provFilter === 'all' ? p.sessionCount : p.sessionCountByProvider?.[provFilter] ?? 0}
                    </span>
                    <IconButton
                      label="Customizations"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenCustomizations?.({ projectId: p.id, projectName: p.name });
                      }}
                    >
                      {DOTS_V_SVG}
                    </IconButton>
                  </span>
                  <span className={styles.actionsRow}>
                    {!pinned ? (
                      <IconButton label="Pin to top" onClick={(e) => handleTogglePin(e, p.id)}>
                        {PIN_SVG}
                      </IconButton>
                    ) : null}
                    <IconButton
                      label="Shared scratchpad"
                      onClick={(e) => {
                        e.stopPropagation();
                        dispatch({ type: 'openScratchpad', projectId: p.id, label: `${p.name} · scratchpad` });
                      }}
                    >
                      {LINES_SVG}
                    </IconButton>
                    <IconButton
                      label="New session"
                      onClick={(e) => {
                        e.stopPropagation();
                        setModalProject(p);
                      }}
                    >
                      {PLUS_SVG}
                    </IconButton>
                  </span>
                </div>
                <div className={`${styles.sessions} ${open ? styles.open : ''}`}>
                  {showFilterInput ? (
                    <div className={styles.filterWrap}>
                      <TextInput
                        value={projFilter[p.id] ?? ''}
                        onChange={(v) => setProjFilterState((prev) => ({ ...prev, [p.id]: v }))}
                        placeholder="filter…"
                      />
                    </div>
                  ) : null}
                  {shown.map((s) => (
                    <div key={s.id}>
                    <button
                      type="button"
                      className={`${styles.sess} ${s.id === activeSessionId ? styles.selected : ''}`}
                      onClick={() =>
                        dispatch({
                          type: 'openSession',
                          sessionId: s.id,
                          projectId: s.projectId,
                          label: s.title || s.branch || 'untitled',
                          // Open the read-only transcript. A live session that seshmux
                          // itself spawned is rehydrated as a term tab via getLive() on
                          // load; clicking a rail row (which has no PTY handle) always
                          // opens the transcript rather than a PTY-less blank term.
                          kind: 'transcript',
                          provider: s.provider,
                          status: s.live ? 'live' : 'done',
                        })
                      }
                    >
                      <span className={styles.sessDot}>
                        <StatusDot status={sessDotStatus(s, projTabs)} size={7} />
                      </span>
                      <span className={styles.sessInfo}>
                        <div className={styles.sessTop}>
                          {/* Workspace sessions carry the agent/<slug>-<n> branch this
                              rail already displays — no server flag needed, the
                              naming convention (Spec 1) IS the marker. */}
                          {s.branch?.startsWith('agent/') ? (
                            <span className={styles.workspaceMark} title="Workspace session">⑃</span>
                          ) : null}
                          <span className={styles.sessTitle}>{s.title || s.branch || 'untitled'}</span>
                          {showProvider ? (
                            <span className={`${styles.sessAgent} ${styles[s.provider]}`}>{s.provider}</span>
                          ) : null}
                        </div>
                        <div className={styles.sessSub}>
                          {s.branch ? `${s.branch} · ` : ''}
                          {timeAgo(s.mtime)}
                          {!s.live && s.durationMs ? ` · ${formatDuration(s.durationMs)}` : ''}
                        </div>
                      </span>
                    </button>
                    {/* PRs created in this session — fetch only while the
                        project is expanded (rows stay mounted when collapsed). */}
                    {open ? <PrList projectId={s.projectId} sessionId={s.id} /> : null}
                    </div>
                  ))}
                  {filtered && !shown.length ? <div className={styles.noMatch}>no matching sessions</div> : null}
                  {!filtered && hasMore ? (
                    <button type="button" className={styles.loadMore} onClick={() => loadMore(p.id)}>
                      load more…
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
      </div>
      {sessionsPos === 'bottom' ? sessionsPanel : null}
      {modalProject ? (
        <NewSessionModal
          projectPath={modalProject.path}
          projectName={modalProject.name}
          providers={availableProviders}
          onStart={handleStartSession}
          onPlanoff={() => {
            const project = modalProject;
            setModalProject(null);
            // Thread the requesting session (active tab in THIS project) so plan-off
            // runs in its real cwd — a folded worktree, not the parent repo.
            const active = state.tabs.find((t) => t.id === state.activeTab);
            const sessionId = active?.projectId === project.id ? active.sessionId : undefined;
            dispatch({ type: 'openPlanoff', projectId: project.id, label: project.name, sessionId });
          }}
          onStartWorkspace={(provider, mode) => {
            const project = modalProject;
            setModalProject(null);
            if (project) void doCreateWorkspace(project, provider, mode);
          }}
          onStartTeam={() => {
            const project = modalProject;
            setModalProject(null);
            if (project) setTeamProject(project);
          }}
          teamsGateOk={teamsGateOk}
          onClose={() => setModalProject(null)}
        />
      ) : null}
      {teamProject ? (
        <TeamModal
          projectName={teamProject.name}
          onStart={handleStartTeam}
          onClose={() => setTeamProject(null)}
        />
      ) : null}
    </aside>
  );
}

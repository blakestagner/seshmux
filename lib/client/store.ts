// App state: React context + useReducer (no zustand). Ported from the
// mockup's global `openTabs`/`activeTab`/`projects` script state.
'use client';
import { createElement, createContext, useContext, useReducer, type ReactNode } from 'react';
import type { ProviderId, Project, Config } from './types';

export type Tab = {
  id: string;
  kind: 'term' | 'transcript' | 'settings' | 'scratchpad' | 'planoff';
  sessionId?: string;
  projectId?: string;
  label: string;
  provider?: ProviderId;
  status?: 'live' | 'waiting' | 'done';
  linked?: boolean;
  linkedKind?: 'handoff' | 'review';
  linkSrc?: string;
  // Task 14 (all optional — additive): live-terminal tabs carry a daemon PTY id;
  // branch/ctx feed the terminal statusbar + grid tile. ctx.window from provider.
  ptyId?: string;
  branch?: string | null;
  ctx?: { tokens: number; window: number } | null;
  // Spec 3 (done-unviewed): set when this tab finished (working→idle/waiting)
  // while not the focused tab. Cleared on activateTab. Client-side only — no
  // server status value, no EventMessage change (page.tsx owns the raw
  // NIStatus transition detection; the store just holds/clears the flag).
  unviewed?: boolean;
  // Agents view (docs/todo/2026-07-10-agents-view.md): raw agent status as
  // last reported by the events feed (tab.status collapses working+idle into
  // 'live' for the dot — the four-state rollup needs them distinct), plus the
  // time of the last status transition (card "18m ago").
  ni?: 'working' | 'waiting' | 'idle';
  lastStatusTs?: number;
  // Teams v1 (Task 6): set true the moment a term tab is KNOWN to be a claude-swarm
  // team lead — either at fresh-start (Rail's handleStartTeam knows it explicitly)
  // or resolved later (rehydrate/resume one-shot GET /api/teams/members?leadSession=).
  // teamName fills in once that resolution succeeds; activeTeam() gates on
  // isTeamLead + sessionId (not teamName) so the split layout appears immediately at
  // fresh-start instead of jumping in once the async lookup returns.
  isTeamLead?: boolean;
  teamName?: string;
};

export type RailSort = 'updated' | 'created';

export type AppState = {
  tabs: Tab[];
  activeTab: string | null;
  view: 'tabs' | 'grid' | 'agents';
  // Settings is a full-page overlay (not a tab): it replaces the workspace main
  // content while open, so it renders from grid OR tabs view. `view` is left
  // untouched so closing returns to exactly the prior screen.
  settingsOpen: boolean;
  provFilter: 'all' | ProviderId;
  railSort: RailSort;
  projects: Project[];
  config: Config;
  // Session-local bypass for the rail's hidden-project filter — never persisted.
  showHidden: boolean;
};

export type Action =
  | { type: 'openSession'; sessionId: string; projectId: string; label: string; kind: 'term' | 'transcript'; provider?: ProviderId; status?: 'live' | 'waiting' | 'done' }
  | { type: 'openTerm'; ptyId: string; projectId: string; label: string; provider?: ProviderId; branch?: string | null; linked?: boolean; linkedKind?: 'handoff' | 'review'; linkSrc?: string; sessionId?: string; isTeamLead?: boolean }
  | { type: 'resumeToTerm'; tabId: string; ptyId: string }
  // Teams v1 (Task 6): a term tab's team identity resolved (fresh-start bind,
  // rehydrate, or resume one-shot check against GET /api/teams/members?leadSession=).
  | { type: 'setTabTeam'; tabId: string; teamName: string }
  // events-ws status (keyed by ptyId) → the matching term tab's dot.
  | { type: 'setTermStatus'; ptyId: string; status: 'live' | 'waiting' | 'done'; ni?: 'working' | 'waiting' | 'idle'; ts?: number }
  // Spec 3: mark a tab done-but-unviewed (page.tsx detects the working→idle/
  // waiting transition + focus state; this just flips the flag).
  | { type: 'markUnviewed'; ptyId: string }
  // events-ws ctx (keyed by sessionId) → the matching tab's statusbar meter.
  | { type: 'setTermCtx'; sessionId: string; ctx: { tokens: number; window: number } | null }
  // Backfill a term tab's sessionId once it's learned (bridge resolves 'latest'
  // to a real id) — buildBlocks pairs source↔linked by sessionId, so without
  // this a live tab that bridged via 'latest' never forms a split pair.
  | { type: 'setTabSession'; tabId: string; sessionId: string }
  | { type: 'openSettings' }
  | { type: 'closeSettings' }
  | { type: 'openScratchpad'; projectId: string; label: string }
  | { type: 'openPlanoff'; projectId: string; label: string }
  | { type: 'closeTab'; id: string }
  | { type: 'activateTab'; id: string }
  | { type: 'moveTabBlock'; from: string; to: string }
  | { type: 'setView'; view: 'tabs' | 'grid' | 'agents' }
  | { type: 'setProvFilter'; filter: 'all' | ProviderId }
  | { type: 'setRailSort'; sort: RailSort }
  | { type: 'collapseAllProjects' }
  | { type: 'toggleProject'; id: string }
  | { type: 'setFilter'; id: string; filter: string }
  | { type: 'loadOlder'; id: string; chunk?: number }
  | { type: 'togglePin'; id: string }
  | { type: 'toggleHidden'; id: string }
  | { type: 'setShowHidden'; on: boolean }
  | { type: 'moveProject'; from: string; to: string }
  | { type: 'setProjects'; projects: Project[] }
  | { type: 'setConfig'; config: Config };

const LOAD_CHUNK = 5;

export function initialState(overrides?: Partial<AppState>): AppState {
  return {
    tabs: [],
    activeTab: null,
    view: 'tabs',
    settingsOpen: false,
    provFilter: 'all',
    railSort: 'updated',
    projects: [],
    config: { pins: [], projectOrder: [], hidden: [], theme: 'dark', accent: 'iris', settings: {}, gridLayout: null, gridNamedLayouts: {} },
    showHidden: false,
    ...overrides,
  };
}

// A block = a source tab + every tab linked (handoff/review) off it. Blocks
// move as one unit and can never be split or straddled.
// Ported verbatim from mockup.html buildBlocks() (~line 1425).
function buildBlocks(tabs: Tab[]): Tab[][] {
  const blocks: Tab[][] = [];
  const used = new Set<string>();
  for (const t of tabs) {
    if (used.has(t.id)) continue;
    const src = t.linked ? tabs.find((x) => !x.linked && x.sessionId === t.linkSrc) : t;
    const anchor = src ?? t;
    const members = [anchor, ...tabs.filter((x) => x.linked && anchor.sessionId && x.linkSrc === anchor.sessionId)];
    members.forEach((m) => used.add(m.id));
    blocks.push(members);
  }
  return blocks;
}

// Linked-pair split (tabs view): if `activeId` belongs to a bridge block with a
// linked member, return { source, linked } to render side by side. Reuses the
// same buildBlocks() pairing as DnD so the two never diverge. buildBlocks puts
// the source (anchor) at index 0 and linked members after it in tabs-order;
// openTerm appends, so the last linked member is the most-recently opened one
// (requirement 4: source active → pair with newest linked). Returns null when
// the active tab has no linked partner (block length < 2), so the single-pane
// view renders normally — including after either member is closed.
export function activePair(tabs: Tab[], activeId: string | null): { source: Tab; linked: Tab } | null {
  if (!activeId) return null;
  const active = tabs.find((t) => t.id === activeId);
  if (!active) return null;
  const block = buildBlocks(tabs).find((b) => b.some((t) => t.id === activeId));
  if (!block || block.length < 2) return null;
  const source = block[0];
  const linkedMembers = block.slice(1);
  const linked = active.linked ? active : linkedMembers[linkedMembers.length - 1];
  return { source, linked };
}

// Teams v1 (Task 6): mirrors activePair's gate pattern — null when the active
// tab isn't a (known) team lead, else the lead tab + its leadSessionId (== the
// tab's own sessionId; a team's config.json is keyed by the lead's session id,
// which survives resume). Gates on isTeamLead + sessionId, NOT teamName —
// teamName resolves asynchronously (fresh start knows isTeamLead immediately,
// before claude-swarm's config.json / the session's own jsonl exist yet), so
// gating on it would flash a full-width terminal before jumping to the split.
export function activeTeam(tabs: Tab[], activeId: string | null): { tab: Tab; leadSessionId: string } | null {
  if (!activeId) return null;
  const tab = tabs.find((t) => t.id === activeId);
  if (!tab || tab.kind !== 'term' || !tab.isTeamLead || !tab.sessionId) return null;
  return { tab, leadSessionId: tab.sessionId };
}

// Ported from mockup.html tabDrop() (~line 1438): move the block containing
// `from` to sit where the block containing `to` is.
function moveTabBlock(tabs: Tab[], from: string, to: string): Tab[] {
  if (from === to) return tabs;
  const blocks = buildBlocks(tabs);
  const bi = blocks.findIndex((b) => b.some((t) => t.id === from));
  const ti = blocks.findIndex((b) => b.some((t) => t.id === to));
  if (bi < 0 || ti < 0 || bi === ti) return tabs;
  const [moved] = blocks.splice(bi, 1);
  blocks.splice(ti > bi ? ti - 1 : ti, 0, moved);
  return blocks.flat();
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'openSession': {
      const existing = state.tabs.find((t) => t.sessionId === action.sessionId);
      // Grid renders ONLY term tabs — activating a non-term tab while in grid
      // view would show nothing at all. Land on a term tab → stay in grid (its
      // tile highlights); land on anything else → drop to tabs view so the
      // opened tab is actually visible.
      const viewFor = (kind: Tab['kind']) =>
        (state.view === 'grid' || state.view === 'agents') && kind !== 'term' ? ('tabs' as const) : state.view;
      // Opening/activating a tab always leaves the settings overlay (else the
      // navigated-to tab would sit hidden behind Settings — TopNav search + the
      // needs-input toast can both fire while settings is open).
      if (existing)
        return {
          ...state,
          tabs: clearUnviewed(state.tabs, existing.id),
          activeTab: existing.id,
          settingsOpen: false,
          view: viewFor(existing.kind),
        };
      const tab: Tab = {
        id: 'tab-' + action.sessionId,
        kind: action.kind,
        sessionId: action.sessionId,
        projectId: action.projectId,
        label: action.label,
        provider: action.provider,
        status: action.status,
      };
      return { ...state, tabs: [...state.tabs, tab], activeTab: tab.id, settingsOpen: false, view: viewFor(tab.kind) };
    }
    case 'openTerm': {
      // Term tabs dedup by ptyId (a fresh session has NO sessionId until the
      // agent writes jsonl, so sessionId-keying would collide). One tab per PTY.
      const existing = state.tabs.find((t) => t.kind === 'term' && t.ptyId === action.ptyId);
      if (existing) return { ...state, tabs: clearUnviewed(state.tabs, existing.id), activeTab: existing.id, settingsOpen: false };
      const tab: Tab = {
        id: 'term-' + action.ptyId,
        kind: 'term',
        ptyId: action.ptyId,
        projectId: action.projectId,
        label: action.label,
        provider: action.provider,
        branch: action.branch ?? null,
        status: 'live',
        linked: action.linked,
        linkedKind: action.linkedKind,
        linkSrc: action.linkSrc,
        sessionId: action.sessionId,
        isTeamLead: action.isTeamLead,
      };
      return { ...state, tabs: [...state.tabs, tab], activeTab: tab.id, settingsOpen: false };
    }
    case 'setTabTeam':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId ? { ...t, isTeamLead: true, teamName: action.teamName } : t,
        ),
      };
    case 'resumeToTerm': {
      // Convert a transcript tab into a live term IN PLACE — same tab id, so it
      // keeps its DnD position and any linked-pair grouping (plan Task 14).
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId
            ? { ...t, kind: 'term', ptyId: action.ptyId, status: 'live' }
            : t,
        ),
        activeTab: action.tabId,
        settingsOpen: false,
      };
    }
    case 'setTermStatus':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.kind === 'term' && t.ptyId === action.ptyId
            ? { ...t, status: action.status, ...(action.ni ? { ni: action.ni } : {}), ...(action.ts ? { lastStatusTs: action.ts } : {}) }
            : t,
        ),
      };
    case 'markUnviewed':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.kind === 'term' && t.ptyId === action.ptyId ? { ...t, unviewed: true } : t,
        ),
      };
    case 'setTermCtx':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.sessionId === action.sessionId ? { ...t, ctx: action.ctx } : t,
        ),
      };
    case 'setTabSession':
      return {
        ...state,
        tabs: state.tabs.map((t) => (t.id === action.tabId ? { ...t, sessionId: action.sessionId } : t)),
      };
    case 'openSettings':
      // Full-page overlay, not a tab. `view` is untouched so closing returns to
      // exactly the prior screen (tabs or grid).
      return { ...state, settingsOpen: true };
    case 'closeSettings':
      return { ...state, settingsOpen: false };
    case 'openScratchpad': {
      const id = 'tab-scratch-' + action.projectId;
      const existing = state.tabs.find((t) => t.id === id);
      if (existing) return { ...state, activeTab: existing.id, settingsOpen: false };
      const tab: Tab = { id, kind: 'scratchpad', projectId: action.projectId, label: action.label };
      return { ...state, tabs: [...state.tabs, tab], activeTab: tab.id, settingsOpen: false };
    }
    case 'openPlanoff': {
      const id = 'tab-planoff-' + action.projectId + '-' + Date.now();
      const tab: Tab = { id, kind: 'planoff', projectId: action.projectId, label: action.label };
      return { ...state, tabs: [...state.tabs, tab], activeTab: id, settingsOpen: false };
    }
    case 'closeTab': {
      const i = state.tabs.findIndex((t) => t.id === action.id);
      if (i < 0) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      const activeTab = state.activeTab === action.id ? (tabs.length ? tabs[Math.max(0, i - 1)].id : null) : state.activeTab;
      return { ...state, tabs, activeTab };
    }
    case 'activateTab':
      return { ...state, tabs: clearUnviewed(state.tabs, action.id), activeTab: action.id, settingsOpen: false };
    case 'moveTabBlock':
      return { ...state, tabs: moveTabBlock(state.tabs, action.from, action.to) };
    case 'setView':
      return { ...state, view: action.view };
    case 'setProvFilter':
      return { ...state, provFilter: action.filter };
    case 'setRailSort':
      return { ...state, railSort: action.sort };
    case 'collapseAllProjects':
      return {
        ...state,
        projects: state.projects.map((p) =>
          (p as Project & { open?: boolean }).open ? { ...p, open: false, loaded: 0, filter: '' } as Project : p,
        ),
      };
    case 'toggleProject':
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.id ? { ...p, ...toggleProjectPatch(p) } : p,
        ),
      };
    case 'setFilter':
      return {
        ...state,
        projects: state.projects.map((p) => (p.id === action.id ? { ...p, filter: action.filter } as Project : p)),
      };
    case 'loadOlder':
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.id
            ? { ...p, loaded: ((p as Project & { loaded?: number }).loaded ?? 0) + (action.chunk ?? LOAD_CHUNK) }
            : p,
        ),
      };
    case 'togglePin':
      return {
        ...state,
        config: {
          ...state.config,
          pins: state.config.pins.includes(action.id)
            ? state.config.pins.filter((id) => id !== action.id)
            : [...state.config.pins, action.id],
        },
      };
    case 'toggleHidden':
      return {
        ...state,
        config: {
          ...state.config,
          hidden: state.config.hidden.includes(action.id)
            ? state.config.hidden.filter((id) => id !== action.id)
            : [...state.config.hidden, action.id],
        },
      };
    case 'setShowHidden':
      return { ...state, showHidden: action.on };
    case 'moveProject': {
      const from = state.projects.findIndex((p) => p.id === action.from);
      const to = state.projects.findIndex((p) => p.id === action.to);
      if (from < 0 || to < 0) return state;
      const projects = [...state.projects];
      const [moved] = projects.splice(from, 1);
      projects.splice(to, 0, moved);
      return { ...state, projects };
    }
    case 'setProjects':
      return { ...state, projects: action.projects };
    case 'setConfig':
      // Normalize at the store boundary: the server may be an OLDER version
      // than this client (stateless-server restarts/updates are a supported
      // scenario), so /api/config can arrive without newer fields like
      // `hidden`. Never trust the wire shape — missing arrays become empty,
      // not undefined (Rail filters crash on config.hidden.includes otherwise).
      return {
        ...state,
        config: {
          ...initialState().config,
          ...action.config,
          pins: Array.isArray(action.config.pins) ? action.config.pins : [],
          projectOrder: Array.isArray(action.config.projectOrder) ? action.config.projectOrder : [],
          hidden: Array.isArray(action.config.hidden) ? action.config.hidden : [],
        },
      };
    default:
      return state;
  }
}

// Spec 3: pure decision for whether a status transition should mark a tab
// done-unviewed. `prev`/`next` are raw NIStatus values (page.tsx owns the
// events-ws subscription and tracks `prev` per ptyId — the reducer never
// sees raw NIStatus, only the mapped Tab['status']). A transition is
// working → (idle | waiting); no prior status (first event / replay) never
// counts, so reconnect replay bursts can't spuriously mark tabs. Marks when
// the tab isn't the focused one OR the browser tab is hidden, so a session
// finishing in a background BROWSER tab still surfaces even if it happened
// to be the "active" seshmux tab underneath.
export function shouldMarkUnviewed(
  prev: 'working' | 'waiting' | 'idle' | undefined,
  next: 'working' | 'waiting' | 'idle',
  isActiveTab: boolean,
  documentHidden: boolean,
): boolean {
  const isDoneTransition = prev === 'working' && (next === 'idle' || next === 'waiting');
  if (!isDoneTransition) return false;
  return !isActiveTab || documentHidden;
}

// BUG A part 1 (live fresh-spawn bind): a session-new/session-touch event carries
// {projectId, sessionId} for a session that just started writing jsonl. Find the
// live term tab it belongs to so page.tsx can dispatch setTabSession and arm the
// subagent chip immediately, instead of waiting for a reload round-trip through
// GET /api/sessions/live. Never rebinds a tab that already has a sessionId — a
// fresh spawn is the ONLY case with no sessionId yet, so this can't clobber a
// resolved live tab. Ambiguity ceiling (same as bridge.ts defaultResolveLatest):
// with 2+ unbound term tabs open on the same project, the most-recently-opened
// (last in tabs order) wins.
export function findTabToBindSession(tabs: Tab[], projectId: string): string | null {
  const candidates = tabs.filter((t) => t.kind === 'term' && t.projectId === projectId && !t.sessionId);
  return candidates.length ? candidates[candidates.length - 1].id : null;
}

// Spec 3: clears the done-unviewed flag on the tab being focused. Used by
// every action that focuses a tab (activateTab, and the existing-tab dedup
// branches of openSession/openTerm).
function clearUnviewed(tabs: Tab[], tabId: string): Tab[] {
  return tabs.map((t) => (t.id === tabId && t.unviewed ? { ...t, unviewed: false } : t));
}

// toggleProject collapse evicts the load-more window + filter, mirroring
// mockup.html toggleProj() (~line 1350). `open`/`loaded`/`filter` aren't in
// the Task 3 Project shape, so they're tracked as loose extra fields here.
function toggleProjectPatch(p: Project): Partial<Project> & { open?: boolean; loaded?: number; filter?: string } {
  const cur = p as Project & { open?: boolean };
  const open = !cur.open;
  return open ? { open } : { open, loaded: 0, filter: '' };
}

const AppStateContext = createContext<{ state: AppState; dispatch: React.Dispatch<Action> } | null>(null);

export function AppStateProvider({ children, initial }: { children: ReactNode; initial?: Partial<AppState> }) {
  const [state, dispatch] = useReducer(reducer, initialState(initial));
  return createElement(AppStateContext.Provider, { value: { state, dispatch } }, children);
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider');
  return ctx;
}

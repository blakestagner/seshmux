// Thin typed fetch helpers for the REST API (Task 7). Relative paths only —
// server and client share an origin, so no base URL config needed.
import type {
  Project,
  SessionMeta,
  Config,
  ProviderId,
  CustomizationItem,
  SubagentNode,
  SubagentDetail,
} from './types';

// Per-process auth token embedded in the served HTML (Task 6.5). Sent on every /api/*
// call; the server 401s without it. WS clients read the same global for their query param.
declare global {
  interface Window {
    __SESHMUX_TOKEN?: string;
  }
}

function authToken(): string {
  return typeof window !== 'undefined' ? window.__SESHMUX_TOKEN ?? '' : '';
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      // Only claim a JSON body when one exists — Fastify 400s an
      // application/json request whose body is empty (body-less POSTs).
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      'x-seshmux-token': authToken(),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    // Surface the server's {error} message when present — callers show it to the user.
    const body = await res.json().catch(() => null);
    const msg = body && typeof body.error === 'string' ? body.error : `${path} -> ${res.status}`;
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export { authToken };

export function getProjects(): Promise<Project[]> {
  return req('/api/projects');
}

/** Deep width-correct scrollback for a live PTY (tmux capture-pane via the
 *  daemon's additive history RPC). Throws on older daemons (501) — callers
 *  degrade by leaving the screen as-is. */
export function getTermHistory(ptyId: string, lines = 2000): Promise<{ data: string }> {
  return req(`/api/term/${encodeURIComponent(ptyId)}/history?lines=${lines}`);
}

export function getSessions(
  projectId: string,
  opts?: { before?: number; limit?: number; q?: string },
): Promise<SessionMeta[]> {
  const qs = new URLSearchParams();
  if (opts?.before != null) qs.set('before', String(opts.before));
  if (opts?.limit != null) qs.set('limit', String(opts.limit));
  if (opts?.q) qs.set('q', opts.q);
  const suffix = qs.toString() ? `?${qs}` : '';
  return req(`/api/projects/${projectId}/sessions${suffix}`);
}

export type Msg = { role: 'user' | 'assistant'; text: string; tools: { name: string; input: string; output: string }[]; ts: number };
export type Ctx = { tokens: number; window: number; pct: number; model: string } | null;

// The route returns `meta` (the owning SessionMeta) alongside msgs/ctx — the URL
// carries no provider, so the server resolves it and hands back the full meta
// for the transcript header (title/branch/provider chips).
export function getTranscript(
  projectId: string,
  sessionId: string,
): Promise<{ msgs: Msg[]; ctx: Ctx; meta: SessionMeta; truncated?: boolean }> {
  return req(`/api/transcript/${projectId}/${sessionId}`);
}

export type SearchHit = { project: string; provider: ProviderId; sessionId: string; title: string; snippet: string; ts: number };

export function search(q: string): Promise<SearchHit[]> {
  return req(`/api/search?q=${encodeURIComponent(q)}`);
}

export function getEnv(): Promise<unknown> {
  return req('/api/env');
}

// Per-provider argv preview + capability flag for the New-session modal (hard rule 3 — the
// UI never hardcodes binary names/flags; the server derives this from provider.commands).
// Separate typed getter (rather than tightening getEnv's return) so the two existing
// getEnv() call sites — each casting to their OWN narrower local EnvResponse shape — don't
// have to widen their casts for a field they don't use.
export type CommandPreview = { fresh: string; continue: string; plan?: string; hasPlan: boolean };

export function getEnvCommands(): Promise<Record<ProviderId, CommandPreview>> {
  return req('/api/env').then((e) => (e as { commands?: Record<ProviderId, CommandPreview> }).commands ?? ({} as Record<ProviderId, CommandPreview>));
}

// Task 5 Step 1b: per-provider claude-swarm teammate backend — the Teams entry
// points gate on this (only 'tmux'/'iterm2' produce attachable member jsonls).
export function getEnvTeams(): Promise<Partial<Record<ProviderId, { teammateMode: string | null }>>> {
  return req('/api/env').then(
    (e) => (e as { teams?: Partial<Record<ProviderId, { teammateMode: string | null }>> }).teams ?? {},
  );
}

export function getUsage(days = 30): Promise<unknown> {
  return req(`/api/usage?days=${days}`);
}

export function getConfig(): Promise<Config> {
  return req('/api/config');
}

export function putConfig(cfg: Config): Promise<Config> {
  return req('/api/config', { method: 'PUT', body: JSON.stringify(cfg) });
}

// ── Terminal sessions (Task 13/14) ──────────────────────────────────────────
export type SessionMode = 'new' | 'continue' | 'plan';

export type TabMeta = {
  ptyId: string;
  provider: ProviderId;
  projectPath: string;
  mode: string;
  tmux: boolean;
  linked?: boolean;
  linkedKind?: 'handoff' | 'review';
  linkSrc?: string;
};

export function startSession(opts: {
  projectPath: string;
  provider: ProviderId;
  mode: SessionMode;
  resumeId?: string;
  firstPrompt?: string;
}): Promise<{ ptyId: string; tabMeta: TabMeta }> {
  return req('/api/sessions/start', { method: 'POST', body: JSON.stringify(opts) });
}

export type LiveSession = { ptyId: string; cwd: string; tmuxName: string | null; sessionId?: string };

export function getLive(): Promise<{ live: LiveSession[] }> {
  return req('/api/sessions/live');
}

// ── Agent bridge (Task 16.5 handoff/review, 16.8 plan-off) ──────────────────
// Signatures per lead-data's route contracts (server/routes/bridge.ts). Both
// handoff/review spawn the opposite-provider session seeded with a brief/diff.
export type BridgeStart = { ptyId: string; tabMeta: TabMeta; provider: ProviderId };

export function bridgeHandoff(projectId: string, sessionId: string): Promise<BridgeStart> {
  return req('/api/bridge/handoff', { method: 'POST', body: JSON.stringify({ projectId, sessionId }) });
}

export function bridgeReview(projectId: string, sessionId: string): Promise<BridgeStart> {
  return req('/api/bridge/review', { method: 'POST', body: JSON.stringify({ projectId, sessionId }) });
}

// PlanResult/PlanoffResult mirror server/lib/bridge/planoff.ts.
export type PlanResult = { provider: ProviderId; ok: boolean; plan: string; error?: string; durationMs: number };
export type PlanoffResult = { claude: PlanResult; codex: PlanResult };

export function bridgePlanoff(projectId: string, task: string): Promise<PlanoffResult> {
  return req('/api/bridge/planoff', { method: 'POST', body: JSON.stringify({ projectId, task }) });
}

export function bridgePlanoffPick(
  projectId: string,
  provider: ProviderId,
  task: string,
  planoff: PlanoffResult,
): Promise<BridgeStart> {
  return req('/api/bridge/planoff/pick', {
    method: 'POST',
    body: JSON.stringify({ projectId, provider, task, planoff }),
  });
}

// MCP bridge registration (Task 16.7 — Settings "Agent bridge" card Register button).
// /api/env returns bridge:{ claude:{registered}, codex:{registered} }; this POST writes
// the agent config (explicit, never silent).
export function registerBridge(): Promise<{ claude: boolean; codex: boolean }> {
  return req('/api/bridge/register', { method: 'POST' });
}

// ── Status hooks (Spec 2 — Settings "Deep agent integration" toggle) ────────
export interface HooksInstallState {
  available: boolean;
  installed: boolean;
  upToDate: boolean;
  version: number | null;
}
export function getHooksStatus(): Promise<Record<ProviderId, HooksInstallState>> {
  return req('/api/hooks/status');
}
export function installStatusHooks(provider: ProviderId): Promise<HooksInstallState> {
  return req('/api/hooks/install', { method: 'POST', body: JSON.stringify({ provider }) });
}
export function uninstallStatusHooks(provider: ProviderId): Promise<HooksInstallState> {
  return req('/api/hooks/uninstall', { method: 'POST', body: JSON.stringify({ provider }) });
}

// Approve/deny a pending MCP bridge cross-agent call (Task 16.7). Canonical path
// is /api/bridge/approval/:requestId. 404 = the request already timed out (server
// auto-denied) → the UI treats it as "too late, dismiss".
export function resolveApproval(requestId: string, approved: boolean): Promise<void> {
  return req(`/api/bridge/approval/${requestId}`, { method: 'POST', body: JSON.stringify({ approved }) });
}

// ── Shared scratchpad (Task 16.6) ───────────────────────────────────────────
export function getScratchpad(projectId: string): Promise<{ content: string }> {
  return req(`/api/scratchpad/${projectId}`);
}

export function putScratchpad(projectId: string, content: string): Promise<{ ok: boolean; content: string }> {
  return req(`/api/scratchpad/${projectId}`, { method: 'PUT', body: JSON.stringify({ content }) });
}

// ── Subagent viewer ─────────────────────────────────────────────────────────
// GET the flat subagent node tree for a session (empty for codex / no subagents).
export function getSubagents(project: string, session: string): Promise<{ nodes: SubagentNode[] }> {
  const qs = new URLSearchParams({ project, session });
  return req(`/api/subagents?${qs}`);
}

// GET one subagent's transcript detail (prompt/activity/outcome). Throws (404) if unknown.
export function getSubagentDetail(
  project: string,
  session: string,
  agent: string,
): Promise<SubagentDetail> {
  const qs = new URLSearchParams({ project, session, agent });
  return req(`/api/subagents/detail?${qs}`);
}

// ── macOS notification (Task 15) ────────────────────────────────────────────
// Server fires osascript when platform is darwin + config allows; returns
// delivered:false (never errors) otherwise. Injection-safe server-side, so pass
// raw title/body. Call unconditionally when a session goes waiting + doc hidden.
export function notify(title: string, body: string): Promise<{ ok: boolean; delivered: boolean; reason?: string }> {
  return req('/api/notify', { method: 'POST', body: JSON.stringify({ title, body }) });
}

// ── Self-update (Task 18) ───────────────────────────────────────────────────
export function checkUpdate(): Promise<{
  current: string;
  latest: string;
  updateAvailable: boolean;
  installMethod: 'global' | 'npx' | 'local';
}> {
  return req('/api/update/check');
}

export function applyUpdate(): Promise<{ ok: boolean; log: string; previous: string }> {
  return req('/api/update/apply', { method: 'POST' });
}

// ── Workspaces (v1.x Spec 1) ─────────────────────────────────────────────────
// One-click isolated git worktree + branch per session. Create reuses the
// SAME startSession result shape (ptyId/tabMeta) — server-side it flows
// through the shared startSession(), never a second spawn path.
export type WorkspaceRecord = { dir: string; branch: string; project: string; createdAt: number; filesChanged: number };

export function createWorkspace(
  projectId: string,
  provider?: ProviderId,
  mode?: SessionMode,
): Promise<{ ptyId: string; tabMeta: TabMeta; workspace: { dir: string; branch: string; project: string } }> {
  return req('/api/workspaces', { method: 'POST', body: JSON.stringify({ projectId, provider, mode }) });
}

export function listWorkspaces(projectId: string): Promise<WorkspaceRecord[]> {
  return req(`/api/workspaces?project=${encodeURIComponent(projectId)}`);
}

export type WorkspaceFinishMode = 'merge' | 'keep' | 'discard';

// force is discard-only — set true after the caller's own typed "discard"
// confirm. The server independently refuses a dirty discard without it.
export function finishWorkspace(dir: string, mode: WorkspaceFinishMode, force = false): Promise<{ ok: boolean }> {
  return req('/api/workspaces', { method: 'DELETE', body: JSON.stringify({ dir, mode, force }) });
}

// ── Customizations browser (v1) ─────────────────────────────────────────────
export interface CustomizationsPayload {
  agents: CustomizationItem[];
  skills: CustomizationItem[];
  instructions: CustomizationItem[];
  hooks: CustomizationItem[];
  mcp: CustomizationItem[];
}

export function getCustomizations(scope: 'global' | 'project', projectId?: string): Promise<CustomizationsPayload> {
  const q = scope === 'project' ? `?scope=project&project=${encodeURIComponent(projectId!)}` : '?scope=global';
  return req(`/api/customizations${q}`);
}

// ── Teams (v1, Task 5) ───────────────────────────────────────────────────────
export type TeamMemberTemplate = { name: string; role: string; model?: 'opus' | 'sonnet' | 'haiku' };
export type TeamTemplate = { name: string; members: TeamMemberTemplate[]; createdAt: number };
export type TeamDef = { name: string; members: TeamMemberTemplate[] };

export function getTeamTemplates(): Promise<TeamTemplate[]> {
  return req('/api/teams');
}

export type TeamStartPayload = {
  projectId: string;
  template?: TeamDef;
  inline?: TeamDef;
  task: string;
  saveTemplate?: boolean;
};

export function startTeam(payload: TeamStartPayload): Promise<{ tabMeta: TabMeta }> {
  return req('/api/teams/start', { method: 'POST', body: JSON.stringify(payload) });
}

// Mirror of server/lib/store/teams-store.ts TeamMemberInfo/TeamInfo — client never
// imports server code (hard rule 3), re-declared here same as Project/SessionMeta.
// NOTE: no token/usage field exists on TeamMemberInfo server-side (Task 6 finding) —
// the roster shows "—" for token count rather than inventing a number or adding a
// heavy new per-member parse.
export type TeamMemberInfo = {
  name: string;
  agentType?: string;
  model?: string;
  color?: string;
  role?: string;
  backendType?: 'tmux' | 'in-process';
  isActive?: boolean;
  joinedAt: number;
  sessionId: string | null;
};

export type TeamInfo = {
  teamName: string;
  leadSessionId: string;
  createdAt: number;
  members: TeamMemberInfo[];
};

// GET /api/teams/members?leadSession=<id> — resolves + arms the live roster watch
// (Task 4) on first call for this team. 404 (thrown by `req`) means either "not a
// team lead" or "team dir gone" — callers distinguish by whether they'd resolved
// before.
export function getTeamMembers(leadSessionId: string): Promise<TeamInfo> {
  return req(`/api/teams/members?leadSession=${encodeURIComponent(leadSessionId)}`);
}

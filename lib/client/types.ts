// Shared client-side types. Mirror of the server-side ProviderId (Task 3).
// Kept here so UI primitives (Task 8.5) and app state (Task 8) share ONE
// definition without either importing from the other's module.

export type ProviderId = 'claude' | 'codex';

// Task 3 shapes, re-declared here (not imported from server/) so client code
// never reaches into server/lib — client and server independently mirror
// these small types.
export type Project = {
  id: string;
  provider: ProviderId;
  name: string;
  path: string;
  sessionCount: number;
  createdAt: number;
  updatedAt: number;
  // Repo folder gone from disk (deleted worktree / tmp dir) — rail hides these.
  missing: boolean;
  // Per-provider split of sessionCount (set by the server-side merge).
  sessionCountByProvider?: Partial<Record<ProviderId, number>>;
};

export type SessionMeta = {
  id: string;
  provider: ProviderId;
  projectId: string;
  title: string;
  branch: string | null;
  mtime: number;
  startedAt: number | null;
  durationMs: number | null;
  live: boolean;
};

// Task 7 shape — GET/PUT /api/config
export type Config = {
  pins: string[];
  projectOrder: string[];
  hidden: string[];
  theme: string;
  accent: string;
  settings: Record<string, unknown>;
  gridLayout: unknown | null;
  gridNamedLayouts: Record<string, unknown>;
};

// Mirror of server/lib/store/prs.ts PrRef — client never imports server code.
export type PrRef = {
  url: string;
  owner: string;
  repo: string;
  number: number;
  title?: string;
};

// Mirror of server/lib/providers/types.ts SubagentNode/Detail — client never
// imports server code (hard rule 3), re-declared here. NOTE: no `jsonlPath` — the
// route strips that server-only absolute path before responding.
export type SubagentNode = {
  id: string;
  parentId: string | null;
  label: string;
  agentType: string | null;
  group: string | null;
  model: string | null;
  status: 'running' | 'done' | 'error';
  tokens: number | null;
  toolCalls: number | null;
  startedAt: number | null;
  endedAt: number | null;
};

export type SubagentActivity = { tool: string; summary: string };

export type SubagentDetail = {
  node: SubagentNode;
  prompt: string;
  activity: SubagentActivity[];
  outcome: { raw: string; kind: 'json' | 'text' };
};

// Mirror of server/lib/providers/customizations.ts CustomizationItem — client
// never imports server code (hard rule 3), so this is re-declared here same
// as Project/SessionMeta above.
export type CustomizationItem = {
  id: string;
  provider: ProviderId;
  scope: 'global' | 'project';
  filePath: string;
  title: string;
  meta: Record<string, string>;
  content: string;
  parseError?: string;
};

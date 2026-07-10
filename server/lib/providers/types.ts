// AgentProvider seam. Everything agent-specific (store paths, binary names, jsonl schema,
// ctx math, spawn/resume argv) lives behind this interface. HARD RULE 3: no `~/.claude` /
// `~/.codex` path and no agent binary name may appear outside server/lib/providers/.

import type { Ctx, Msg } from '../store/transcript';
import type { Project, ProviderId, SessionMeta } from '../store/scan';
import type { SearchHit, SearchOpts } from '../store/search';
import type { UsageSummary } from '../store/usage';
import type { CustomizationScanners } from './customizations';
import type { TeamInfo } from '../store/teams-store';

export type { Ctx, Msg } from '../store/transcript';
export type { Project, ProviderId, SessionMeta } from '../store/scan';
export type { SearchHit, SearchOpts } from '../store/search';
export type { UsageSummary } from '../store/usage';
export type { CustomizationItem, CustomizationScanners, CustomizationScope } from './customizations';
export type { TeamInfo, TeamMemberInfo } from '../store/teams-store';

export interface DetectResult {
  found: boolean;
  path?: string;
  version?: string;
  store?: { projects: number; bytes: number };
}

export interface ProviderCommands {
  fresh(cwd: string): string[];
  continue(cwd: string): string[];
  resume(cwd: string, id: string): string[];
  plan?(cwd: string): string[];
  // Headless (non-interactive) argv for the agent bridge. Binary names + sandbox flags live
  // here (hard rule 3) — the bridge caller only does execFile/output-capture, no CLI knowledge.
  // Both put the untrusted text AFTER a `--` end-of-options separator so it can't smuggle a flag.
  //   headlessPlan: read-only planning (plan-off). MUST be provably non-writing.
  //   headlessAsk:  a headless question (MCP ask_*). Sandbox is per-provider, unchanged.
  headlessPlan(cwd: string, task: string): string[];
  headlessAsk(cwd: string, prompt: string): string[];
}

export interface ListSessionOpts {
  before?: number;
  limit?: number;
  q?: string;
}

// Optional hook-based status authority (Spec 2). Providers that can install
// lifecycle hooks into the agent's own config implement this; providers that
// can't (no documented hook surface) omit it — callers must feature-test with
// `provider.statusHooks?.hooksAvailable()` before offering the Settings toggle.
export interface StatusHookSupport {
  hooksAvailable(): boolean;
  installHooks(): Promise<void>;
  uninstallHooks(): Promise<void>;
  hooksInstallState(): Promise<{ installed: boolean; upToDate: boolean; version: number | null }>;
}

// Subagent tree viewer (Spec: subagent-viewer). A flat node list; the tree is assembled
// client-side via parentId. jsonlPath is server-side only — routes strip it before responding.
export interface SubagentNode {
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
  jsonlPath?: string;
}

export interface SubagentActivity {
  tool: string;
  summary: string;
}

export interface SubagentDetail {
  node: SubagentNode;
  prompt: string;
  activity: SubagentActivity[];
  outcome: { raw: string; kind: 'json' | 'text' };
}

export interface SubagentSupport {
  list(projectId: string, sessionId: string): Promise<SubagentNode[]>;
  detail(projectId: string, sessionId: string, agentId: string): Promise<SubagentDetail | null>;
}

// Teams v1 (native `claude-swarm` teammates). Optional/feature-tested: only providers
// that have a documented team-roster file layout implement this — codex omits it, so
// call sites must guard with `provider.teams?`.
export interface TeamSupport {
  teamRoster(teamName: string): Promise<TeamInfo | null>;
  teamByLeadSession(leadSessionId: string): Promise<TeamInfo | null>; // for auto-name resolution
}

export interface AgentProvider {
  id: ProviderId;
  detect(): Promise<DetectResult>;
  scanProjects(): Promise<Project[]>;
  listSessions(projectId: string, opts?: ListSessionOpts): Promise<SessionMeta[]>;
  parseTranscript(projectId: string, sessionId: string): Promise<{ msgs: Msg[]; ctx: Ctx | null }>;
  readCtx(projectId: string, sessionId: string): Promise<Ctx | null>;
  search(q: string, opts?: SearchOpts): Promise<SearchHit[]>;
  usage(days: number): Promise<UsageSummary>;
  commands: ProviderCommands;
  needsInputPatterns: RegExp[];
  statusHooks?: StatusHookSupport;
  customizations?: CustomizationScanners;
  subagents?: SubagentSupport;
  teams?: TeamSupport;
}

// Lazily built registry: claude is always present; codex is included only when its store
// is detected on disk. Import providers here (not vice-versa) to avoid cycles.
let cached: AgentProvider[] | null = null;

export async function getProviders(): Promise<AgentProvider[]> {
  if (cached) return cached;
  const { ClaudeProvider } = await import('./claude');
  const { CodexProvider } = await import('./codex');

  const claude = new ClaudeProvider();
  const providers: AgentProvider[] = [claude];

  const codex = new CodexProvider();
  const codexDetect = await codex.detect();
  if (codexDetect.found || (codexDetect.store && codexDetect.store.projects > 0)) {
    providers.push(codex);
  }
  cached = providers;
  return providers;
}

// Test hook: reset the memoized registry.
export function _resetProviders(): void {
  cached = null;
}

// ClaudeProvider — the ONLY place the `~/.claude` store path and the `'claude'` binary
// name are allowed to live (hard rule 3). Wraps the provider-agnostic store utilities
// (Tasks 3–4), injecting root + provider id.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isSafeId, listSessions as scanListSessions, scanProjects as scan, storeBytes } from '../store/scan';
import { searchStore, type SearchHit, type SearchOpts } from '../store/search';
import { aggregateUsage, type UsageSummary } from '../store/usage';
import { parseTranscript as parse, readCtx as tailCtx } from '../store/transcript';
import { listSubagentNodes, parseSubagentDetail } from '../store/subagents';
import { teamRoster, teamByLeadSession } from '../store/teams-store';
import { loadNeedsInputPatterns } from './manifest';
import {
  hooksAvailable,
  hooksInstallState,
  installHooks,
  uninstallHooks,
} from './status-hooks';
import {
  scanHooksJson,
  scanInstructionFiles,
  scanMarkdownDir,
  scanMcpJson,
  scanSkillsDir,
  type CustomizationScanners,
  type CustomizationScope,
} from './customizations';
import type {
  AgentProvider,
  Ctx,
  DetectResult,
  ListSessionOpts,
  Msg,
  Project,
  ProviderCommands,
  SessionMeta,
  StatusHookSupport,
  SubagentSupport,
  TeamSupport,
} from './types';

const CLAUDE_BIN = 'claude';

// ponytail: prefix-matching by model family, not a lookup table — upgrade path is to add
// a family prefix here when a new 1M/200k model ships. Bare model names have no `[1m]`
// suffix and no context_window field in the jsonl, so the window must be inferred.
// Opus 4.5+ and fable/mythos 5 run a 1M window; opus 4.0/4.1 (pre-4.5) stayed at 200k, so
// only opus-4-5 and newer are matched here (NOT a bare "opus-4" prefix).
const WINDOW_1M_PREFIXES = ['opus-4-5', 'opus-4-6', 'opus-4-7', 'opus-4-8', 'fable-5', 'mythos-5'];

export function windowForModel(model: string): number {
  const m = model.toLowerCase();
  if (WINDOW_1M_PREFIXES.some((p) => m.includes(p))) return 1_000_000;
  // Sonnet/haiku/unknown all default to 200k. Claude Code's TUI reports sonnet against its
  // 200k default deployment window (1M sonnet is opt-in beta) and this meter must match the
  // TUI — empirically confirmed: a real Sonnet 4.6 session shows 62k/200k=31% in both. Do
  // NOT map sonnet to 1M.
  return 200_000;
}

function defaultRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

// Task 5 Step 1b: read-only, tolerant of a missing/malformed file — never
// throws, just reports "no opinion" so the client falls back to the disabled
// gate. Same settings.json the customizations `hooks` scanner reads.
async function readTeammateMode(settingsPath: string): Promise<string | undefined> {
  try {
    const cfg = JSON.parse(await readFile(settingsPath, 'utf8'));
    return typeof cfg?.teammateMode === 'string' ? cfg.teammateMode : undefined;
  } catch {
    return undefined;
  }
}

export interface ClaudeProviderOpts {
  root?: string;
  homeDir?: string;
}

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude' as const;
  private root: string;
  private homeDir: string;

  constructor(opts: ClaudeProviderOpts = {}) {
    this.homeDir = opts.homeDir ?? homedir();
    this.root = opts.root ?? (opts.homeDir ? join(opts.homeDir, '.claude', 'projects') : defaultRoot());
  }

  async detect(): Promise<DetectResult> {
    // Detecting the CLI binary + version is Task 6's job (detect.ts, via execFile).
    // Here we report only store presence so getProviders() can decide inclusion.
    let projects = 0;
    let bytes = 0;
    try {
      const ps = await scan(this.root, this.id);
      projects = ps.length;
      bytes = await storeBytes(this.root);
    } catch {
      /* no store */
    }
    return { found: projects > 0, store: { projects, bytes } };
  }

  scanProjects(): Promise<Project[]> {
    return scan(this.root, this.id);
  }

  listSessions(projectId: string, opts: ListSessionOpts = {}): Promise<SessionMeta[]> {
    return scanListSessions(projectId, { root: this.root, provider: this.id, ...opts });
  }

  parseTranscript(
    projectId: string,
    sessionId: string,
  ): Promise<{ msgs: Msg[]; ctx: Ctx | null; truncated: boolean }> {
    return parse(projectId, sessionId, this.root, windowForModel);
  }

  readCtx(projectId: string, sessionId: string): Promise<Ctx | null> {
    return tailCtx(join(this.root, projectId, `${sessionId}.jsonl`), windowForModel);
  }

  search(q: string, opts?: SearchOpts): Promise<SearchHit[]> {
    return searchStore(this.root, this.id, q, opts);
  }

  usage(days: number): Promise<UsageSummary> {
    return aggregateUsage(days, this.root, this.id);
  }

  commands: ProviderCommands = {
    fresh: () => [CLAUDE_BIN],
    // A bare positional prompt starts the interactive TUI with that prompt already
    // submitted (distinct from `-p`, which runs headless and exits). `--` shields it as
    // an end-of-options separator, same flag-proofing convention as headlessAsk below —
    // untrusted text can never be parsed as a flag even if it starts with `-`.
    freshPrompt: (_cwd, prompt) => [CLAUDE_BIN, '--', prompt],
    continue: () => [CLAUDE_BIN, '--continue'],
    // `--resume=<id>` (glued, not `--resume <id>`) so a hostile id starting with `-` can
    // never be parsed as a separate flag — flag-proof even if a caller skips validation.
    // Verified: the CLI accepts --resume=<id> (rejects a bad id as "not a UUID", i.e. it
    // parsed the value, not a flag). Defense-in-depth atop the route-layer reject guard.
    resume: (_cwd, id) => [CLAUDE_BIN, `--resume=${id}`],
    plan: () => [CLAUDE_BIN, '--permission-mode', 'plan'],
    // Headless read-only planning (plan-off): `-p --permission-mode plan` is provably
    // non-writing (verified via discovery — it plans, never writes). `--` shields the task.
    headlessPlan: (_cwd, task) => [CLAUDE_BIN, '-p', '--permission-mode', 'plan', '--', task],
    // Headless ask (MCP ask_claude): plain `-p` — same behavior as before this seam existed.
    headlessAsk: (_cwd, prompt) => [CLAUDE_BIN, '-p', '--', prompt],
  };

  // Waiting-state heuristics for Claude Code's TUI (Task 15, from real captured fixtures —
  // the permission-prompt chrome; AskUserQuestion renders the same `1. Yes` option list).
  // Matched against ANSI-stripped, whitespace-collapsed output (see needs-input.ts).
  // Patterns live in manifests/claude.json (Spec 4) — user-overridable, no inline regex here.
  needsInputPatterns: RegExp[] = loadNeedsInputPatterns('claude');

  // Hook-based status authority (Spec 2): registers Notification/Stop/
  // PermissionRequest hooks in ~/.claude/settings.json. Opt-in only — the
  // Settings toggle is the sole caller of install/uninstall.
  statusHooks: StatusHookSupport = {
    hooksAvailable,
    installHooks: () => installHooks(),
    uninstallHooks: () => uninstallHooks(),
    hooksInstallState: () => hooksInstallState(),
  };

  // Read-only customizations scanning (customizations browser v1). All paths
  // stay behind this provider (hard rule 3); see server/lib/providers/customizations.ts
  // for the generic scan helpers shared with codex.
  customizations: CustomizationScanners = {
    agents: (s) => scanMarkdownDir(this.custRoot(s, 'agents'), 'claude', s.kind),
    skills: (s) => scanSkillsDir(this.custRoot(s, 'skills'), 'claude', s.kind),
    instructions: (s) =>
      s.kind === 'global'
        ? scanInstructionFiles([join(this.homeDir, '.claude', 'CLAUDE.md')], 'claude', 'global')
        : scanInstructionFiles(
            [join(s.repoPath, 'CLAUDE.md'), join(s.repoPath, 'CLAUDE.local.md')],
            'claude',
            'project',
          ),
    hooks: (s) =>
      scanHooksJson(
        s.kind === 'global'
          ? join(this.homeDir, '.claude', 'settings.json')
          : join(s.repoPath, '.claude', 'settings.json'),
        'claude',
        s.kind,
      ),
    mcpServers: (s) =>
      s.kind === 'global'
        ? scanMcpJson(join(this.homeDir, '.claude.json'), 'claude', 'global')
        : scanMcpJson(join(s.repoPath, '.mcp.json'), 'claude', 'project'),
  };

  // Marketplace phase 2 (Task 4): plugin list/install argv. Verified against the real
  // CLI (commander-based): `--` ends option parsing for the whole remaining argv, so a
  // flag placed AFTER `--` (e.g. `-s user`) is silently swallowed as an inert extra
  // positional, NOT bound to the `-s/--scope` option — confirmed via
  // `claude plugin install -- foo -s badscope` accepting the bogus scope silently vs.
  // `claude plugin install -s badscope -- foo` correctly rejecting it. So `-s <scope>`
  // must come BEFORE `--`, with the untrusted plugin name shielded AFTER it (confirmed
  // `-- --sneaky-flag` installs a plugin literally named "--sneaky-flag", never parsed
  // as a flag).
  pluginCommands = {
    listAvailable: (): string[] => [CLAUDE_BIN, 'plugin', 'list', '--available', '--json'],
    listMarketplaces: (): string[] => [CLAUDE_BIN, 'plugin', 'marketplace', 'list', '--json'],
    install: (plugin: string, scope: 'user' | 'project'): string[] => [
      CLAUDE_BIN,
      'plugin',
      'install',
      '-s',
      scope,
      '--',
      plugin,
    ],
  };

  private custRoot(s: CustomizationScope, kind: 'agents' | 'skills'): string {
    return s.kind === 'global' ? join(this.homeDir, '.claude', kind) : join(s.repoPath, '.claude', kind);
  }

  customizationWriteTarget(scope: CustomizationScope, section: 'agents' | 'skills', name: string): string {
    const root = this.custRoot(scope, section);
    return section === 'skills' ? join(root, name, 'SKILL.md') : join(root, `${name}.md`);
  }

  // Read-only subagent-transcript viewer (subagent viewer v1). The `subagents/` +
  // `workflows/` layout knowledge stays in store/subagents.ts; this provider only
  // injects the absolute session dir (hard rule 3). Codex omits this capability, so its
  // `subagents` is undefined and the client chip never shows.
  subagents: SubagentSupport = {
    // Gate projectId against the (cached, cheap) scanned project list and reject any
    // traversal in sessionId before path-joining into the store (SEC-3). Both ids are
    // joined into an absolute ~/.claude path, so an unvalidated "../" would read an
    // arbitrary subagents dir off disk.
    list: async (projectId, sessionId) => {
      if (!(await this.isKnownSession(projectId, sessionId))) return [];
      return listSubagentNodes(join(this.root, projectId, sessionId));
    },
    detail: async (projectId, sessionId, agentId) => {
      if (!(await this.isKnownSession(projectId, sessionId))) return null;
      const nodes = await listSubagentNodes(join(this.root, projectId, sessionId));
      const node = nodes.find((n) => n.id === agentId);
      if (!node) return null;
      return parseSubagentDetail(node.jsonlPath ?? '', node);
    },
  };

  // True only when projectId is a real scanned project AND sessionId is separator-free.
  private async isKnownSession(projectId: string, sessionId: string): Promise<boolean> {
    if (!isSafeId(sessionId)) return false;
    const projects = await this.scanProjects();
    return projects.some((p) => p.id === projectId);
  }

  // Teams v1 (native `claude-swarm` teammates). Team-file layout knowledge stays in
  // store/teams-store.ts (provider-agnostic, mirrors scan.ts); only this provider
  // supplies the `.claude/teams` + `.claude/projects` paths (hard rule 3). Codex has
  // no team-roster file layout, so it omits `teams` entirely.
  teams: TeamSupport = {
    teamRoster: (teamName) => teamRoster(join(this.homeDir, '.claude', 'teams'), this.root, teamName),
    teamByLeadSession: (leadSessionId) =>
      teamByLeadSession(join(this.homeDir, '.claude', 'teams'), this.root, leadSessionId),
    configPath: (teamName) => join(this.homeDir, '.claude', 'teams', teamName, 'config.json'),
    teammateMode: () => readTeammateMode(join(this.homeDir, '.claude', 'settings.json')),
  };
}

// Re-export for callers that only need the store dir default (detect.ts, watch.ts).
export { defaultRoot as claudeStoreRoot };

// Watch config for server/lib/store/watch.ts (hard rule 3 — the store-agnostic watcher
// must not hardcode a provider's file layout). claude: <root>/<projectDir>/<id>.jsonl,
// one level below root -> chokidar depth 1.
export const claudeWatchConfig = {
  depth: 1,
  idsFromPath(filePath: string): { sessionId: string; projectId: string } {
    return {
      sessionId: basename(filePath).replace(/\.jsonl$/, ''),
      projectId: basename(dirname(filePath)),
    };
  },
};

// Watch config for events-hub's lazy subagent watcher (hard rule 3 — the `subagents/`
// layout stays here, not in events-hub). The dir is nested: subagents/agent-*.jsonl AND
// subagents/workflows/<wf>/agent-*.jsonl -> chokidar depth 2. Caller passes the store root
// (claudeStoreRoot()) so no ~/.claude path is built outside this module.
export const claudeSubagentWatchConfig = {
  depth: 2,
  sessionDir(root: string, projectId: string, sessionId: string): string {
    return join(root, projectId, sessionId, 'subagents');
  },
};

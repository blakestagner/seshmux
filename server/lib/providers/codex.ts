// CodexProvider — reads Codex CLI rollout logs. The ONLY place the `~/.codex` store path
// and the `codex` binary name are allowed to live (hard rule 3).
//
// SCHEMA DISCOVERY (from real ~/.codex/sessions files on Blake's machine, 2026-07-08;
// CLI versions 0.122.0-alpha.1 … 0.143.0 — schema drifts across versions, handled below):
//
// Store layout: ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl
//   Session id = the trailing uuid in the filename (also session_meta.payload.session_id).
//
// Every line: { timestamp, type, payload }. Relevant (type, payload.type):
//   ("session_meta", -)     payload: { session_id, cwd, cli_version, context_window,
//                                       git: { branch, commit_hash, repository_url } | null,
//                                       timestamp }
//                           -> cwd = project grouping; git.branch = branch (null on old CLIs).
//   ("event_msg","task_started")  payload.model_context_window = ctx window (e.g. 258400).
//   ("turn_context", -)     payload.model (e.g. "gpt-5.4", "gpt-5.4-mini"), effort.
//   ("event_msg","user_message")  payload.message = clean user text -> TITLE + user Msg.
//                           (Prefer this over response_item/message role:user, whose first
//                            entries are <environment_context>/<permissions> wrappers.)
//   ("event_msg","agent_message") payload.message = assistant text.
//   ("response_item","function_call")       payload: { name, arguments, call_id } -> tool.
//   ("response_item","function_call_output") payload: { call_id, output }        -> tool output.
//   ("event_msg","token_count")   payload.info may be NULL (old CLIs). When present:
//                           info.last_token_usage.total_tokens = current ctx tokens,
//                           info.model_context_window = window. Use the LAST non-null one.
//
// Ctx math: tokens = last token_count.info.last_token_usage.total_tokens; window from that
// same info (fallback: per-model table, fallback DEFAULT_WINDOW). null if no usable count.
// NO plan mode: codex has no `--permission-mode plan` equivalent (per mockup, modal hides it).

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { decodeProjectDir, storeBytes } from '../store/scan';
import type { SearchHit, SearchOpts } from '../store/search';
import type { UsageSummary } from '../store/usage';
import type { Ctx, Msg, ToolCall } from '../store/transcript';
import { loadNeedsInputPatterns } from './manifest';
import {
  itemId,
  scanInstructionFiles,
  scanSkillsDir,
  type CustomizationItem,
  type CustomizationScanners,
} from './customizations';
import type {
  AgentProvider,
  DetectResult,
  ListSessionOpts,
  Project,
  ProviderCommands,
  SessionMeta,
} from './types';

const CODEX_BIN = 'codex';
const DEFAULT_WINDOW = 258_400;
// Per-model context windows (fallback when a rollout omits model_context_window).
const MODEL_WINDOWS: Record<string, number> = {
  'gpt-5.4': 258_400,
  'gpt-5.4-mini': 258_400,
};
const LIVE_WINDOW_MS = 60_000;

function codexStoreRoot(): string {
  return join(homedir(), '.codex', 'sessions');
}

// Encode an absolute cwd back into the dash-encoded project id (matches claude scheme so
// the same repo path merges across providers). `/Users/demo/github/myrepo` -> `-Users-demo-github-myrepo`.
function encodeProjectId(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function sessionIdFromFile(file: string): string {
  // rollout-2026-07-01T12-00-00-<uuid>.jsonl -> <uuid>
  const stem = basename(file).replace(/\.jsonl$/, '');
  const m = stem.match(/^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f-]+)$/i);
  if (m) return m[1];
  // Fixture / fallback form rollout-2026-07-01-<id>: take everything after the date.
  const alt = stem.replace(/^rollout-\d{4}-\d{2}-\d{2}-?/, '');
  return alt || stem;
}

interface RolloutSummary {
  sessionId: string;
  cwd: string | null;
  branch: string | null;
  title: string;
  startedAt: number | null;
}

// Walk YYYY/MM/DD/rollout-*.jsonl under root.
async function findRolloutFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory() && depth < 3) {
        await walk(full, depth + 1);
      } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  }
  await walk(root, 0);
  return out;
}

// Read head of a rollout for grouping/listing (cwd, branch, title, startedAt).
const summaryCache = new Map<string, RolloutSummary>();

async function readSummary(filePath: string, mtime: number): Promise<RolloutSummary> {
  const cacheKey = `${filePath}:${mtime}`;
  const cached = summaryCache.get(cacheKey);
  if (cached) return cached;

  const summary: RolloutSummary = {
    sessionId: sessionIdFromFile(filePath),
    cwd: null,
    branch: null,
    title: '',
    startedAt: null,
  };

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lineCount = 0;
  try {
    for await (const line of rl) {
      if (++lineCount > 80 && summary.title) break;
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const p = obj.payload;
      if (obj.type === 'session_meta' && p) {
        if (typeof p.cwd === 'string') summary.cwd = p.cwd;
        if (p.git && typeof p.git.branch === 'string') summary.branch = p.git.branch;
        if (typeof p.session_id === 'string') summary.sessionId = p.session_id;
        if (summary.startedAt === null && typeof p.timestamp === 'string') {
          summary.startedAt = Date.parse(p.timestamp);
        }
      }
      if (obj.type === 'event_msg' && p?.type === 'user_message' && !summary.title) {
        const text = typeof p.message === 'string' ? p.message.trim() : '';
        if (text) summary.title = text.slice(0, 80);
      }
      if (summary.startedAt === null && typeof obj.timestamp === 'string') {
        summary.startedAt = Date.parse(obj.timestamp);
      }
    }
  } finally {
    rl.close();
  }

  summaryCache.set(cacheKey, summary);
  return summary;
}

function toolArgsToString(args: unknown): string {
  return typeof args === 'string' ? args : JSON.stringify(args ?? '');
}

// codex's MCP servers live in ~/.codex/config.toml under [mcp_servers.<name>] table
// headers (Task 1 finding), global-only — no per-project config file on real installs.
// ponytail: line-regex TOML subset (only mcp_servers.* headers + command/args keys), not
// a real TOML parser — upgrade if codex's config grows past this flat shape.
async function scanCodexMcpToml(filePath: string): Promise<CustomizationItem[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: CustomizationItem[] = [];
  let current: { name: string; command: string; args: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    out.push({
      id: itemId(filePath, current.name),
      provider: 'codex',
      scope: 'global',
      filePath,
      title: current.name,
      meta: { command: [current.command, ...current.args].filter(Boolean).join(' ') },
      content: JSON.stringify(current, null, 2),
    });
    current = null;
  };
  for (const line of raw.split('\n')) {
    const header = /^\[mcp_servers\.([^\]]+)\]$/.exec(line.trim());
    if (header) {
      flush();
      current = { name: header[1].replace(/^"|"$/g, ''), command: '', args: [] };
      continue;
    }
    if (/^\[.+\]$/.test(line.trim())) {
      flush();
      continue;
    }
    if (!current) continue;
    const cmd = /^command\s*=\s*"([^"]*)"/.exec(line.trim());
    if (cmd) {
      current.command = cmd[1];
      continue;
    }
    const args = /^args\s*=\s*\[(.*)\]/.exec(line.trim());
    if (args) {
      current.args = args[1]
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
    }
  }
  flush();
  return out;
}

function outputToString(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output ?? '');
  }
}

export interface CodexProviderOpts {
  root?: string;
  homeDir?: string;
}

export class CodexProvider implements AgentProvider {
  readonly id = 'codex' as const;
  private root: string;
  private homeDir: string;

  // Accepts the legacy positional root string (existing call sites/tests) or an options
  // object (customizations scanners need homeDir, mirroring ClaudeProviderOpts).
  constructor(rootOrOpts: string | CodexProviderOpts = {}) {
    const opts: CodexProviderOpts = typeof rootOrOpts === 'string' ? { root: rootOrOpts } : rootOrOpts;
    this.homeDir = opts.homeDir ?? homedir();
    this.root = opts.root ?? (opts.homeDir ? join(opts.homeDir, '.codex', 'sessions') : codexStoreRoot());
  }

  private async allSummaries(): Promise<{ file: string; mtime: number; s: RolloutSummary }[]> {
    const files = await findRolloutFiles(this.root);
    const results = [];
    for (const file of files) {
      let mtime: number;
      try {
        mtime = Math.floor((await stat(file)).mtimeMs);
      } catch {
        continue;
      }
      const s = await readSummary(file, mtime);
      results.push({ file, mtime, s });
    }
    return results;
  }

  private async fileForSession(projectId: string, sessionId: string): Promise<string | null> {
    const all = await this.allSummaries();
    for (const { file, s } of all) {
      if (s.sessionId === sessionId && s.cwd && encodeProjectId(s.cwd) === projectId) {
        return file;
      }
    }
    // Fall back to matching by session id alone.
    const bySid = all.find((x) => x.s.sessionId === sessionId);
    return bySid ? bySid.file : null;
  }

  async detect(): Promise<DetectResult> {
    let projects = 0;
    let bytes = 0;
    try {
      projects = (await this.scanProjects()).length;
      bytes = await storeBytes(this.root);
    } catch {
      /* no store */
    }
    return { found: projects > 0, store: { projects, bytes } };
  }

  async scanProjects(): Promise<Project[]> {
    const all = await this.allSummaries();
    const byProject = new Map<string, { cwd: string; count: number; createdAt: number; updatedAt: number }>();
    for (const { s, mtime } of all) {
      if (!s.cwd) continue;
      const id = encodeProjectId(s.cwd);
      const created = s.startedAt ?? mtime;
      const prev = byProject.get(id);
      if (prev) {
        prev.count++;
        prev.updatedAt = Math.max(prev.updatedAt, mtime);
        prev.createdAt = Math.min(prev.createdAt, created);
      } else {
        byProject.set(id, { cwd: s.cwd, count: 1, createdAt: created, updatedAt: mtime });
      }
    }
    const projects: Project[] = [];
    for (const [id, { cwd, count, createdAt, updatedAt }] of byProject) {
      // Codex records the real cwd in the rollout; prefer it over decodeProjectDir,
      // whose "-"→"/" decode mangles dir names containing hyphens (e.g. "kantrail-ai"
      // → "kantrail/ai", a path that doesn't exist → resume 400s in validateStart).
      const { name } = decodeProjectDir(id);
      const path = cwd || id;
      const displayName = cwd ? cwd.split('/').filter(Boolean).pop() || name : name;
      let missing = false;
      try {
        missing = !(await stat(path)).isDirectory();
      } catch {
        missing = true;
      }
      projects.push({ id, provider: this.id, name: displayName, path, sessionCount: count, createdAt, updatedAt, missing });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects;
  }

  async listSessions(projectId: string, opts: ListSessionOpts = {}): Promise<SessionMeta[]> {
    const all = await this.allSummaries();
    const now = Date.now();
    let metas: SessionMeta[] = all
      .filter(({ s }) => s.cwd && encodeProjectId(s.cwd) === projectId)
      .map(({ mtime, s }) => ({
        id: s.sessionId,
        provider: this.id,
        projectId,
        title: s.title,
        branch: s.branch,
        mtime,
        startedAt: s.startedAt,
        durationMs: s.startedAt !== null ? mtime - s.startedAt : null,
        live: now - mtime < LIVE_WINDOW_MS,
      }));

    metas.sort((a, b) => b.mtime - a.mtime);
    if (typeof opts.before === 'number') metas = metas.filter((m) => m.mtime < opts.before!);
    if (opts.q) {
      const needle = opts.q.toLowerCase();
      metas = metas.filter(
        (m) => m.title.toLowerCase().includes(needle) || (m.branch ?? '').toLowerCase().includes(needle),
      );
    }
    if (typeof opts.limit === 'number') metas = metas.slice(0, opts.limit);
    return metas;
  }

  async parseTranscript(
    projectId: string,
    sessionId: string,
  ): Promise<{ msgs: Msg[]; ctx: Ctx | null }> {
    const file = await this.fileForSession(projectId, sessionId);
    if (!file) return { msgs: [], ctx: null };

    const msgs: Msg[] = [];
    const toolById = new Map<string, ToolCall>();
    let model = '';
    let window = DEFAULT_WINDOW;
    let tokens: number | null = null;

    const rl = createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const p = obj.payload;
        if (!p) continue;
        const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : 0;

        if (obj.type === 'turn_context' && typeof p.model === 'string') {
          model = p.model;
          if (MODEL_WINDOWS[model]) window = MODEL_WINDOWS[model];
        } else if (obj.type === 'event_msg' && p.type === 'task_started' && p.model_context_window) {
          window = p.model_context_window;
        } else if (obj.type === 'event_msg' && p.type === 'user_message') {
          const text = typeof p.message === 'string' ? p.message : '';
          if (text) msgs.push({ role: 'user', text, tools: [], ts });
        } else if (obj.type === 'event_msg' && p.type === 'agent_message') {
          const text = typeof p.message === 'string' ? p.message : '';
          if (text) msgs.push({ role: 'assistant', text, tools: [], ts });
        } else if (obj.type === 'response_item' && p.type === 'function_call') {
          const call: ToolCall = {
            name: String(p.name ?? ''),
            input: toolArgsToString(p.arguments),
            output: '',
          };
          if (p.call_id) toolById.set(p.call_id, call);
          // Attach to the most recent assistant msg, else create a carrier.
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'assistant') last.tools.push(call);
          else msgs.push({ role: 'assistant', text: '', tools: [call], ts });
        } else if (obj.type === 'response_item' && p.type === 'function_call_output') {
          const tool = toolById.get(p.call_id);
          if (tool) tool.output = outputToString(p.output);
        } else if (obj.type === 'event_msg' && p.type === 'token_count' && p.info) {
          const total = p.info.last_token_usage?.total_tokens;
          if (typeof total === 'number') tokens = total;
          if (p.info.model_context_window) window = p.info.model_context_window;
        }
      }
    } finally {
      rl.close();
    }

    const ctx: Ctx | null =
      tokens !== null ? { tokens, window, pct: Math.round((tokens / window) * 100), model } : null;
    return { msgs, ctx };
  }

  async readCtx(projectId: string, sessionId: string): Promise<Ctx | null> {
    // token_count lines sit near the end; a full parse is simplest and correct.
    const { ctx } = await this.parseTranscript(projectId, sessionId);
    return ctx;
  }

  // Rollout-aware search: the store isn't a flat <project>/<id>.jsonl layout, so we scan
  // each rollout file directly and enrich from its summary (project name / title / mtime).
  async search(q: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    if (!q.trim()) return [];
    const limit = opts.limit ?? 200;
    const needle = q.toLowerCase();
    const all = await this.allSummaries();
    const hits: SearchHit[] = [];

    for (const { file, s } of all) {
      if (!s.cwd) continue;
      let matchLine: string | null = null;
      const rl = createInterface({
        input: createReadStream(file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      try {
        for await (const line of rl) {
          if (line.toLowerCase().includes(needle)) {
            matchLine = line;
            break;
          }
        }
      } finally {
        rl.close();
      }
      if (!matchLine) continue;
      const idx = matchLine.toLowerCase().indexOf(needle);
      const from = Math.max(0, idx - 40);
      const snippet = matchLine.slice(from, from + 160).trim();
      hits.push({
        project: decodeProjectDir(encodeProjectId(s.cwd)).name,
        provider: this.id,
        sessionId: s.sessionId,
        title: s.title,
        snippet: snippet.length > 157 ? snippet.slice(0, 157) + '…' : snippet,
        ts: s.startedAt ?? 0,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  // ponytail: codex token accounting isn't wired yet (rollout token_count summing differs
  // from Claude's per-line usage). Report session count in the window with zero tokens so
  // the usage card's "by agent" bar can still show codex is present; upgrade when codex
  // spend needs a real number. Route merges this with claude's real totals.
  async usage(days: number): Promise<UsageSummary> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const all = await this.allSummaries();
    const sessions = all.filter(({ mtime }) => mtime >= cutoff).length;
    return {
      sessions,
      totalTokens: 0,
      cacheReads: 0,
      estCostUsd: 0,
      byProject: [],
      byProvider: [],
    };
  }

  commands: ProviderCommands = {
    fresh: () => [CODEX_BIN],
    continue: () => [CODEX_BIN, 'resume', '--last'],
    // `resume -- <id>`: the `--` end-of-options separator forces the id to parse as the
    // positional [SESSION_ID], never a flag, even if it starts with `-`. Verified: the CLI
    // treats `resume -- --evil` as a positional (reaches runtime, not an arg-parse error).
    resume: (_cwd, id) => [CODEX_BIN, 'resume', '--', id],
    // no interactive plan mode — omitted intentionally.
    // Headless read-only exec: `-s read-only` sandbox refuses writes (verified). `-C` sets
    // the working root; `--` shields the task. Same argv for plan-off and ask (codex has no
    // separate plan mode — read-only exec IS the safe form).
    headlessPlan: (cwd, task) => [CODEX_BIN, 'exec', '-s', 'read-only', '-C', cwd, '--', task],
    headlessAsk: (cwd, prompt) => [CODEX_BIN, 'exec', '-s', 'read-only', '-C', cwd, '--', prompt],
  };

  // Codex TUI waiting-state heuristics (Task 15, from real captured fixtures). Covers the
  // per-turn command-approval prompt, the one-time directory-trust gate, and generic y/n.
  // Matched against ANSI-stripped, whitespace-collapsed output (see needs-input.ts).
  // Patterns live in manifests/codex.json (Spec 4) — user-overridable, no inline regex here.
  needsInputPatterns: RegExp[] = loadNeedsInputPatterns('codex');

  // Read-only customizations scanning (customizations browser v1), per Task 1's real-store
  // discovery (docs/plans/2026-07-10-codex-customizations-discovery.md): no `agents` or
  // `hooks` scanner — ~/.codex/prompts/ and ~/.codex/hooks.json don't exist on real codex
  // installs, and the plan's own rule is absent surface = omitted key.
  customizations: CustomizationScanners = {
    skills: (s) =>
      s.kind === 'global' ? scanSkillsDir(join(this.homeDir, '.codex', 'skills'), 'codex', 'global') : Promise.resolve([]),
    instructions: (s) =>
      s.kind === 'project' ? scanInstructionFiles([join(s.repoPath, 'AGENTS.md')], 'codex', 'project') : Promise.resolve([]),
    mcpServers: (s) =>
      s.kind === 'global' ? scanCodexMcpToml(join(this.homeDir, '.codex', 'config.toml')) : Promise.resolve([]),
  };

  // Spec 2 schema discovery (hard rule 6, run against this machine's real
  // installed CLI, codex-cli 0.144.0, 2026-07-09): `codex features list` DOES
  // report a `hooks` feature flag (stable=true), and the compiled binary's
  // embedded schema strings show a real internal HooksToml / HookHandlerConfig
  // config surface with events including SessionStart/PreToolUse/PostToolUse/
  // UserPromptSubmit/Stop/SubagentStop. BUT it is entirely undocumented: no
  // `codex hooks` subcommand, no README/help mention, no example config or
  // schema file shipped anywhere in the npm package — everything above was
  // reverse-engineered from `strings` on the compiled binary. Building an
  // installer against an unshipped, unversioned internal format is exactly
  // what hard rule 6 warns against (it could rename/restructure any release
  // with zero notice and no changelog entry, and there is no supported way to
  // verify a written hooks.json actually fires). Codex stays heuristics-only
  // until Codex ships a documented hook/notify config surface — no statusHooks
  // property on this provider (getProviders() callers already feature-test
  // with `provider.statusHooks?.hooksAvailable()`).
}

export { codexStoreRoot };

// Watch config for server/lib/store/watch.ts (hard rule 3 — the store-agnostic watcher
// must not hardcode a provider's file layout). codex: <root>/YYYY/MM/DD/rollout-*.jsonl,
// three levels below root -> chokidar depth 3. projectId isn't cheaply derivable from the
// path alone (it's the session's cwd, only known by reading the file) — ponytail: leave it
// '' here; CodexProvider.readCtx / fileForSession already falls back to matching by
// sessionId alone (codex.ts fileForSession above), so a blank projectId still resolves.
export const codexWatchConfig = {
  depth: 3,
  idsFromPath(filePath: string): { sessionId: string; projectId: string } {
    return { sessionId: sessionIdFromFile(filePath), projectId: '' };
  },
};

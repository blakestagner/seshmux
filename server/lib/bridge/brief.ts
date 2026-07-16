// Handoff brief + cross-review composers (Task 16.5). Provider-agnostic: the transcript is
// fetched through the providers registry (default loader) or an injected loader for tests.
// Output is written by the route layer to `<repo>/.seshmux/handoff-brief.md`.

import { execFile } from 'node:child_process';
import type { Ctx, Msg, ProviderId, SessionMeta } from '../providers/types';

export interface BriefTranscript {
  msgs: Msg[];
  ctx: Ctx | null;
  meta: SessionMeta;
}

export interface BriefDeps {
  // Resolve a session's transcript + meta. Default hits the providers registry.
  loadTranscript?: (projectId: string, sessionId: string) => Promise<BriefTranscript>;
  // git diff (staged+unstaged) in the session's cwd. Default shells out. Returns null when
  // the git command itself FAILED (not a git repo, bad cwd) so the review can say "diff
  // unavailable" instead of lying "no changes" — an empty string means a clean tree.
  gitDiff?: (cwd: string) => Promise<string | null>;
}

const RECENT_MSG_COUNT = 15;
const MAX_BYTES = 4096;

// Default loader: find the owning provider by scanning each provider's listSessions for the
// session id (same resolution the transcript route uses), then parse via that provider.
async function defaultLoadTranscript(
  projectId: string,
  sessionId: string,
): Promise<BriefTranscript> {
  const { getProviders } = await import('../providers/types');
  const providers = await getProviders();
  for (const p of providers) {
    const sessions = await p.listSessions(projectId).catch(() => [] as SessionMeta[]);
    const meta = sessions.find((s) => s.id === sessionId);
    if (meta) {
      const { msgs, ctx } = await p.parseTranscript(projectId, sessionId);
      return { msgs, ctx, meta };
    }
  }
  throw new Error(`session not found: ${projectId}/${sessionId}`);
}

function defaultGitDiff(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    // HEAD diff captures staged+unstaged tracked changes. null on command failure
    // (bad cwd / not a repo) so the review distinguishes it from a clean tree ('').
    execFile(
      'git',
      ['-C', cwd, 'diff', 'HEAD'],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

// One-line summary of a tool call: `Read nav.css` / `Edit assets/nav.css` / `Bash …`.
function summarizeTool(t: { name: string; input: string }): string {
  let hint = '';
  try {
    const parsed = JSON.parse(t.input);
    hint = parsed.file_path ?? parsed.path ?? parsed.command ?? parsed.pattern ?? '';
  } catch {
    hint = t.input.slice(0, 40);
  }
  hint = String(hint).slice(0, 60);
  return hint ? `${t.name} ${hint}` : t.name;
}

// Collect files touched from tool_use file_path/path inputs (Write/Edit/Read etc.).
function filesTouched(msgs: Msg[]): string[] {
  const files = new Set<string>();
  for (const m of msgs) {
    for (const t of m.tools) {
      try {
        const parsed = JSON.parse(t.input);
        const f = parsed.file_path ?? parsed.path;
        if (typeof f === 'string') files.add(f);
      } catch {
        /* non-file tool */
      }
    }
  }
  return [...files];
}

function providerName(p: ProviderId): string {
  return p === 'claude' ? 'Claude Code' : 'Codex';
}

// Truncate to MAX_BYTES on a line boundary so the brief never exceeds the size budget.
function clampBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  const lines = text.split('\n');
  let out = '';
  for (const line of lines) {
    if (Buffer.byteLength(out + line + '\n…(truncated)', 'utf8') > max) break;
    out += line + '\n';
  }
  return out + '…(truncated)';
}

export async function composeBrief(
  projectId: string,
  sessionId: string,
  deps: BriefDeps = {},
  // Scratchpad reference embedded in the prompt. For folded worktree sessions the route
  // passes the PARENT repo's absolute handoff.md path — one scratchpad per repo — so the
  // spawned agent doesn't write to a worktree copy the UI/watcher never reads.
  scratchpadRef = '.seshmux/handoff.md',
): Promise<string> {
  const load = deps.loadTranscript ?? defaultLoadTranscript;
  const { msgs, meta } = await load(projectId, sessionId);

  const recent = msgs.slice(-RECENT_MSG_COUNT);
  const files = filesTouched(msgs);
  const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');

  const lines: string[] = [];
  lines.push(`# Handoff brief`);
  lines.push('');
  lines.push(`**Task:** ${meta.title || '(untitled session)'}`);
  lines.push(`**From:** ${providerName(meta.provider)}${meta.branch ? ` · ⎇ ${meta.branch}` : ''}`);
  lines.push('');

  if (files.length) {
    lines.push(`## Files touched`);
    for (const f of files.slice(0, 30)) lines.push(`- ${f}`);
    lines.push('');
  }

  lines.push(`## Recent activity (last ${recent.length} messages)`);
  for (const m of recent) {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    const text = m.text.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (text) lines.push(`- **${role}:** ${text}`);
    for (const t of m.tools) lines.push(`  - \`${summarizeTool(t)}\``);
  }
  lines.push('');

  lines.push(`## Remaining work`);
  lines.push(
    lastAssistant?.text
      ? lastAssistant.text.replace(/\s+/g, ' ').trim().slice(0, 600)
      : '(no assistant summary — review the recent activity above)',
  );
  lines.push('');
  lines.push(`_Continue this task. Note progress in \`${scratchpadRef}\`._`);

  return clampBytes(lines.join('\n'), MAX_BYTES);
}

export async function composeDiffReview(
  projectId: string,
  sessionId: string,
  deps: BriefDeps = {},
  repo?: string,
  // Same contract as composeBrief's scratchpadRef (absolute parent path for worktrees).
  scratchpadRef = '.seshmux/handoff.md',
): Promise<string> {
  const load = deps.loadTranscript ?? defaultLoadTranscript;
  const gitDiff = deps.gitDiff ?? defaultGitDiff;
  const { meta } = await load(projectId, sessionId);

  // Use the route's already-resolved repo (reads the real cwd from the session store) —
  // the dash-decode fallback mangles any hyphenated repo path (wp-foo-org), which used to
  // point git at a nonexistent dir → empty diff → a review of "no changes" (R2-1).
  const cwd = repo ?? projectId.replace(/-/g, '/');
  const diff = await gitDiff(cwd);

  const lines: string[] = [];
  lines.push(`# Cross-review request`);
  lines.push('');
  lines.push(`**Original task:** ${meta.title || '(untitled)'}`);
  lines.push(`**Branch:** ${meta.branch ?? '(none)'}`);
  lines.push(`**Author:** ${providerName(meta.provider)}`);
  lines.push('');
  lines.push(`## Your job`);
  lines.push(
    `Adversarially review the diff below. Assume it is buggy until proven otherwise. ` +
      `Critique correctness, edge cases, security, and style. Be specific and cite lines. ` +
      `Write your verdict to \`${scratchpadRef}\`.`,
  );
  lines.push('');
  lines.push(`## Diff`);
  if (diff === null) {
    lines.push('_Diff unavailable — `git diff` failed in this repo (not a git repo, or the working tree is missing). Review the recent activity above instead._');
  } else if (diff.trim()) {
    lines.push('```diff');
    lines.push(diff);
    lines.push('```');
  } else {
    lines.push('_No uncommitted changes found in the working tree._');
  }

  return clampBytes(lines.join('\n'), MAX_BYTES * 2); // reviews may embed a larger diff
}

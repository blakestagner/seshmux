// Deterministic extraction: normalized Msg[] -> MemoryRecord[].
//
// PURE. No I/O, no Date.now() — the clock and the session identity arrive in ExtractCtx.
// That is deliberate: this is where nearly all of memory's behaviour lives, and a pure
// function is the only version of it that can be tested against real fixtures exhaustively.
//
// PROVIDER-AGNOSTIC by construction: it consumes Msg/ToolCall, the shape both providers
// already normalize to, so it never learns a store layout or a jsonl schema (hard rule 3).
// The tool NAMES it recognizes (Edit, Bash, …) are agent-tool names, not provider internals,
// and every branch degrades to the generic path for a name it does not know.
//
// INCREMENTAL: harvest feeds this one forward slice at a time, so extraction must be
// stateless across slices. That is why no record carries a count or a running total — a
// tally computed from one slice would be wrong, and a wrong number in memory is worse than
// no number. Record ids are content-addressed over (kind, session, target) so the same
// tool call re-derived from an overlapping slice collapses instead of duplicating.

import type { Msg, ToolCall } from '../store/transcript';
import type { ProviderId } from '../store/scan';
import { contentId, sanitizeText } from './store';
import { MEMORY_SCHEMA, type MemoryEntities, type MemoryKind, type MemoryRecord } from './types';

export interface ExtractCtx {
  provider: ProviderId;
  sessionId: string;
  projectId: string;
  repo: string;
  branch: string | null;
  /** True only for the final slice of a finished session — gates the `outcome` record. */
  final?: boolean;
  /** Fallback timestamp for messages whose own ts is missing/unparseable. */
  now: number;
}

// Same framing prefixes scan.ts skips when picking a title: these are harness plumbing, not
// something anyone would want recalled.
const SKIP_PROMPT_PREFIXES = [
  '<command-name>',
  '<local-command',
  '<system-reminder',
  '<teammate-message',
  '<task-notification',
  '<environment_context',
  '<permissions',
];

const PROMPT_MAX = 600;
const OUTCOME_MAX = 800;
const ERROR_MAX = 400;

// Per-session caps. A runaway session must not be able to flood the store and push every
// other project's memory past the global cap.
const CAP = { prompt: 20, 'tool-call': 40, error: 20, artifact: 30, outcome: 1 } as const;

// ---------------------------------------------------------------------------
// Tool-call interpretation
// ---------------------------------------------------------------------------

function parseInput(input: string): any {
  try {
    const v = JSON.parse(input);
    return v && typeof v === 'object' ? v : { _raw: String(v) };
  } catch {
    return { _raw: input };
  }
}

/** First meaningful token of a shell command — `npm`, `git`, `cargo`. */
export function commandHead(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  // Skip a leading env assignment (`FOO=bar npm test`) and pick the real binary.
  const parts = trimmed.split(/\s+/);
  for (const part of parts) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(part)) continue;
    return part.replace(/^["']|["']$/g, '');
  }
  return null;
}

export type TargetKind = 'file' | 'command' | 'pattern' | 'url' | 'query';

/**
 * What a tool call acted ON — the value that becomes both the record id and its label.
 *
 * The KIND matters as much as the value: a `file_path` argument is the tool telling us
 * authoritatively that this is a file, which is far better evidence than the path regex
 * (`nav.css` has no separator and the regex would miss it).
 */
export function toolTarget(name: string, args: any): { value: string; kind: TargetKind } | null {
  const n = name.toLowerCase();
  for (const field of ['file_path', 'notebook_path', 'path'] as const) {
    if (typeof args[field] === 'string' && args[field].trim()) {
      return { value: args[field], kind: 'file' };
    }
  }
  if (n.includes('bash') || n.includes('shell') || n.includes('exec')) {
    const cmd = typeof args.command === 'string' ? args.command : typeof args._raw === 'string' ? args._raw : '';
    // Keep the first line only: a heredoc or a && chain is not a useful identity.
    const head = commandHead(cmd.split('\n')[0] ?? '');
    return head ? { value: head, kind: 'command' } : null;
  }
  if (typeof args.pattern === 'string' && args.pattern.trim()) return { value: args.pattern, kind: 'pattern' };
  if (typeof args.url === 'string' && args.url.trim()) return { value: args.url, kind: 'url' };
  if (typeof args.query === 'string' && args.query.trim()) return { value: args.query, kind: 'query' };
  return null;
}

const WRITE_TOOLS = /^(write|edit|multiedit|notebookedit|apply_patch|str_replace|create_file)/i;

function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.test(name.replace(/[^a-z_]/gi, ''));
}

// ---------------------------------------------------------------------------
// Error detection
// ---------------------------------------------------------------------------

// Anchored signatures rather than a bare /failed/ scan: tool output routinely contains the
// word "failed" inside prose or inside a passing test name, and a false error record is
// worse than a missed one — it teaches the next agent something untrue.
const ERROR_SIGNATURES: RegExp[] = [
  /^\s*(?:error|fatal|panic)\b[:\s]/im,
  /\b(?:E[A-Z]{3,}\b)/, // ENOENT, EACCES, EBUSY, EMFILE
  /\bTraceback \(most recent call last\)/,
  /\b(?:SyntaxError|TypeError|ReferenceError|RangeError|AssertionError)\b/,
  /\bcommand not found\b/i,
  /\bis not recognized as an internal or external command\b/i,
  /\bPermission denied\b/i,
  /\bexit(?:ed with)? code [1-9]/i,
  /^\s*error TS\d+:/im,
  /<tool_use_error>/,
  // The classic unix "prog: what went wrong" line. Most real shell failures never print the
  // errno CODE, only its message — `rm: cannot remove 'x': Device or resource busy` contains
  // no "EBUSY" for the pattern above to find. The vocabulary is kept narrow and the `prog: `
  // prefix required, so prose like "0 tests failed" cannot trip it.
  /^\s*[\w.\/\\-]+: [^\n]*\b(?:cannot|can't|unable to|no such|not found|denied|busy|already exists|invalid|failed|fatal)\b/im,
];

export function looksLikeError(output: string): boolean {
  if (!output) return false;
  // Only the head matters: a stack trace or a compiler error leads with its signature, and
  // scanning a 300KB output end-to-end for every tool call is wasted work.
  const head = output.slice(0, 4000);
  return ERROR_SIGNATURES.some((re) => re.test(head));
}

/** The single most informative line of an error output. */
export function errorGist(output: string): string {
  const head = output.slice(0, 4000);
  for (const re of ERROR_SIGNATURES) {
    const line = head.split('\n').find((l) => re.test(l));
    if (line && line.trim()) return line.trim().slice(0, ERROR_MAX);
  }
  return head.split('\n').find((l) => l.trim())?.trim().slice(0, ERROR_MAX) ?? '';
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

// A path needs a separator AND an extension to count. Bare words like "server" or "build"
// are far too common to index as files, and a wrong entity link surfaces wrong memories.
// Both separators are accepted because agents record backslash cwds on win32.
// The drive prefix carries its OWN separator (`C:\Users\…`): without it the alternation
// demanded a name segment straight after `C:` and the match silently restarted at `Users`,
// dropping the drive letter from every absolute Windows path.
const PATH_RE = /(?:[A-Za-z]:[/\\])?(?:[\w.@~-]+[/\\])+[\w.@-]+\.[A-Za-z][\w]{0,9}/g;

// Identifiers the author chose to mark as code. A far better symbol signal than guessing at
// camelCase in prose, and essentially free.
const BACKTICK_RE = /`([^`\n]{2,80})`/g;

export function extractPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) out.add(m[0].replace(/\\/g, '/'));
  return [...out];
}

export function extractSymbols(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(BACKTICK_RE)) {
    const inner = m[1].trim();
    // A backticked path is a path, not a symbol — it is already indexed as one.
    if (/[/\\]/.test(inner)) continue;
    const ident = inner.match(/^([A-Za-z_$][\w$]{2,})/);
    if (ident) out.add(ident[1]);
  }
  return [...out];
}

function emptyEntities(): MemoryEntities {
  return { files: [], commands: [], symbols: [] };
}

function entitiesFrom(text: string, extra: Partial<MemoryEntities> = {}): MemoryEntities {
  const files = new Set(extra.files ?? []);
  for (const p of extractPaths(text)) files.add(p);
  const symbols = new Set(extra.symbols ?? []);
  for (const s of extractSymbols(text)) symbols.add(s);
  return {
    files: [...files].slice(0, 20),
    commands: [...new Set(extra.commands ?? [])].slice(0, 10),
    symbols: [...symbols].slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

function makeRecord(
  kind: MemoryKind,
  text: string,
  target: string | undefined,
  ts: number,
  entities: MemoryEntities,
  ctx: ExtractCtx,
): MemoryRecord {
  const clean = sanitizeText(text);
  return {
    v: MEMORY_SCHEMA,
    id: contentId({ kind, text: target ? '' : clean, scope: ctx.sessionId, target }),
    kind,
    text: clean,
    scope: { projectId: ctx.projectId, repo: ctx.repo, branch: ctx.branch },
    origin: { provider: ctx.provider, sessionId: ctx.sessionId, ts },
    entities,
    validFrom: ts,
    hits: 0,
    lastHit: 0,
  };
}

export function extract(msgs: Msg[], ctx: ExtractCtx): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  const counts: Record<string, number> = {};
  const seenTarget = new Set<string>();

  const push = (r: MemoryRecord): void => {
    const cap = (CAP as Record<string, number>)[r.kind] ?? 0;
    if ((counts[r.kind] ?? 0) >= cap) return;
    counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    out.push(r);
  };

  let lastAssistant: { text: string; ts: number } | null = null;

  for (const msg of msgs) {
    const ts = msg.ts || ctx.now;

    if (msg.role === 'user') {
      const text = msg.text.trim();
      if (!text) continue;
      if (SKIP_PROMPT_PREFIXES.some((p) => text.startsWith(p))) continue;
      const clipped = text.length > PROMPT_MAX ? text.slice(0, PROMPT_MAX - 1) + '…' : text;
      push(makeRecord('prompt', clipped, undefined, ts, entitiesFrom(text), ctx));
      continue;
    }

    if (msg.text.trim()) lastAssistant = { text: msg.text, ts };

    for (const tool of msg.tools) {
      pushToolRecords(tool, ts, ctx, push, seenTarget);
    }
  }

  // `outcome` is the session's closing statement, so it only exists once the session is
  // actually over. Mid-session it would be "whatever the agent last said", which reads as a
  // conclusion while being nothing of the sort.
  if (ctx.final && lastAssistant) {
    const text =
      lastAssistant.text.length > OUTCOME_MAX
        ? lastAssistant.text.slice(0, OUTCOME_MAX - 1) + '…'
        : lastAssistant.text;
    push(makeRecord('outcome', text, 'outcome', lastAssistant.ts, entitiesFrom(lastAssistant.text), ctx));
  }

  return out;
}

function pushToolRecords(
  tool: ToolCall,
  ts: number,
  ctx: ExtractCtx,
  push: (r: MemoryRecord) => void,
  seenTarget: Set<string>,
): void {
  const name = tool.name || 'tool';
  const args = parseInput(tool.input);
  const target = toolTarget(name, args);
  const isShell = /bash|shell|exec/i.test(name);
  // `_raw` is the fallback parseInput uses when the tool input was not JSON at all — for a
  // shell tool that raw string IS the command line, so it must be honoured here too or the
  // record degrades to just the binary name.
  const rawCommand =
    typeof args.command === 'string' ? args.command : typeof args._raw === 'string' ? args._raw : null;
  const command = isShell && rawCommand ? rawCommand.split('\n')[0].trim() : null;
  const targetFiles = target?.kind === 'file' ? [target.value.replace(/\\/g, '/')] : [];
  const targetCommands = target?.kind === 'command' ? [target.value] : [];

  // An error is the highest-value deterministic record there is: it is the thing a future
  // agent most wants to have been told before it repeats the attempt.
  if (looksLikeError(tool.output)) {
    const gist = errorGist(tool.output);
    const what = command ?? (target ? `${name} ${target.value}` : name);
    push(
      makeRecord(
        'error',
        `\`${what}\` failed: ${gist}`,
        `err:${what}:${gist.slice(0, 60)}`,
        ts,
        entitiesFrom(`${what} ${gist}`, { commands: targetCommands, files: targetFiles }),
        ctx,
      ),
    );
  }

  if (isWriteTool(name) && target?.kind === 'file') {
    const file = target.value.replace(/\\/g, '/');
    const key = `artifact:${file}`;
    if (!seenTarget.has(key)) {
      seenTarget.add(key);
      push(makeRecord('artifact', `edited ${file}`, key, ts, entitiesFrom('', { files: [file] }), ctx));
    }
    return; // an edit is already recorded as an artifact; a tool-call row would say nothing more
  }

  if (!target) return;

  const key = `tool:${name}:${target.value}`;
  if (seenTarget.has(key)) return; // stateless dedup within the slice; ids collapse across slices
  seenTarget.add(key);

  const text = isShell ? `ran \`${command ?? target.value}\`` : `${name} → ${target.value}`;
  push(
    makeRecord(
      'tool-call',
      text,
      key,
      ts,
      entitiesFrom(text, { commands: targetCommands, files: targetFiles }),
      ctx,
    ),
  );
}

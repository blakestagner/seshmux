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

import type { Msg, ToolCall } from "../store/transcript";
import type { ProviderId } from "../store/scan";
import { contentId, sanitizeText } from "./store";
import {
  MEMORY_SCHEMA,
  type MemoryEntities,
  type MemoryKind,
  type MemoryRecord,
} from "./types";

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
  "<command-name>",
  "<local-command",
  "<system-reminder",
  "<teammate-message",
  "<task-notification",
  "<environment_context",
  "<permissions",
];

// Memory's own output, in every form it can re-enter a transcript.
//
// THE FEEDBACK LOOP: recalling memory pastes a pack into the terminal, that paste lands in
// the session's jsonl, and the harvester reads that jsonl. Without a guard, memory would
// re-remember its own recollections — each pass wrapping the last (`x` failed: `y` failed:
// …) and slowly filling the store with echoes of itself. Observed on the first live run.
//
// The envelope tag is emitted by pack.ts on every pack, and the "` failed: " shape is this
// file's own error-record format, so between them they identify anything memory wrote.
const MEMORY_ECHO = [
  /<seshmux-memory/,
  /<\/seshmux-memory>/,
  // Our own error-record shape: as a whole line (a record printed back at us) and nested
  // inside another (a record about a record — the loop already one turn in).
  /^`[^`\n]+` failed: /,
  /` failed: `[^`]*` failed: /,
];

export function isMemoryEcho(text: string): boolean {
  return MEMORY_ECHO.some((re) => re.test(text));
}

const PROMPT_MAX = 600;
// A command record should read as a memory, not as a transcript line. Real agent shell
// calls are routinely 200-char `a && echo … && cat …` chains where only the first segment
// is the actual action; storing the whole thing buries the signal and wastes recall budget.
const COMMAND_MAX = 120;
const OUTCOME_MAX = 800;
const ERROR_MAX = 400;

// Per-session caps. A runaway session must not be able to flood the store and push every
// other project's memory past the global cap.
const CAP = {
  prompt: 20,
  "tool-call": 40,
  error: 20,
  artifact: 30,
  outcome: 1,
} as const;

// ---------------------------------------------------------------------------
// Tool-call interpretation
// ---------------------------------------------------------------------------

function parseInput(input: string): any {
  try {
    const v = JSON.parse(input);
    return v && typeof v === "object" ? v : { _raw: String(v) };
  } catch {
    return { _raw: input };
  }
}

/**
 * A readable form of a shell command: the first segment of a chain, clamped.
 *
 * `npm run build && echo done && cat log` is one action followed by incidental noise, so
 * the record keeps `npm run build`. The full line is never worth storing — it is already in
 * the transcript, which is what memory is a summary OF.
 */
export function shortCommand(command: string): string {
  const first = command.split(/\s*(?:&&|\|\||;)\s*/)[0]?.trim() ?? "";
  const line = first || command.trim();
  return line.length > COMMAND_MAX
    ? line.slice(0, COMMAND_MAX - 1) + "…"
    : line;
}

// Shell lines that are never the point of a script: moving around, setting up, or
// announcing. A multi-line command that failed almost always failed in spite of these,
// not because of them — real records this produced were `cd /c/Users/...` failed,
// `SP="C:/..."` failed, and `echo "=== node/npm ==="` failed, none of which name the
// thing that broke.
const SCAFFOLD_SEGMENT = [
  /^cd\s/i,
  /^[A-Za-z_][A-Za-z0-9_]*=/, // SP="..." and friends
  /^export\s+[A-Za-z_]/i,
  /^echo\b/i,
  /^set\s+[-+]/i,
  /^mkdir\b/i,
  /^sleep\b/i, // waiting for something is never what broke
  /^cat\s*>>?/i, // `cat > file <<EOF` writes the script; it is not the script
  /^#/,
  /^(?:then|else|fi|do|done|;;)\b/,
];

/**
 * The most informative command in a shell invocation.
 *
 * shortCommand() takes the FIRST segment, which is right for a one-liner and wrong for
 * the multi-line scripts agents actually run: those open with a `cd`, an assignment or a
 * heredoc, so the first segment names the scaffolding rather than the work. Prefer the
 * first segment that is neither, and fall back to shortCommand when a script is nothing
 * but scaffolding.
 *
 * Still a guess for a long script — the gist alongside it carries the actual failure.
 */
/**
 * Drop heredoc BODIES from a shell command.
 *
 * `cat > patch.js <<EOF ... EOF` inlines a whole program into the command, and every
 * line of it looks like a segment. Without this the "most informative command" was
 * routinely a line of JavaScript that never ran as a shell command at all.
 */
export function stripHeredocs(command: string): string {
  const out: string[] = [];
  let delim: string | null = null;
  for (const line of command.split(/\r?\n/)) {
    if (delim !== null) {
      if (line.trim() === delim) delim = null; // closing marker; body discarded
      continue;
    }
    // <<EOF, <<-EOF, <<"EOF", <<'EOF' — the quotes only affect expansion, not framing.
    const open = line.match(/<<-?\s*[\'"]?([A-Za-z_][A-Za-z0-9_]*)[\'"]?/);
    out.push(line);
    if (open) delim = open[1];
  }
  return out.join(String.fromCharCode(10));
}

/**
 * The most informative command in a shell invocation.
 *
 * shortCommand() takes the FIRST segment, which is right for a one-liner and wrong for
 * the multi-line scripts agents actually run: those open with a `cd`, an assignment or a
 * heredoc, so the first segment names the scaffolding rather than the work. Strip heredoc
 * bodies, then prefer the first segment that is not scaffolding; fall back to
 * shortCommand when a script is nothing but scaffolding.
 *
 * Still a guess for a long script — the gist alongside it carries the actual failure.
 */
export function significantCommand(command: string): string {
  const segments = stripHeredocs(command)
    .split(/\r?\n/)
    .flatMap((line) => line.split(/\s*(?:&&|\|\||;)\s*/))
    .map((s) => s.trim())
    .filter(Boolean);
  const meaty = segments.find(
    (s) => !SCAFFOLD_SEGMENT.some((re) => re.test(s)),
  );
  return shortCommand(meaty ?? command);
}

/** First meaningful token of a shell command — `npm`, `git`, `cargo`. */
export function commandHead(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  // Skip a leading env assignment (`FOO=bar npm test`) and pick the real binary.
  const parts = trimmed.split(/\s+/);
  for (const part of parts) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(part)) continue;
    return part.replace(/^["']|["']$/g, "");
  }
  return null;
}

export type TargetKind = "file" | "command" | "pattern" | "url" | "query";

/**
 * What a tool call acted ON — the value that becomes both the record id and its label.
 *
 * The KIND matters as much as the value: a `file_path` argument is the tool telling us
 * authoritatively that this is a file, which is far better evidence than the path regex
 * (`nav.css` has no separator and the regex would miss it).
 */
export function toolTarget(
  name: string,
  args: any,
): { value: string; kind: TargetKind } | null {
  const n = name.toLowerCase();
  for (const field of ["file_path", "notebook_path", "path"] as const) {
    if (typeof args[field] === "string" && args[field].trim()) {
      return { value: args[field], kind: "file" };
    }
  }
  if (n.includes("bash") || n.includes("shell") || n.includes("exec")) {
    const cmd =
      typeof args.command === "string"
        ? args.command
        : typeof args._raw === "string"
          ? args._raw
          : "";
    // Keep the first line only: a heredoc or a && chain is not a useful identity.
    const head = commandHead(cmd.split("\n")[0] ?? "");
    return head ? { value: head, kind: "command" } : null;
  }
  if (typeof args.pattern === "string" && args.pattern.trim())
    return { value: args.pattern, kind: "pattern" };
  if (typeof args.url === "string" && args.url.trim())
    return { value: args.url, kind: "url" };
  if (typeof args.query === "string" && args.query.trim())
    return { value: args.query, kind: "query" };
  return null;
}

const WRITE_TOOLS =
  /^(write|edit|multiedit|notebookedit|apply_patch|str_replace|create_file)/i;

function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.test(name.replace(/[^a-z_]/gi, ""));
}

// ---------------------------------------------------------------------------
// Error detection
// ---------------------------------------------------------------------------

// Anchored signatures rather than a bare /failed/ scan: tool output routinely contains the
// word "failed" inside prose or inside a passing test name, and a false error record is
// worse than a missed one — it teaches the next agent something untrue.
// "Exit code 1" states THAT a command failed. It is still an error signature — the
// harness prefixes every failed shell result with it — but it is never the REASON, and
// the reason is the only part worth remembering.
const EXIT_CODE_SIGNATURE = /\bexit(?:ed with)? code [1-9]/i;

const ERROR_SIGNATURES: RegExp[] = [
  /^\s*(?:error|fatal|panic)\b[:\s]/im,
  // An EXPLICIT errno list rather than /E[A-Z]{3,}/, which matched any shouted word and
  // recorded "-> EXACT match to expected string [OK]" as a failure on the first live run.
  /\b(?:EACCES|EADDRINUSE|EAGAIN|EBUSY|ECANCELED|ECONNREFUSED|ECONNRESET|EEXIST|EINVAL|EIO|EISDIR|EMFILE|ENOENT|ENOMEM|ENOSPC|ENOTDIR|ENOTEMPTY|EPERM|EPIPE|EROFS|ETIMEDOUT|EXDEV)\b/,
  /\bTraceback \(most recent call last\)/,
  /\b(?:SyntaxError|TypeError|ReferenceError|RangeError|AssertionError)\b/,
  /\bcommand not found\b/i,
  /\bis not recognized as an internal or external command\b/i,
  /\bPermission denied\b/i,
  EXIT_CODE_SIGNATURE,
  /^\s*error TS\d+:/im,
  /<tool_use_error>/,
  // The classic unix "prog: what went wrong" line. Most real shell failures never print the
  // errno CODE, only its message — `rm: cannot remove 'x': Device or resource busy` contains
  // no "EBUSY" for the pattern above to find. The vocabulary is kept narrow and the `prog: `
  // prefix required, so prose like "0 tests failed" cannot trip it.
  /^\s*[\w.\/\\-]+: [^\n]*\b(?:cannot|can't|unable to|no such|not found|denied|busy|already exists|invalid|failed|fatal)\b/im,
];

// An explicit harness marker. Trusted for ANY tool, because it is a statement that the
// call failed rather than an inference from what the call printed.
const EXPLICIT_ERROR = /<tool_use_error>/;

// How much output a heuristic signature may be found in.
//
// Deliberately small. A command that fails leads with its error; a command that SUCCEEDS
// while printing something error-shaped — `cat build.log`, `grep -r TypeError src`, a test
// runner listing failures it then fixed — buries that text further down. Scanning 4KB found
// "errors" in the output of `sleep` and of a question containing the word EMFILE. A false
// error record is worse than a missed one: it teaches the next agent something untrue.
const ERROR_HEAD_CHARS = 600;

export interface ErrorScanOpts {
  /**
   * Did a command actually run? Heuristic signatures only apply when one did.
   *
   * Tool results that merely CONTAIN error text — a file read, a grep hit, a question whose
   * options mention a failure mode — are content, not failures, and must not be recorded as
   * things that went wrong.
   */
  executed?: boolean;
  /**
   * The harness’s own verdict on the call, when it recorded one.
   *
   * This BEATS reading the output, in both directions, because no amount of scanning text
   * can separate a command that failed from one that succeeded while printing something
   * error-shaped. Real records this fixed: `grep -n "can’t" file` (a HIT, recorded as a
   * failure) and a build log line reading `fatal errors: 0` (a report of zero fatals,
   * recorded as a fatal). Undefined means the provider said nothing — fall back to the
   * signatures rather than assuming success.
   *
   * ASYMMETRY, deliberate and worth knowing: the Claude parser sets this on every tool
   * result (true on failure, false otherwise), so for Claude the heuristics below now run
   * only when a call never returned. Codex builds its ToolCalls without the field, so it
   * still goes through them. The visible consequence is a command that exits 0 while
   * PRINTING a diagnostic — a wrapper swallowing a non-zero child, say: no error record on
   * Claude, one on codex, from identical output. That is the intended trade (an exit code
   * is a statement, prose is a guess), not an oversight. Converging them means teaching
   * createCodexLineParser to populate isError from its own rollout format — which per hard
   * rule 6 needs schema discovery against real ~/.codex/sessions first, never a guess.
   */
  isError?: boolean;
}

export function looksLikeError(
  output: string,
  opts: ErrorScanOpts = { executed: true },
): boolean {
  if (!output) return false;
  // The harness said so, either way. Only guess when it did not.
  if (opts.isError === true) return true;
  if (opts.isError === false) return false;
  if (EXPLICIT_ERROR.test(output.slice(0, 4000))) return true;
  if (!opts.executed) return false;
  return ERROR_SIGNATURES.some((re) =>
    re.test(output.slice(0, ERROR_HEAD_CHARS)),
  );
}

// Every signature that carries a MESSAGE, i.e. all of them but the bare exit code.
const MESSAGE_SIGNATURES = ERROR_SIGNATURES.filter(
  (re) => re !== EXIT_CODE_SIGNATURE,
);

/**
 * Does the output actually SAY what went wrong?
 *
 * Knowing a call failed is not the same as having something to tell the next agent.
 * `grep` finding no match, `test`, `diff --quiet` and `git diff --exit-code` all report
 * their answer AS a non-zero exit, and the harness dutifully marks them failed — but
 * ``grep -n foo bar.ts` failed: Exit code 1` teaches nobody anything. Require a real
 * message before writing a record; the exit code alone is noise that crowds out the
 * records that do carry a lesson.
 */
export function hasErrorMessage(output: string): boolean {
  const head = output.slice(0, ERROR_HEAD_CHARS);
  return MESSAGE_SIGNATURES.some((re) => re.test(head));
}

/** The single most informative line of an error output. */
export function errorGist(output: string): string {
  const head = output.slice(0, ERROR_HEAD_CHARS);
  for (const re of ERROR_SIGNATURES) {
    const line = head.split("\n").find((l) => re.test(l));
    if (line && line.trim()) return line.trim().slice(0, ERROR_MAX);
  }
  return (
    head
      .split("\n")
      .find((l) => l.trim())
      ?.trim()
      .slice(0, ERROR_MAX) ?? ""
  );
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
const PATH_RE =
  /(?:[A-Za-z]:[/\\])?(?:[\w.@~-]+[/\\])+[\w.@-]+\.[A-Za-z][\w]{0,9}/g;

// Identifiers the author chose to mark as code. A far better symbol signal than guessing at
// camelCase in prose, and essentially free.
const BACKTICK_RE = /`([^`\n]{2,80})`/g;

export function extractPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) out.add(m[0].replace(/\\/g, "/"));
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

function entitiesFrom(
  text: string,
  extra: Partial<MemoryEntities> = {},
): MemoryEntities {
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
    id: contentId({
      kind,
      text: target ? "" : clean,
      scope: ctx.sessionId,
      target,
    }),
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

    if (msg.role === "user") {
      const text = msg.text.trim();
      if (!text) continue;
      if (SKIP_PROMPT_PREFIXES.some((p) => text.startsWith(p))) continue;
      // A pasted memory pack is a recollection, not a new instruction.
      if (isMemoryEcho(text)) continue;
      const clipped =
        text.length > PROMPT_MAX ? text.slice(0, PROMPT_MAX - 1) + "…" : text;
      push(
        makeRecord("prompt", clipped, undefined, ts, entitiesFrom(text), ctx),
      );
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
  if (ctx.final && lastAssistant && !isMemoryEcho(lastAssistant.text)) {
    const text =
      lastAssistant.text.length > OUTCOME_MAX
        ? lastAssistant.text.slice(0, OUTCOME_MAX - 1) + "…"
        : lastAssistant.text;
    push(
      makeRecord(
        "outcome",
        text,
        "outcome",
        lastAssistant.ts,
        entitiesFrom(lastAssistant.text),
        ctx,
      ),
    );
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
  const name = tool.name || "tool";
  const args = parseInput(tool.input);
  const target = toolTarget(name, args);
  const isShell = /bash|shell|exec/i.test(name);
  // `_raw` is the fallback parseInput uses when the tool input was not JSON at all — for a
  // shell tool that raw string IS the command line, so it must be honoured here too or the
  // record degrades to just the binary name.
  const rawCommand =
    typeof args.command === "string"
      ? args.command
      : typeof args._raw === "string"
        ? args._raw
        : null;
  const command =
    isShell && rawCommand ? significantCommand(rawCommand) : null;
  const targetFiles =
    target?.kind === "file" ? [target.value.replace(/\\/g, "/")] : [];
  const targetCommands = target?.kind === "command" ? [target.value] : [];

  // An error is the highest-value deterministic record there is: it is the thing a future
  // agent most wants to have been told before it repeats the attempt.
  // A command genuinely ran only for shell-ish tools. Everything else is trusted for an
  // explicit <tool_use_error> marker and nothing more.
  if (looksLikeError(tool.output, { executed: isShell, isError: tool.isError })) {
    const gist = errorGist(tool.output);
    // A command that merely PRINTED an old memory record did not itself fail. Suppress the
    // ERROR record only — the command still ran, and is still worth remembering as one.
    const echo =
      isMemoryEcho(gist) ||
      isMemoryEcho(tool.output.slice(0, ERROR_HEAD_CHARS));
    if (!echo && hasErrorMessage(tool.output)) {
      const what = command ?? (target ? `${name} ${target.value}` : name);
      push(
        makeRecord(
          "error",
          `\`${what}\` failed: ${gist}`,
          `err:${what}:${gist.slice(0, 60)}`,
          ts,
          entitiesFrom(`${what} ${gist}`, {
            commands: targetCommands,
            files: targetFiles,
          }),
          ctx,
        ),
      );
    }
  }

  if (isWriteTool(name) && target?.kind === "file") {
    const file = target.value.replace(/\\/g, "/");
    const key = `artifact:${file}`;
    if (!seenTarget.has(key)) {
      seenTarget.add(key);
      push(
        makeRecord(
          "artifact",
          `edited ${file}`,
          key,
          ts,
          entitiesFrom("", { files: [file] }),
          ctx,
        ),
      );
    }
    return; // an edit is already recorded as an artifact; a tool-call row would say nothing more
  }

  if (!target) return;

  const key = `tool:${name}:${target.value}`;
  if (seenTarget.has(key)) return; // stateless dedup within the slice; ids collapse across slices
  seenTarget.add(key);

  const text = isShell
    ? `ran \`${command ?? target.value}\``
    : `${name} → ${target.value}`;
  push(
    makeRecord(
      "tool-call",
      text,
      key,
      ts,
      entitiesFrom(text, { commands: targetCommands, files: targetFiles }),
      ctx,
    ),
  );
}

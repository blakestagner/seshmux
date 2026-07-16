// MCP bridge server (Task 16.7): exposes ask_codex / ask_claude tools that run the OTHER
// agent headless in the caller's cwd, with hop-budget + no-loop + approval guardrails.
//
// BEHAVIOR DISCOVERY (real runs on this machine, 2026-07-08 — verify before trusting):
//   claude CLI 2.1.205 · codex-cli 0.143.0
//
//   claude -p "<q>"                      → auth inherited (no login prompt); stdout = plain
//     answer text; exit 0; ~6s for a tiny prompt. git working tree untouched by a read prompt.
//   claude -p --output-format json "<q>" → single JSON object; `.result` = answer text,
//     `.is_error` bool, `.total_cost_usd`, `.session_id`, `.permission_denials[]`. exit 0.
//   claude -p --permission-mode plan "<write request>" → PROVABLY READ-ONLY: it plans but
//     does NOT write (verified: requested file never created, git clean). Writes a plan file
//     into ~/.claude/plans/ (outside the repo). Used by plan-off (16.8).
//
//   codex exec -s read-only -C <dir> "<q>"  → auth inherited; `-s read-only` sandbox; `-C`
//     sets working root. Plain stdout ends with the answer line. exit 0. IMPORTANT: codex
//     reads stdin ("Reading additional input from stdin...") — MUST redirect stdin from
//     /dev/null or it hangs waiting for input.
//   codex exec ... --json "<q>"          → NDJSON event stream: thread.started, turn.started,
//     item.completed (item.type==='agent_message' carries `.text` = the answer), turn.completed
//     (has `.usage`). exit 0.
//   codex read-only asked to WRITE       → refuses ("filesystem is read-only"), git clean, exit 0.
//
// So: both agents run headless with inherited auth and exit 0 on success. For ask_* we want a
// plain answer, so use `claude -p <q>` and `codex exec -s read-only -C <cwd> <q> </dev/null`.
// A permission-requiring tool call in read-only mode is refused, not hung — safe default.

import { randomBytes } from 'node:crypto';
import { mkdir, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { requestApprovalOverSocket } from './approval-socket';
import { execCapture } from '../exec-capture';

export const HOP_ENV = 'SESHMUX_HOP';

export type BridgeTarget = 'claude' | 'codex';

export class BridgeLoopError extends Error {
  constructor(hop: number, budget: number) {
    super(`bridge hop budget exceeded: incoming hop ${hop} >= budget ${budget}`);
    this.name = 'BridgeLoopError';
  }
}

export interface RunAgentArgs {
  bin: BridgeTarget;
  prompt: string;
  cwd: string;
  hop: number;
}

export interface BridgeLogEntry {
  ts: number;
  target: BridgeTarget;
  question: string;
  answer: string;
  hop: number;
  ok: boolean;
}

// Spec 5: wait_for_status/read_terminal go through the SAME approval gate as
// ask_* but don't spawn a specific agent bin — ApprovalTarget widens beyond
// BridgeTarget to cover them (approval-socket.ts's `tool` union already does).
export type ApprovalTarget = BridgeTarget | 'wait_for_status' | 'read_terminal';

export interface BridgeDeps {
  runAgent: (args: RunAgentArgs) => Promise<{ text: string; ok: boolean }>;
  requestApproval: (info: { target: ApprovalTarget; question: string; cwd: string; hop: number }) => Promise<boolean>;
  log: (entry: BridgeLogEntry) => Promise<void>;
  budget: number; // hop budget (default 10 at call sites)
  approvalMode?: boolean; // default true — gate every call on UI approval
  now?: () => number; // injectable clock (tests avoid Date.now)
  // Spec 5: wait_for_status crosses into the WEB SERVER process (the events-hub
  // lives there, this mcp-bridge process doesn't) via the wait-socket transport.
  waitForStatus?: (req: { project: string; session?: string; status: string; timeoutSec?: number }) => Promise<{ status: string; error?: string }>;
  // Spec 5: read_terminal is self-contained — resolves a live ptyId itself
  // (dial the daemon directly, no server process needed) then peeks scrollback.
  // cwd is returned alongside ptyId so the caller can refuse reading its OWN
  // session (cwd === process.cwd()).
  resolveLivePty?: (project: string) => Promise<{ ptyId: string; cwd: string } | null>;
  peekTerminal?: (ptyId: string, lines?: number) => Promise<{ ptyId: string; lines: string[] }>;
}

export interface BridgeCall {
  target: BridgeTarget;
  question: string;
  cwd: string;
  hopEnv: string | undefined; // incoming SESHMUX_HOP value
}

// Incoming hop → this call's hop number. Unset/invalid → 1 (first hop).
export function nextHop(hopEnv: string | undefined): number {
  const n = Number(hopEnv);
  return Number.isFinite(n) && n >= 0 ? n + 1 : 1;
}

// Hop-tagged prompt so the far side knows its depth and can refuse to recurse further.
function tagPrompt(question: string, hop: number): string {
  return `[seshmux-bridge hop=${hop}] ${question}`;
}

// Shared preamble for EVERY bridge verb (ask_*, wait_for_status, read_terminal):
// loop guard → approval. Factored out of runBridgedCall so wait/peek (which don't
// spawn an agent) gate identically to ask_* without duplicating the guard logic.
// Throws BridgeLoopError / a denial Error — callers decide how to surface that
// (ask_* lets it propagate as an MCP isError result; wait/peek do the same).
export async function guardBridgeCall(
  call: { target: ApprovalTarget; question: string; cwd: string; hopEnv: string | undefined },
  deps: Pick<BridgeDeps, 'requestApproval' | 'budget' | 'approvalMode'>,
): Promise<{ hop: number }> {
  const hop = nextHop(call.hopEnv);

  // No-loop rule: refuse once the incoming depth reaches the budget (before any spawn).
  const incoming = Number(call.hopEnv);
  if (Number.isFinite(incoming) && incoming >= deps.budget) {
    throw new BridgeLoopError(incoming, deps.budget);
  }

  // Approval gate (default ON): block until approved. The default requestApproval blocks on
  // the UI over the approval socket, with a server-side 120s timeout → deny (fail-closed).
  if (deps.approvalMode !== false) {
    const approved = await deps.requestApproval({
      target: call.target,
      question: call.question,
      cwd: call.cwd,
      hop,
    });
    if (!approved) throw new Error('bridge call denied (approval not granted)');
  }

  return { hop };
}

// The guarded core: loop guard → approval → run → log. Deps injected for testing.
export async function runBridgedCall(call: BridgeCall, deps: BridgeDeps): Promise<{ text: string }> {
  const { hop } = await guardBridgeCall(call, deps);

  const result = await deps.runAgent({
    bin: call.target,
    prompt: tagPrompt(call.question, hop),
    cwd: call.cwd,
    hop,
  });

  const now = deps.now ? deps.now() : 0;
  await deps.log({
    ts: now,
    target: call.target,
    question: call.question,
    answer: result.text,
    hop,
    ok: result.ok,
  });

  return { text: result.text };
}

// Default real runner using the verified headless invocations. hop is threaded via the
// SESHMUX_HOP env so a bridged agent that calls back knows its depth.
export async function defaultRunAgent(args: RunAgentArgs): Promise<{ text: string; ok: boolean }> {
  // SECURITY: prompt + cwd become argv. A leading `-` could parse as a CLI flag (argument
  // injection) — e.g. `--dangerously-skip-permissions` would defeat the codex read-only
  // sandbox. Reject leading-`-` here (defense-in-depth atop the provider's `--` shield).
  // Prompts are hop-tagged (`[seshmux-bridge hop=N] …`) so never legitimately start with `-`.
  if (/^-/.test(args.prompt)) return { text: 'bridge prompt may not start with "-"', ok: false };
  if (/^-/.test(args.cwd)) return { text: 'bridge cwd may not start with "-"', ok: false };

  // Binary name + sandbox flags come from the PROVIDER (hard rule 3) — this file only spawns.
  const { getProviders } = await import('../providers/types');
  const providers = await getProviders();
  const provider = providers.find((p) => p.id === args.bin);
  if (!provider) return { text: `unknown provider: ${args.bin}`, ok: false };
  const [bin, ...rest] = provider.commands.headlessAsk(args.cwd, args.prompt);

  const env = { ...process.env, [HOP_ENV]: String(args.hop) };
  return execCapture(bin, rest, { cwd: args.cwd, env, timeoutMs: 120_000, maxBuffer: 16 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------
// Task 16.7: MCP stdio server exposing ask_codex / ask_claude to whichever
// agent has this bridge registered as an MCP tool provider.
// ---------------------------------------------------------------------------

// Default logger: append one JSON line per exchange to <configDir>/bridge-log.jsonl.
// Uses bridgeConfigDir() so it honors SESHMUX_CONFIG_DIR — same dir as approval.sock, so a
// custom config dir keeps the log next to the socket instead of a stale ~/.config/seshmux.
// Never throws — a logging failure must not break a bridge call.
export async function defaultBridgeLog(entry: BridgeLogEntry): Promise<void> {
  try {
    const dir = bridgeConfigDir();
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'bridge-log.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    /* logging must never crash the bridge */
  }
}

// Config dir shared with the web server + daemon (env override → same as daemon/ensure.js).
export function bridgeConfigDir(): string {
  return process.env.SESHMUX_CONFIG_DIR || join(homedir(), '.config', 'seshmux');
}
function approvalSocketPath(): string {
  return join(bridgeConfigDir(), 'approval.sock');
}

// Real approval: block on the seshmux UI over the approval socket. The web server owns the
// listener (it broadcasts a toast + awaits the human, with a 120s server-side timeout → deny).
// FAIL-CLOSED: if the server isn't listening or dies mid-approval, the client denies.
// `tool` names the agent that WOULD run for ask_* (target); for wait_for_status/
// read_terminal (Spec 5) target IS the tool name — no agent bin to name.
export async function defaultRequestApproval(info: {
  target: ApprovalTarget;
  question: string;
  cwd: string;
  hop: number;
}): Promise<boolean> {
  const requestId = randomBytes(12).toString('hex');
  const tool =
    info.target === 'wait_for_status' || info.target === 'read_terminal'
      ? info.target
      : info.target === 'codex'
        ? 'ask_codex'
        : 'ask_claude';
  return requestApprovalOverSocket(approvalSocketPath(), {
    requestId,
    tool,
    question: info.question,
    cwd: info.cwd,
    hop: info.hop,
  });
}

function waitSocketPath(): string {
  return join(bridgeConfigDir(), 'wait.sock');
}

// Real wait_for_status: hop to the WEB SERVER process over the wait socket (the
// events-hub this needs lives there — see wait-socket.ts doc comment). FAIL-SAFE:
// requestWaitOverSocket already resolves {status:'timeout'} on any transport error.
export async function defaultWaitForStatus(req: {
  project: string;
  session?: string;
  status: string;
  timeoutSec?: number;
}): Promise<{ status: string; error?: string }> {
  const { requestWaitOverSocket } = await import('./wait-socket');
  return requestWaitOverSocket(waitSocketPath(), req as Parameters<typeof requestWaitOverSocket>[1]);
}

// Real read_terminal target resolution: self-contained, no server process needed
// (see peek.ts doc comment) — dial the daemon directly for the live ptyId list,
// resolve the project id to a repo path via the SAME provider registry
// defaultRunAgent already uses, and cwd-match. Returns cwd alongside ptyId so
// the caller can refuse reading its OWN session.
export async function defaultResolveLivePty(project: string): Promise<{ ptyId: string; cwd: string } | null> {
  const { getProviders } = await import('../providers/types');
  const { dial } = await import('../../daemon-client');
  const providers = await getProviders();
  let repo: string | null = null;
  for (const p of providers) {
    const projects = await p.scanProjects().catch(() => []);
    const hit = projects.find((pr) => pr.id === project);
    if (hit) {
      repo = hit.path;
      break;
    }
  }
  if (!repo) return null;
  let conn = null as Awaited<ReturnType<typeof dial>> | null;
  try {
    conn = await dial();
    const { ptys } = await conn.list();
    const hit = ptys.find((p) => p.alive && p.cwd === repo);
    return hit ? { ptyId: hit.ptyId, cwd: hit.cwd } : null;
  } catch {
    return null;
  } finally {
    if (conn) conn.close();
  }
}

function defaultBridgeDeps(): BridgeDeps {
  return {
    runAgent: defaultRunAgent,
    budget: Number(process.env.SESHMUX_HOP_BUDGET) || 10,
    approvalMode: true,
    log: defaultBridgeLog,
    requestApproval: defaultRequestApproval,
    waitForStatus: defaultWaitForStatus,
    resolveLivePty: defaultResolveLivePty,
    peekTerminal: async (ptyId: string, lines?: number) => {
      const { peekTerminal } = await import('./peek');
      return peekTerminal(ptyId, lines);
    },
  };
}

// Builds a BridgeCall and runs it, returning an MCP tool result. Guardrail failures
// (loop budget, denial) become isError results rather than thrown exceptions, so a
// single bad call never crashes the stdio server.
async function handleAsk(
  target: BridgeTarget,
  question: string,
  context: string | undefined,
  deps: BridgeDeps,
) {
  const call: BridgeCall = {
    target,
    question: question + (context ? '\n\nContext: ' + context : ''),
    cwd: process.cwd(),
    hopEnv: process.env[HOP_ENV],
  };
  try {
    const result = await runBridgedCall(call, deps);
    return { content: [{ type: 'text' as const, text: result.text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text' as const, text: message }], isError: true };
  }
}

// Spec 5 wait_for_status tool handler: loop guard + approval (guardBridgeCall,
// same as ask_*), then a status wait routed to the WEB SERVER process over the
// wait socket (waitForStatus dep — see defaultWaitForStatus doc comment).
//
// "Never throws" is scoped to the STATUS WAIT ITSELF timing out (Spec 5 design:
// "resolves {status:'timeout'}, never throws — agents handle it as data") — that
// is a returned isError result either way, never a JS throw out of this handler.
// A loop-guard trip or an approval denial is a DIFFERENT condition (the wait
// never even started) and must stay observably distinct from a real timeout —
// masking it as {status:'timeout'} would make a tripped guard indistinguishable
// from "the target just never got there," which is exactly the bug read_terminal
// avoids by returning isError. Mirror that here.
export async function handleWait(
  project: string,
  status: string,
  session: string | undefined,
  timeoutSec: number | undefined,
  deps: BridgeDeps,
) {
  const cwd = process.cwd();
  try {
    await guardBridgeCall(
      { target: 'wait_for_status', question: `wait for ${project} to reach ${status}`, cwd, hopEnv: process.env[HOP_ENV] },
      deps,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text' as const, text: message }], isError: true };
  }
  const waitForStatus = deps.waitForStatus ?? defaultWaitForStatus;
  const result = await waitForStatus({ project, session, status, timeoutSec });
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

// Spec 5 read_terminal tool handler: refuses the caller's OWN session (its live
// PTY's cwd === process.cwd() — the only signal available without a real
// ptyId->sessionId map, same ambiguity ceiling as bridge.ts's
// resolvePtyForSession), then loop guard + approval, then a self-contained
// scrollback peek (no server process hop — see peek.ts doc comment).
export async function handleReadTerminal(
  project: string,
  lines: number | undefined,
  deps: BridgeDeps,
) {
  const cwd = process.cwd();
  const resolveLivePty = deps.resolveLivePty ?? defaultResolveLivePty;
  const target = await resolveLivePty(project);
  if (!target) {
    return { content: [{ type: 'text' as const, text: 'no live session found for this project' }], isError: true };
  }
  if (target.cwd === cwd) {
    return { content: [{ type: 'text' as const, text: 'read_terminal refuses to peek the caller\'s own session' }], isError: true };
  }
  try {
    await guardBridgeCall(
      { target: 'read_terminal', question: `read terminal output for ${project}`, cwd, hopEnv: process.env[HOP_ENV] },
      deps,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text' as const, text: message }], isError: true };
  }
  const peekTerminal = deps.peekTerminal ?? (async (id: string, l?: number) => (await import('./peek')).peekTerminal(id, l));
  const result = await peekTerminal(target.ptyId, lines);
  return { content: [{ type: 'text' as const, text: result.lines.join('\n') }] };
}

// Creates (but does not connect) the MCP server exposing ask_codex/ask_claude.
// Split out from startMcpBridge so tests can register tools without opening stdio.
export function createMcpBridgeServer(deps: BridgeDeps = defaultBridgeDeps()): McpServer {
  const server = new McpServer({ name: 'seshmux-bridge', version: '1.0.0' });

  server.registerTool(
    'ask_codex',
    {
      description: "Ask the Codex agent a question, running it headless in the caller's cwd.",
      inputSchema: {
        question: z.string(),
        context: z.string().optional(),
      },
    },
    async ({ question, context }) => handleAsk('codex', question, context, deps),
  );

  server.registerTool(
    'ask_claude',
    {
      description: "Ask the Claude agent a question, running it headless in the caller's cwd.",
      inputSchema: {
        question: z.string(),
        context: z.string().optional(),
      },
    },
    async ({ question, context }) => handleAsk('claude', question, context, deps),
  );

  server.registerTool(
    'wait_for_status',
    {
      description:
        "Block until another agent's session reaches a status ('waiting' or 'idle'), or time out. Never throws — returns {status:'timeout'} as data on timeout, loop-guard trip, or approval denial.",
      inputSchema: {
        project: z.string(),
        session: z.string().optional(),
        status: z.enum(['waiting', 'idle']),
        timeoutSec: z.number().optional(),
      },
    },
    async ({ project, session, status, timeoutSec }) => handleWait(project, status, session, timeoutSec, deps),
  );

  server.registerTool(
    'read_terminal',
    {
      description:
        "Read the last N lines of another agent's live terminal scrollback (ANSI-stripped). Refuses to read the caller's own session.",
      inputSchema: {
        project: z.string(),
        lines: z.number().optional(),
      },
    },
    async ({ project, lines }) => handleReadTerminal(project, lines, deps),
  );

  return server;
}

// Entry point for `seshmux mcp-bridge`: creates the server and connects it over stdio.
// deps is optional/overridable so tests can inject fakes without touching real stdio.
export async function startMcpBridge(deps: BridgeDeps = defaultBridgeDeps()): Promise<McpServer> {
  const server = createMcpBridgeServer(deps);
  await server.connect(new StdioServerTransport());
  return server;
}

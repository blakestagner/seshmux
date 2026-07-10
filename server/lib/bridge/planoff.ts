// Plan-off (Task 16.8): run claude and codex read-only planning IN PARALLEL over the same
// task, so the caller can compare and pick a winner before any code gets written.
//
// VERIFIED DISCOVERY (real runs on this machine, 2026-07-08 — use these EXACT invocations):
//   claude read-only planning: `claude -p --permission-mode plan "<task>"` — PROVABLY
//     read-only (verified: asked to write a file, it planned but did NOT write, git stayed
//     clean, exit 0). Auth inherited. Plain stdout carries the plan text.
//   codex read-only planning: `codex exec -s read-only -C <cwd> "<task>"` with stdin closed
//     (child.stdin.end()) — sandbox read-only, refuses writes, exit 0, git clean. IMPORTANT:
//     codex hangs if stdin is not closed.
// Both exit 0 on success. A write attempt under these modes is refused, not hung.

import { execFile } from 'node:child_process';

export type PlanoffProvider = 'claude' | 'codex';

export interface PlanResult {
  provider: PlanoffProvider;
  ok: boolean;
  plan: string;
  error?: string;
  durationMs: number;
}

export interface PlanoffResult {
  claude: PlanResult;
  codex: PlanResult;
}

export interface RunPlannerArgs {
  provider: PlanoffProvider;
  cwd: string;
  task: string;
}

export interface PlanoffDeps {
  // Injectable runner seam (mirrors mcp.ts's runAgent / detect.ts pattern). Default = real
  // execFile using the exact read-only flags documented above.
  runPlanner?: (args: RunPlannerArgs) => Promise<{ plan: string; ok: boolean }>;
  // Injectable clock for deterministic durationMs in tests — tests must not call Date.now.
  // The DEFAULT runner uses Date.now internally; tests inject an incrementing counter instead.
  now?: () => number;
}

const TIMEOUT_MS = 300_000; // 5 minutes per side

// Default real runner: builds the read-only plan argv from the PROVIDER (hard rule 3 — the
// `claude`/`codex` binary names + sandbox flags live in server/lib/providers/, not here) and
// only does the spawn + output capture. runPlanoff() itself just takes projectPath/task.
export async function defaultRunPlanner(args: RunPlannerArgs): Promise<{ plan: string; ok: boolean }> {
  // SECURITY: task + cwd become argv values. A leading `-` could parse as a CLI flag
  // (argument injection) — e.g. task `--dangerously-skip-permissions` would defeat the
  // read-only sandbox plan-off relies on. Defense-in-depth atop the provider's `--` shield:
  // reject leading-`-` inputs here before building argv. (cwd is `-C`'s value, before `--`.)
  if (/^-/.test(args.task)) throw new Error('planoff task may not start with "-"');
  if (/^-/.test(args.cwd)) throw new Error('planoff cwd may not start with "-"');

  const { getProviders } = await import('../providers/types');
  const providers = await getProviders();
  const provider = providers.find((p) => p.id === args.provider);
  if (!provider) throw new Error(`unknown provider: ${args.provider}`);
  const [bin, ...rest] = provider.commands.headlessPlan(args.cwd, args.task);

  return new Promise((resolve) => {
    const child = execFile(
      bin,
      rest,
      { cwd: args.cwd, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve({ plan: (stdout || '').trim(), ok: !err }),
    );
    child.stdin?.end(); // codex hangs waiting on stdin; harmless no-op for claude
  });
}

// Run one side, timing it with the injectable clock. Never rejects — a thrown/rejected
// runner becomes {ok:false, error, plan:''} so Promise.allSettled always "settles fulfilled"
// for our purposes and one failing side can't sink the other.
async function runSide(
  provider: PlanoffProvider,
  cwd: string,
  task: string,
  deps: Required<Pick<PlanoffDeps, 'runPlanner' | 'now'>>,
): Promise<PlanResult> {
  const start = deps.now();
  try {
    const { plan, ok } = await deps.runPlanner({ provider, cwd, task });
    return { provider, ok, plan, durationMs: deps.now() - start };
  } catch (err) {
    return {
      provider,
      ok: false,
      plan: '',
      error: err instanceof Error ? err.message : String(err),
      durationMs: deps.now() - start,
    };
  }
}

export async function runPlanoff(
  projectPath: string,
  task: string,
  deps: PlanoffDeps = {},
): Promise<PlanoffResult> {
  const resolvedDeps = {
    runPlanner: deps.runPlanner ?? defaultRunPlanner,
    now: deps.now ?? Date.now,
  };

  const [claude, codex] = await Promise.allSettled([
    runSide('claude', projectPath, task, resolvedDeps),
    runSide('codex', projectPath, task, resolvedDeps),
  ]);

  // runSide never rejects, so both settle 'fulfilled'; allSettled here is belt-and-suspenders.
  return {
    claude: claude.status === 'fulfilled'
      ? claude.value
      : { provider: 'claude', ok: false, plan: '', error: String(claude.reason), durationMs: 0 },
    codex: codex.status === 'fulfilled'
      ? codex.value
      : { provider: 'codex', ok: false, plan: '', error: String(codex.reason), durationMs: 0 },
  };
}

// Picks the chosen side's result. File writes (winner -> .seshmux/planoff-winner.md, loser ->
// scratchpad) happen at the route layer — this just returns the data.
export function pickWinner(planoff: PlanoffResult, provider: PlanoffProvider): PlanResult {
  return planoff[provider];
}

// Optional formatter for the winner file the route layer writes to
// `<repo>/.seshmux/planoff-winner.md`.
export function winnerMarkdown(result: PlanResult, task: string): string {
  return [
    `# Plan-off winner: ${result.provider}`,
    '',
    `**Task:** ${task}`,
    `**Duration:** ${result.durationMs}ms`,
    '',
    '## Plan',
    '',
    result.plan,
  ].join('\n');
}

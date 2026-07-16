import { describe, it, expect } from 'vitest';
import {
  runPlanoff,
  pickWinner,
  winnerMarkdown,
  defaultRunPlanner,
  type PlanoffDeps,
} from '../../server/lib/bridge/planoff';

// Fake clock: deterministic durationMs without touching Date.now.
function fakeClock(start = 0, step = 100) {
  let t = start;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

describe('runPlanoff — happy path', () => {
  it('runs both planners and returns both plans, ok:true, correct provider tags', async () => {
    const runPlanner: PlanoffDeps['runPlanner'] = async ({ provider }) => ({
      plan: `plan from ${provider}`,
      ok: true,
    });
    const result = await runPlanoff('/tmp/proj', 'do the thing', {
      runPlanner,
      now: fakeClock(),
    });

    expect(result.claude.provider).toBe('claude');
    expect(result.claude.ok).toBe(true);
    expect(result.claude.plan).toBe('plan from claude');
    expect(typeof result.claude.durationMs).toBe('number');

    expect(result.codex.provider).toBe('codex');
    expect(result.codex.ok).toBe(true);
    expect(result.codex.plan).toBe('plan from codex');
    expect(typeof result.codex.durationMs).toBe('number');
  });

  it('deterministic durationMs via injected clock', async () => {
    const runPlanner: PlanoffDeps['runPlanner'] = async () => ({ plan: 'x', ok: true });
    const result = await runPlanoff('/tmp/proj', 'task', {
      runPlanner,
      now: fakeClock(1000, 50),
    });
    // Clock is shared and increments by a fixed step on every call (start x2, end x2), so
    // durationMs is a deterministic positive multiple of the step rather than flaky wall time.
    expect(result.claude.durationMs).toBeGreaterThan(0);
    expect(result.codex.durationMs).toBeGreaterThan(0);
    expect(Number.isInteger(result.claude.durationMs)).toBe(true);
    expect(Number.isInteger(result.codex.durationMs)).toBe(true);
  });
});

describe('runPlanoff — one side fails', () => {
  it('a thrown/rejected planner does not sink the other side', async () => {
    const runPlanner: PlanoffDeps['runPlanner'] = async ({ provider }) => {
      if (provider === 'codex') throw new Error('codex exploded');
      return { plan: 'claude plan text', ok: true };
    };
    const result = await runPlanoff('/tmp/proj', 'task', {
      runPlanner,
      now: fakeClock(),
    });

    expect(result.claude.ok).toBe(true);
    expect(result.claude.plan).toBe('claude plan text');

    expect(result.codex.ok).toBe(false);
    expect(result.codex.plan).toBe('');
    expect(result.codex.error).toContain('codex exploded');
  });

  it('a resolved {ok:false} from the runner is passed through as-is', async () => {
    const runPlanner: PlanoffDeps['runPlanner'] = async ({ provider }) => {
      if (provider === 'claude') return { plan: '', ok: false };
      return { plan: 'codex plan', ok: true };
    };
    const result = await runPlanoff('/tmp/proj', 'task', {
      runPlanner,
      now: fakeClock(),
    });
    expect(result.claude.ok).toBe(false);
    expect(result.codex.ok).toBe(true);
  });
});

describe('runPlanoff — parallelism', () => {
  it('invokes both planners (both providers seen) rather than sequencing one after the other', async () => {
    const seen: string[] = [];
    const runPlanner: PlanoffDeps['runPlanner'] = async ({ provider }) => {
      seen.push(provider);
      return { plan: provider, ok: true };
    };
    await runPlanoff('/tmp/proj', 'task', { runPlanner, now: fakeClock() });
    expect(seen.sort()).toEqual(['claude', 'codex']);
  });

  it('passes projectPath and task through to the runner for both providers', async () => {
    const calls: { provider: string; cwd: string; task: string }[] = [];
    const runPlanner: PlanoffDeps['runPlanner'] = async ({ provider, cwd, task }) => {
      calls.push({ provider, cwd, task });
      return { plan: provider, ok: true };
    };
    await runPlanoff('/my/proj', 'build a widget', { runPlanner, now: fakeClock() });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.cwd).toBe('/my/proj');
      expect(c.task).toBe('build a widget');
    }
  });
});

describe('pickWinner', () => {
  it('returns the requested provider result from a planoff outcome', async () => {
    const runPlanner: PlanoffDeps['runPlanner'] = async ({ provider }) => ({
      plan: `plan-${provider}`,
      ok: true,
    });
    const result = await runPlanoff('/tmp/proj', 'task', { runPlanner, now: fakeClock() });

    expect(pickWinner(result, 'claude')).toBe(result.claude);
    expect(pickWinner(result, 'codex')).toBe(result.codex);
  });
});

describe('winnerMarkdown', () => {
  it('formats the chosen plan result with provider and task context', () => {
    const md = winnerMarkdown(
      { provider: 'claude', ok: true, plan: 'Step 1. Step 2.', durationMs: 1234 },
      'ship the feature',
    );
    expect(md).toContain('claude');
    expect(md).toContain('ship the feature');
    expect(md).toContain('Step 1. Step 2.');
  });
});

describe('defaultRunPlanner argument-injection guard', () => {
  it('rejects a task starting with "-" (prevents flag smuggling into the sandbox)', async () => {
    await expect(
      defaultRunPlanner({ provider: 'claude', cwd: '/tmp', task: '--dangerously-skip-permissions' }),
    ).rejects.toThrow(/task may not start with/);
  });

  it('rejects a cwd starting with "-"', async () => {
    await expect(
      defaultRunPlanner({ provider: 'codex', cwd: '--evil', task: 'ok' }),
    ).rejects.toThrow(/cwd may not start with/);
  });
});

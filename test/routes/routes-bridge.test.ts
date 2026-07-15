import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bridgeRoutes, { type BridgeRouteDeps } from '../../server/routes/bridge';

const origin = 'http://127.0.0.1:4700';
let repo: string;
let registered = false;

// Records startSession calls so tests can assert the opposite-provider + first-prompt wiring.
function recorder() {
  const calls: any[] = [];
  const startSession: BridgeRouteDeps['startSession'] = async (opts) => {
    calls.push(opts);
    return { ptyId: 'pty-1', tabMeta: { provider: opts.provider } };
  };
  return { calls, startSession };
}

function makeApp(over: Partial<BridgeRouteDeps> = {}) {
  const { calls, startSession } = recorder();
  const f = Fastify();
  const deps: BridgeRouteDeps = {
    startSession,
    resolveRepo: () => repo,
    // Hermetic: never let the default hit the real provider stores.
    resolveSessionCwd: async () => null,
    // Source session is claude → target must be codex.
    resolveSessionProvider: async () => 'claude',
    composeBrief: async () => '# Handoff brief\ntask: do the thing',
    composeDiffReview: async () => '# Cross-review\ndiff here',
    runPlanoff: async () => ({
      claude: { provider: 'claude', ok: true, plan: 'plan A', durationMs: 1 },
      codex: { provider: 'codex', ok: true, plan: 'plan B', durationMs: 1 },
    }),
    // Injected so the register route NEVER touches the real ~/.claude.json / config.toml.
    registerBridge: async () => { registered = true; },
    bridgeStatus: async () => ({ claude: registered, codex: registered }),
    ...over,
  };
  f.register(bridgeRoutes, deps);
  return { f, calls };
}

beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'bridge-')); registered = false; });
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('POST /api/bridge/handoff', () => {
  it('writes the brief file and starts the OPPOSITE-provider session', async () => {
    const { f, calls } = makeApp();
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/handoff', headers: { origin },
      payload: { projectId: 'demo', sessionId: 's1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ptyId: 'pty-1' });
    // source claude → target codex
    expect(calls[0].provider).toBe('codex');
    expect(calls[0].firstPrompt).toContain('Handoff brief');
    expect(existsSync(join(repo, '.seshmux', 'handoff-brief.md'))).toBe(true);
  });
});

describe('POST /api/bridge/review', () => {
  it('writes the review and starts the opposite provider', async () => {
    const { f, calls } = makeApp();
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/review', headers: { origin },
      payload: { projectId: 'demo', sessionId: 's1' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0].provider).toBe('codex');
    expect(calls[0].firstPrompt).toContain('Cross-review');
  });

  it('appends a review entry to the shared scratchpad (provider + timestamp header)', async () => {
    const { f } = makeApp();
    await f.inject({
      method: 'POST', url: '/api/bridge/review', headers: { origin },
      payload: { projectId: 'demo', sessionId: 's1' },
    });
    const sp = readFileSync(join(repo, '.seshmux', 'handoff.md'), 'utf8');
    expect(sp).toContain('Review requested');
    expect(sp).toContain('Codex reviewing Claude'); // target reviews source
    expect(sp).toMatch(/\d{4}-\d{2}-\d{2}T/); // ISO timestamp header
  });
});

describe('POST /api/bridge/planoff', () => {
  it('runs both planners and returns both plans', async () => {
    const { f } = makeApp();
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/planoff', headers: { origin },
      payload: { projectId: 'demo', task: 'ship the feature' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.claude.plan).toBe('plan A');
    expect(body.codex.plan).toBe('plan B');
  });

  it('404s (not 500, no internals echoed) on a missing or unknown sessionId (R4-1)', async () => {
    // Unknown session: prod compose throws 'session not found' — inject the same.
    const { f } = makeApp({
      composeBrief: async () => { throw new Error('session not found: demo/nope'); },
    });
    for (const payload of [{ projectId: 'demo' }, { projectId: 'demo', sessionId: 'nope' }]) {
      const res = await f.inject({
        method: 'POST', url: '/api/bridge/handoff', headers: { origin },
        payload,
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('undefined'); // no internal error echo
      expect(res.body).not.toContain('demo/nope'); // compose message not leaked
    }
  });

  it('404s (not 500) when projectId is entirely missing from the body', async () => {
    const { f } = makeApp();
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/planoff', headers: { origin },
      payload: { task: 'do a thing' },
    });
    expect(res.statusCode).toBe(404); // repoOrNull null-guards a missing projectId
  });

  it('rejects a task starting with "-" (argument-injection guard)', async () => {
    const { f } = makeApp();
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/planoff', headers: { origin },
      payload: { projectId: 'demo', task: '--dangerously-skip-permissions' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/bridge/planoff/pick', () => {
  it('writes winner file, appends loser to scratchpad, starts execution session', async () => {
    const { f, calls } = makeApp();
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/planoff/pick', headers: { origin },
      payload: {
        projectId: 'demo',
        provider: 'claude',
        task: 'ship it',
        planoff: {
          claude: { provider: 'claude', ok: true, plan: 'winning plan', durationMs: 1 },
          codex: { provider: 'codex', ok: true, plan: 'losing plan', durationMs: 1 },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(repo, '.seshmux', 'planoff-winner.md'))).toBe(true);
    expect(readFileSync(join(repo, '.seshmux', 'planoff-winner.md'), 'utf8')).toContain('winning plan');
    // execution session started with the winning provider
    expect(calls[0].provider).toBe('claude');
    expect(calls[0].firstPrompt.toLowerCase()).toContain('execute');
  });

  // R2-3: validate BEFORE indexing — an invalid provider or malformed body used to index to
  // undefined and 500 with a TypeError; a failed/empty winner used to seed an empty execution.
  it('400s an invalid provider (no 500 TypeError)', async () => {
    const { f, calls } = makeApp();
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/planoff/pick', headers: { origin },
      payload: {
        projectId: 'demo', provider: 'gpt', task: 't',
        planoff: {
          claude: { provider: 'claude', ok: true, plan: 'p', durationMs: 1 },
          codex: { provider: 'codex', ok: true, plan: 'q', durationMs: 1 },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(calls.length).toBe(0); // never seeded an execution session
  });

  it('400s a malformed planoff body', async () => {
    const { f, calls } = makeApp();
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/planoff/pick', headers: { origin },
      payload: { projectId: 'demo', provider: 'claude', task: 't', planoff: { claude: {} } },
    });
    expect(res.statusCode).toBe(400);
    expect(calls.length).toBe(0);
  });

  it('400s when the winning plan failed or is empty (never seeds an empty execution)', async () => {
    const { f, calls } = makeApp();
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/planoff/pick', headers: { origin },
      payload: {
        projectId: 'demo', provider: 'claude', task: 't',
        planoff: {
          claude: { provider: 'claude', ok: false, plan: '', error: 'timeout', durationMs: 1 },
          codex: { provider: 'codex', ok: true, plan: 'q', durationMs: 1 },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(calls.length).toBe(0);
  });
});

describe('repo resolution guard', () => {
  it('404s an unresolvable projectId, never spawns', async () => {
    const { f, calls } = makeApp({ resolveRepo: () => null });
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/handoff', headers: { origin },
      payload: { projectId: 'nope', sessionId: 's1' },
    });
    expect(res.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('POST /api/bridge/register', () => {
  it('registers the MCP bridge and returns the resulting status', async () => {
    const { f } = makeApp();
    expect(registered).toBe(false);
    const res = await f.inject({ method: 'POST', url: '/api/bridge/register', headers: { origin } });
    expect(res.statusCode).toBe(200);
    expect(registered).toBe(true); // registerBridge was called (injected, no real config touched)
    expect(res.json()).toEqual({ claude: true, codex: true });
  });
});

// Spec 5 — hermetic route tests: fake listLivePtys (no real daemon dial), fake
// waitForStatus/peekTerminal so these never touch a real events-hub or socket.
describe('POST /api/bridge/wait', () => {
  it('resolves a live ptyId by cwd match and calls the injected waitForStatus', async () => {
    const calls: any[] = [];
    const { f } = makeApp({
      listLivePtys: async () => [{ ptyId: 'pty-live-1', cwd: repo }],
      waitForStatus: async (ptyId, status, timeoutSec) => {
        calls.push({ ptyId, status, timeoutSec });
        return { status };
      },
    });
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/wait', headers: { origin },
      payload: { projectId: 'demo', status: 'waiting', timeoutSec: 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'waiting' });
    expect(calls[0]).toEqual({ ptyId: 'pty-live-1', status: 'waiting', timeoutSec: 30 });
  });

  it('rejects an invalid status value', async () => {
    const { f } = makeApp({ waitForStatus: async () => ({ status: 'waiting' }) });
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/wait', headers: { origin },
      payload: { projectId: 'demo', status: 'bogus' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s when no live PTY matches the resolved repo', async () => {
    const { f } = makeApp({ listLivePtys: async () => [], waitForStatus: async () => ({ status: 'waiting' }) });
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/wait', headers: { origin },
      payload: { projectId: 'demo', status: 'waiting' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('501s when no events hub is wired (waitForStatus not injected)', async () => {
    const { f } = makeApp({ waitForStatus: undefined });
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/wait', headers: { origin },
      payload: { projectId: 'demo', status: 'waiting' },
    });
    expect(res.statusCode).toBe(501);
  });
});

describe('GET /api/bridge/peek', () => {
  it('resolves a live ptyId by cwd match and calls the injected peekTerminal', async () => {
    const calls: any[] = [];
    const { f } = makeApp({
      listLivePtys: async () => [{ ptyId: 'pty-live-1', cwd: repo }],
      peekTerminal: async (ptyId, lines) => {
        calls.push({ ptyId, lines });
        return { ptyId, lines: ['hello', 'world'] };
      },
    });
    const res = await f.inject({
      method: 'GET', url: `/api/bridge/peek?projectId=demo&lines=42`, headers: { origin },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ptyId: 'pty-live-1', lines: ['hello', 'world'] });
    expect(calls[0]).toEqual({ ptyId: 'pty-live-1', lines: 42 });
  });

  it('404s when no live PTY matches the resolved repo', async () => {
    const { f } = makeApp({ listLivePtys: async () => [] });
    const res = await f.inject({ method: 'GET', url: '/api/bridge/peek?projectId=demo', headers: { origin } });
    expect(res.statusCode).toBe(404);
  });

  it('400s a request whose callerProjectId matches the target (refuses peeking own session)', async () => {
    const { f } = makeApp({ listLivePtys: async () => [{ ptyId: 'pty-live-1', cwd: repo }] });
    const res = await f.inject({
      method: 'GET', url: '/api/bridge/peek?projectId=demo&callerProjectId=demo', headers: { origin },
    });
    expect(res.statusCode).toBe(400);
  });
});

// Worktree fold: a folded worktree session lists under the PARENT projectId, but its
// work happened in the worktree checkout — spawn/compose/scratchpad must use the
// session's OWN cwd, or the handoff diffs/executes against the wrong tree.
describe('bridge uses the session\'s own cwd for folded worktree sessions', () => {
  it('handoff spawns and writes the brief in the session cwd, not the parent repo', async () => {
    const wt = join(repo, '.claude', 'worktrees', 'agent-a');
    mkdirSync(wt, { recursive: true });
    const { f, calls } = makeApp({ resolveSessionCwd: async () => wt });
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/handoff', headers: { origin },
      payload: { projectId: 'demo', sessionId: 's1' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0].projectPath).toBe(wt);
    expect(existsSync(join(wt, '.seshmux', 'handoff-brief.md'))).toBe(true);
    expect(existsSync(join(repo, '.seshmux', 'handoff-brief.md'))).toBe(false);
  });

  it('review writes review.md in the session cwd but the scratchpad seed in the PARENT repo', async () => {
    const wt = join(repo, '.claude', 'worktrees', 'agent-a');
    mkdirSync(wt, { recursive: true });
    const { f } = makeApp({ resolveSessionCwd: async () => wt });
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/review', headers: { origin },
      payload: { projectId: 'demo', sessionId: 's1' },
    });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(wt, '.seshmux', 'review.md'))).toBe(true);
    // one scratchpad per repo — the UI/watcher only read the parent's handoff.md
    expect(existsSync(join(wt, '.seshmux', 'handoff.md'))).toBe(false);
    const sp = readFileSync(join(repo, '.seshmux', 'handoff.md'), 'utf8');
    expect(sp).toContain('Review requested');
  });

  it('falls back to the repo when the session cwd no longer exists (worktree removed)', async () => {
    const gone = join(repo, '.claude', 'worktrees', 'gone');
    const { f, calls } = makeApp({ resolveSessionCwd: async () => gone });
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/handoff', headers: { origin },
      payload: { projectId: 'demo', sessionId: 's1' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0].projectPath).toBe(repo);
  });

  it('wait resolves a live PTY whose cwd is a worktree of the project repo', async () => {
    const wt = join(repo, '.claude', 'worktrees', 'agent-a');
    const { f } = makeApp({
      listLivePtys: async () => [{ ptyId: 'pty-wt', cwd: wt }],
      waitForStatus: async (ptyId) => ({ status: 'idle' as const }),
    });
    const res = await f.inject({
      method: 'POST', url: '/api/bridge/wait', headers: { origin },
      payload: { projectId: 'demo', status: 'idle' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('idle');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runBridgedCall,
  guardBridgeCall,
  handleWait,
  handleReadTerminal,
  nextHop,
  HOP_ENV,
  BridgeLoopError,
  defaultRunAgent,
  defaultBridgeLog,
  bridgeConfigDir,
  type BridgeDeps,
} from '../../server/lib/bridge/mcp';

// Fake agent runner: echoes a canned answer, records how it was called. No real claude/codex.
function fakeRunner(answer = 'ANSWER') {
  const calls: { bin: string; prompt: string; cwd: string; hop: number }[] = [];
  const run: BridgeDeps['runAgent'] = async ({ bin, prompt, cwd, hop }) => {
    calls.push({ bin, prompt, cwd, hop });
    return { text: answer, ok: true };
  };
  return { run, calls };
}

// Auto-approve/deny approval gate for tests (no UI).
const approveAll: BridgeDeps['requestApproval'] = async () => true;
const denyAll: BridgeDeps['requestApproval'] = async () => false;
const noopLog: BridgeDeps['log'] = async () => {};

describe('hop counting', () => {
  it('starts at 0 when unset, increments per hop', () => {
    expect(nextHop(undefined)).toBe(1);
    expect(nextHop('0')).toBe(1);
    expect(nextHop('3')).toBe(4);
  });
});

describe('runBridgedCall — happy path', () => {
  it('runs the target agent and returns its text, threading an incremented hop', async () => {
    const { run, calls } = fakeRunner('codex says hi');
    const out = await runBridgedCall(
      { target: 'codex', question: 'hi', cwd: '/tmp/x', hopEnv: undefined },
      { runAgent: run, requestApproval: approveAll, log: noopLog, budget: 10 },
    );
    expect(out.text).toBe('codex says hi');
    expect(calls).toHaveLength(1);
    expect(calls[0].hop).toBe(1); // first hop
    expect(calls[0].prompt).toContain('hi');
  });
});

describe('hop budget / no-loop guard', () => {
  it('refuses a call whose incoming hop is already at/over budget', async () => {
    const { run, calls } = fakeRunner();
    await expect(
      runBridgedCall(
        { target: 'claude', question: 'q', cwd: '/tmp', hopEnv: '10' },
        { runAgent: run, requestApproval: approveAll, log: noopLog, budget: 10 },
      ),
    ).rejects.toBeInstanceOf(BridgeLoopError);
    expect(calls).toHaveLength(0); // never spawned
  });

  it('allows a call one below budget', async () => {
    const { run, calls } = fakeRunner();
    await runBridgedCall(
      { target: 'claude', question: 'q', cwd: '/tmp', hopEnv: '8' },
      { runAgent: run, requestApproval: approveAll, log: noopLog, budget: 10 },
    );
    expect(calls[0].hop).toBe(9);
  });
});

describe('approval gate', () => {
  it('denied approval → no spawn, throws', async () => {
    const { run, calls } = fakeRunner();
    await expect(
      runBridgedCall(
        { target: 'codex', question: 'q', cwd: '/tmp', hopEnv: undefined },
        { runAgent: run, requestApproval: denyAll, log: noopLog, budget: 10 },
      ),
    ).rejects.toThrow(/denied|approval/i);
    expect(calls).toHaveLength(0);
  });

  it('approval disabled (approvalMode:false) skips the gate', async () => {
    const { run, calls } = fakeRunner();
    const out = await runBridgedCall(
      { target: 'codex', question: 'q', cwd: '/tmp', hopEnv: undefined },
      { runAgent: run, requestApproval: denyAll, log: noopLog, budget: 10, approvalMode: false },
    );
    expect(out.text).toBe('ANSWER');
    expect(calls).toHaveLength(1); // ran despite denyAll, because gate disabled
  });
});

describe('logging', () => {
  it('logs every exchange (question + answer)', async () => {
    const { run } = fakeRunner('logged answer');
    const logged: unknown[] = [];
    await runBridgedCall(
      { target: 'codex', question: 'log me', cwd: '/tmp', hopEnv: undefined },
      { runAgent: run, requestApproval: approveAll, log: async (e) => void logged.push(e), budget: 10 },
    );
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0])).toContain('log me');
  });
});

describe('HOP_ENV constant', () => {
  it('is the documented env var name', () => {
    expect(HOP_ENV).toBe('SESHMUX_HOP');
  });
});

describe('defaultBridgeLog honors SESHMUX_CONFIG_DIR', () => {
  const prev = process.env.SESHMUX_CONFIG_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.SESHMUX_CONFIG_DIR;
    else process.env.SESHMUX_CONFIG_DIR = prev;
  });

  it('writes bridge-log.jsonl under the config dir override (same dir as approval.sock)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blog-'));
    process.env.SESHMUX_CONFIG_DIR = dir;
    try {
      expect(bridgeConfigDir()).toBe(dir); // shared helper resolves the override
      await defaultBridgeLog({ ts: 0, target: 'codex', question: 'q', answer: 'a', hop: 1, ok: true });
      const logPath = join(dir, 'bridge-log.jsonl');
      expect(existsSync(logPath)).toBe(true);
      expect(readFileSync(logPath, 'utf8')).toContain('"question":"q"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('defaultRunAgent argument-injection guard', () => {
  it('refuses a prompt starting with "-" (no flag smuggling), never spawning', async () => {
    const out = await defaultRunAgent({ bin: 'codex', prompt: '--dangerously-bypass-approvals-and-sandbox', cwd: '/tmp', hop: 1 });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/may not start with/);
  });

  it('refuses a cwd starting with "-"', async () => {
    const out = await defaultRunAgent({ bin: 'claude', prompt: 'ok', cwd: '--evil', hop: 1 });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/may not start with/);
  });
});

// Spec 5 task 3/4 — guardBridgeCall is the shared preamble EVERY bridge verb
// (ask_*, wait_for_status, read_terminal) routes through: loop guard -> approval.
describe('guardBridgeCall (shared preamble for wait/peek, same guard as ask_*)', () => {
  it('trips the loop guard for a non-ask target exactly like ask_*', async () => {
    await expect(
      guardBridgeCall(
        { target: 'wait_for_status', question: 'q', cwd: '/tmp', hopEnv: '10' },
        { requestApproval: approveAll, budget: 10 },
      ),
    ).rejects.toBeInstanceOf(BridgeLoopError);
  });

  it('denies on a denied approval for a non-ask target', async () => {
    await expect(
      guardBridgeCall(
        { target: 'read_terminal', question: 'q', cwd: '/tmp', hopEnv: undefined },
        { requestApproval: denyAll, budget: 10 },
      ),
    ).rejects.toThrow(/denied|approval/i);
  });
});

describe('handleWait (wait_for_status MCP tool)', () => {
  function baseDeps(over: Partial<BridgeDeps> = {}): BridgeDeps {
    return {
      runAgent: fakeRunner().run,
      requestApproval: approveAll,
      log: noopLog,
      budget: 10,
      waitForStatus: async () => ({ status: 'waiting' }),
      ...over,
    };
  }

  it('happy path: calls the injected waitForStatus and returns its result as data', async () => {
    const calls: any[] = [];
    const deps = baseDeps({
      waitForStatus: async (req) => {
        calls.push(req);
        return { status: 'waiting' };
      },
    });
    const result = await handleWait('demo-project', 'waiting', 'latest', 30, deps);
    expect(JSON.parse(result.content[0].text)).toEqual({ status: 'waiting' });
    expect(calls[0]).toEqual({ project: 'demo-project', session: 'latest', status: 'waiting', timeoutSec: 30 });
  });

  it('a real timeout from waitForStatus comes back as {status:"timeout"} data, not isError', async () => {
    const deps = baseDeps({ waitForStatus: async () => ({ status: 'timeout' }) });
    const result = await handleWait('demo-project', 'idle', undefined, 1, deps);
    expect(JSON.parse(result.content[0].text)).toEqual({ status: 'timeout' });
    expect((result as any).isError).toBeUndefined();
  });

  it('a loop-guard trip is DISTINCT from a real timeout: comes back as isError, never masked as {status:"timeout"}', async () => {
    // hopEnv is read from process.env[HOP_ENV] inside handleWait — set it to
    // simulate an incoming call already at budget.
    const prevHop = process.env[HOP_ENV];
    process.env[HOP_ENV] = '10';
    try {
      const waitForStatusCalls: any[] = [];
      const deps = baseDeps({
        budget: 10,
        waitForStatus: async (req) => {
          waitForStatusCalls.push(req);
          return { status: 'waiting' }; // would prove the trip didn't gate if reached
        },
      });
      const result = await handleWait('demo-project', 'waiting', undefined, 30, deps);
      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toMatch(/hop budget exceeded/i);
      expect(waitForStatusCalls).toHaveLength(0); // never reached the actual wait
    } finally {
      if (prevHop === undefined) delete process.env[HOP_ENV];
      else process.env[HOP_ENV] = prevHop;
    }
  });

  it('an approval denial is also isError, not a masked timeout', async () => {
    const deps = baseDeps({ requestApproval: denyAll, waitForStatus: async () => ({ status: 'waiting' }) });
    const result = await handleWait('demo-project', 'waiting', undefined, 30, deps);
    expect((result as any).isError).toBe(true);
    expect(result.content[0].text).toMatch(/denied|approval/i);
  });
});

describe('handleReadTerminal (read_terminal MCP tool)', () => {
  function baseDeps(over: Partial<BridgeDeps> = {}): BridgeDeps {
    return {
      runAgent: fakeRunner().run,
      requestApproval: approveAll,
      log: noopLog,
      budget: 10,
      resolveLivePty: async () => ({ ptyId: 'pty-other', cwd: '/repo/other' }),
      peekTerminal: async (ptyId, lines) => ({ ptyId, lines: ['line one', 'line two'] }),
      ...over,
    };
  }

  it('happy path: resolves a live pty and returns its stripped lines', async () => {
    const deps = baseDeps();
    const result = await handleReadTerminal('other-project', 80, deps);
    expect(result.content[0].text).toBe('line one\nline two');
    expect((result as any).isError).toBeUndefined();
  });

  it('refuses to peek the caller\'s OWN session (resolved cwd === process.cwd())', async () => {
    const deps = baseDeps({ resolveLivePty: async () => ({ ptyId: 'pty-self', cwd: process.cwd() }) });
    const result = await handleReadTerminal('own-project', 80, deps);
    expect((result as any).isError).toBe(true);
    expect(result.content[0].text).toMatch(/own session/i);
  });

  it('404-shapes as isError when no live session is found', async () => {
    const deps = baseDeps({ resolveLivePty: async () => null });
    const result = await handleReadTerminal('gone-project', 80, deps);
    expect((result as any).isError).toBe(true);
    expect(result.content[0].text).toMatch(/no live session/i);
  });

  it('trips the loop guard before ever calling peekTerminal', async () => {
    const prevHop = process.env[HOP_ENV];
    process.env[HOP_ENV] = '10';
    try {
      const peekCalls: any[] = [];
      const deps = baseDeps({
        budget: 10,
        peekTerminal: async (ptyId, lines) => {
          peekCalls.push({ ptyId, lines });
          return { ptyId, lines: [] };
        },
      });
      const result = await handleReadTerminal('other-project', 80, deps);
      expect((result as any).isError).toBe(true);
      expect(result.content[0].text).toMatch(/hop budget exceeded/i);
      expect(peekCalls).toHaveLength(0);
    } finally {
      if (prevHop === undefined) delete process.env[HOP_ENV];
      else process.env[HOP_ENV] = prevHop;
    }
  });
});

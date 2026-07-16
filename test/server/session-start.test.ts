// Hermetic unit test for the firstPrompt argv-vs-delayed-write branch in
// server/session-start.ts (no real daemon dial). Mocks daemon-client + the provider
// registry + detectEnv so we can assert argv shape and whether the delayed write fires.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// argv[0] may be resolved to an absolute, platform-native path (tmux shell-PATH proofing;
// see resolveBin() in server/session-start.ts) — e.g. C:\Users\Blake\.local\bin\claude.exe
// on win32, /usr/local/bin/claude on posix. Strip dir + runnable extension to compare
// against the bare provider-command name on both platforms.
function binName(p: string): string {
  return path.basename(p).replace(/\.(exe|cmd|bat|com)$/i, '');
}

const spawnCalls: { cwd?: string; args: string[] }[] = [];
const writeCalls: { ptyId: string; data: string }[] = [];

vi.mock('../../server/daemon-client', () => {
  const conn = {
    spawn: vi.fn(async (params: { cwd?: string; args: string[] }) => {
      spawnCalls.push(params);
      return { ptyId: 'pty-1' };
    }),
    write: vi.fn(async (ptyId: string, data: string) => {
      writeCalls.push({ ptyId, data });
    }),
    list: vi.fn(async () => ({ ptys: [] })),
    close: vi.fn(),
  };
  return { dial: vi.fn(async () => conn) };
});

vi.mock('../../server/lib/detect', () => ({
  detectEnv: vi.fn(async () => ({
    claude: { found: true },
    codex: { found: false },
    tmux: { found: false },
    rg: { found: false },
  })),
}));

function makeProvider(withFreshPrompt: boolean) {
  return {
    id: 'claude' as const,
    commands: {
      fresh: (cwd: string) => ['claude'],
      continue: (cwd: string) => ['claude', '--continue'],
      resume: (cwd: string, id: string) => ['claude', `--resume=${id}`],
      headlessPlan: (cwd: string, task: string) => ['claude', '-p', '--permission-mode', 'plan', '--', task],
      headlessAsk: (cwd: string, prompt: string) => ['claude', '-p', '--', prompt],
      ...(withFreshPrompt
        ? { freshPrompt: (cwd: string, prompt: string) => ['claude', '--', prompt] }
        : {}),
    },
  };
}

vi.mock('../../server/lib/providers/types', () => ({
  getProviders: vi.fn(),
}));

describe('startSession firstPrompt seeding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnCalls.length = 0;
    writeCalls.length = 0;
  });

  // win32 deliberately disables argv-seeding of firstPrompt for EVERY provider, even one
  // that implements freshPrompt: the agent CLI resolves through a .cmd shim there, so argv
  // flows through cmd.exe, whose %VAR% expansion can't be safely escaped against arbitrary
  // user text (see server/session-start.ts's seedViaArgv). It falls through to the same
  // delayed-write path providers without freshPrompt use. This is intended product
  // behavior, not something to "fix" here — assert the platform-appropriate seam instead.
  it('seeds a fresh session via argv when the provider supports freshPrompt — no delayed write (posix); win32 always falls back to the delayed write', async () => {
    const { getProviders } = await import('../../server/lib/providers/types');
    (getProviders as ReturnType<typeof vi.fn>).mockResolvedValue([makeProvider(true)]);
    const { startSession } = await import('../../server/session-start');

    await startSession({
      projectPath: '/tmp/repo',
      provider: 'claude',
      mode: 'new',
      firstPrompt: 'build the team',
    });

    expect(spawnCalls).toHaveLength(1);
    expect(binName(spawnCalls[0].args[0])).toBe('claude');

    if (process.platform === 'win32') {
      expect(spawnCalls[0].args.slice(1)).toEqual([]); // plain fresh() argv, prompt NOT injected
      expect(writeCalls).toHaveLength(0); // not yet — still waiting out the settle delay
      await vi.advanceTimersByTimeAsync(3000);
      expect(writeCalls).toHaveLength(1);
      expect(writeCalls[0].data).toBe('build the team\n'); // seeded intact via the fallback write
    } else {
      expect(spawnCalls[0].args.slice(1)).toEqual(['--', 'build the team']);
      await vi.advanceTimersByTimeAsync(5000);
      expect(writeCalls).toHaveLength(0); // never falls back — the prompt already landed in argv
    }
  });

  it('multi-line prompt survives intact and unmangled (never shell-interpolated) — via argv on posix, via delayed write on win32', async () => {
    const { getProviders } = await import('../../server/lib/providers/types');
    (getProviders as ReturnType<typeof vi.fn>).mockResolvedValue([makeProvider(true)]);
    const { startSession } = await import('../../server/session-start');

    const prompt = 'line one\nline two\n$(rm -rf /) `evil`';
    await startSession({ projectPath: '/tmp/repo', provider: 'claude', mode: 'new', firstPrompt: prompt });

    if (process.platform === 'win32') {
      expect(spawnCalls[0].args).toHaveLength(1); // no argv-seeding — prompt never touches argv/cmd.exe
      await vi.advanceTimersByTimeAsync(3000);
      expect(writeCalls).toHaveLength(1);
      expect(writeCalls[0].data).toBe(prompt + '\n'); // untouched — written to the PTY, no shell involved
    } else {
      expect(spawnCalls[0].args).toHaveLength(3);
      expect(spawnCalls[0].args[2]).toBe(prompt); // untouched — one argv element, no shell escaping/splitting
    }
  });

  it('falls back to the delayed write when the provider has no freshPrompt', async () => {
    const { getProviders } = await import('../../server/lib/providers/types');
    (getProviders as ReturnType<typeof vi.fn>).mockResolvedValue([makeProvider(false)]);
    const { startSession } = await import('../../server/session-start');

    await startSession({ projectPath: '/tmp/repo', provider: 'claude', mode: 'new', firstPrompt: 'hi' });

    expect(binName(spawnCalls[0].args[0])).toBe('claude'); // plain fresh() argv, no prompt injected
    expect(writeCalls).toHaveLength(0); // not yet — still waiting out the settle delay

    await vi.advanceTimersByTimeAsync(3000);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].data).toBe('hi\n');
  });

  it('resolves argv[0] to an absolute path when the binary is on PATH; passes through when not', async () => {
    const { getProviders } = await import('../../server/lib/providers/types');
    const { startSession } = await import('../../server/session-start');

    // `node` is guaranteed on the test process PATH — must resolve absolute.
    (getProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'claude', commands: { ...makeProvider(false).commands, fresh: () => ['node'] } },
    ]);
    await startSession({ projectPath: '/tmp/repo', provider: 'claude', mode: 'new' });
    expect(path.isAbsolute(spawnCalls[0].args[0])).toBe(true);
    expect(binName(spawnCalls[0].args[0])).toBe('node');

    // Unresolvable name must pass through unchanged (which fails, spawn still attempted).
    spawnCalls.length = 0;
    (getProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'claude', commands: { ...makeProvider(false).commands, fresh: () => ['seshmux-no-such-bin-xyz'] } },
    ]);
    await startSession({ projectPath: '/tmp/repo', provider: 'claude', mode: 'new' });
    expect(spawnCalls[0].args).toEqual(['seshmux-no-such-bin-xyz']);
  });

  it('falls back to the delayed write on resume, even when freshPrompt is supported', async () => {
    const { getProviders } = await import('../../server/lib/providers/types');
    (getProviders as ReturnType<typeof vi.fn>).mockResolvedValue([makeProvider(true)]);
    const { startSession } = await import('../../server/session-start');

    await startSession({
      projectPath: '/tmp/repo',
      provider: 'claude',
      mode: 'new',
      resumeId: 'sess-123',
      firstPrompt: 'hi',
    });

    // resume path, not freshPrompt
    expect(binName(spawnCalls[0].args[0])).toBe('claude');
    expect(spawnCalls[0].args.slice(1)).toEqual(['--resume=sess-123']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(writeCalls).toHaveLength(1); // seeded via the fallback write instead
  });
});

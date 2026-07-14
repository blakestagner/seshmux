// Hermetic unit test for the firstPrompt argv-vs-delayed-write branch in
// server/session-start.ts (no real daemon dial). Mocks daemon-client + the provider
// registry + detectEnv so we can assert argv shape and whether the delayed write fires.
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

  it('seeds a fresh session via argv when the provider supports freshPrompt — no delayed write', async () => {
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
    // argv[0] may be resolved to an absolute path (tmux shell-PATH proofing)
    expect(spawnCalls[0].args[0].split('/').pop()).toBe('claude');
    expect(spawnCalls[0].args.slice(1)).toEqual(['--', 'build the team']);

    await vi.advanceTimersByTimeAsync(5000);
    expect(writeCalls).toHaveLength(0); // never falls back — the prompt already landed in argv
  });

  it('multi-line prompt survives intact as a single argv element (never shell-interpolated)', async () => {
    const { getProviders } = await import('../../server/lib/providers/types');
    (getProviders as ReturnType<typeof vi.fn>).mockResolvedValue([makeProvider(true)]);
    const { startSession } = await import('../../server/session-start');

    const prompt = 'line one\nline two\n$(rm -rf /) `evil`';
    await startSession({ projectPath: '/tmp/repo', provider: 'claude', mode: 'new', firstPrompt: prompt });

    expect(spawnCalls[0].args).toHaveLength(3);
    expect(spawnCalls[0].args[2]).toBe(prompt); // untouched — one argv element, no shell escaping/splitting
  });

  it('falls back to the delayed write when the provider has no freshPrompt', async () => {
    const { getProviders } = await import('../../server/lib/providers/types');
    (getProviders as ReturnType<typeof vi.fn>).mockResolvedValue([makeProvider(false)]);
    const { startSession } = await import('../../server/session-start');

    await startSession({ projectPath: '/tmp/repo', provider: 'claude', mode: 'new', firstPrompt: 'hi' });

    expect(spawnCalls[0].args[0].split('/').pop()).toBe('claude'); // plain fresh() argv, no prompt injected
    expect(writeCalls).toHaveLength(0); // not yet — still waiting out the settle delay

    await vi.advanceTimersByTimeAsync(3000);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].data).toBe('hi\n');
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
    expect(spawnCalls[0].args[0].split('/').pop()).toBe('claude');
    expect(spawnCalls[0].args.slice(1)).toEqual(['--resume=sess-123']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(writeCalls).toHaveLength(1); // seeded via the fallback write instead
  });
});

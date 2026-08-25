import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// The readers own their own I/O (keychain + network for Claude, the rollout store for
// Codex) and are unit-tested separately. What this file pins is the route's contract:
// who appears, in what order, and that nothing here can 500 the top bar.
const readClaude = vi.fn();
const readCodex = vi.fn();
const providerIds = vi.fn();

vi.mock('../../server/lib/providers/claude-limits', () => ({
  readClaudeRateLimits: () => readClaude(),
}));
vi.mock('../../server/lib/providers/codex-limits', () => ({
  readCodexRateLimits: () => readCodex(),
}));
vi.mock('../../server/lib/providers/types', () => ({
  getProviders: async () => providerIds().map((id: string) => ({ id })),
}));

async function get() {
  const usageRoutes = (await import('../../server/routes/usage')).default;
  const f = Fastify();
  await f.register(usageRoutes);
  const res = await f.inject({ method: 'GET', url: '/api/usage/limits' });
  return { status: res.statusCode, body: res.json() };
}

const CLAUDE = { meters: [{ windowMinutes: 300, pct: 25, resetsAt: null }] };
const CODEX = {
  meters: [{ windowMinutes: 10_080, pct: 8, resetsAt: null }],
  capturedAt: '2026-08-21T11:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  providerIds.mockReturnValue(['claude', 'codex']);
  readClaude.mockResolvedValue(CLAUDE);
  readCodex.mockResolvedValue(CODEX);
});

describe('GET /api/usage/limits', () => {
  it('returns Claude first and Codex after it — the render order is the array order', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.providers.map((p: { provider: string }) => p.provider)).toEqual(['claude', 'codex']);
    expect(body.providers[1].capturedAt).toBe(CODEX.capturedAt); // snapshot age travels with it
    expect(body.providers[0]).not.toHaveProperty('capturedAt'); // Claude is a live reading
  });

  it('never reads the Codex store when Codex is not detected on this machine', async () => {
    providerIds.mockReturnValue(['claude']);
    const { body } = await get();
    expect(readCodex).not.toHaveBeenCalled();
    expect(body.providers.map((p: { provider: string }) => p.provider)).toEqual(['claude']);
  });

  it('omits a provider with nothing current to report rather than sending an empty row', async () => {
    readClaude.mockResolvedValue(null);
    readCodex.mockResolvedValue({ meters: [], capturedAt: 'x' }); // every window expired
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.providers).toEqual([]);
  });

  it('degrades to 200 when a reader throws — this is chrome, it must not error', async () => {
    readClaude.mockRejectedValue(new Error('keychain locked'));
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.providers.map((p: { provider: string }) => p.provider)).toEqual(['codex']);
  });
});

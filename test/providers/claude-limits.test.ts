import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readClaudeRateLimits,
  resetRateLimitCache,
  tokenFromBlob,
} from '../../server/lib/providers/claude-limits';

// A credentials.json in <home>/.claude makes readAccessToken resolve from the file and
// never touch the macOS keychain, so these run identically on every platform.
async function fakeHome(token: string | null): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'shmx-lim-'));
  if (token !== null) {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: token } }),
    );
  }
  return home;
}

const OK_BODY = {
  five_hour: { utilization: 62.4, resets_at: '2026-08-21T16:20:00Z' },
  seven_day: { utilization: 31, resets_at: '2026-08-25T00:00:00Z' },
  seven_day_opus: { utilization: 18, resets_at: '2026-08-25T00:00:00Z' },
};

function stubFetch(res: { ok: boolean; json?: () => Promise<unknown> }) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(res as unknown as Response);
}

const homes: string[] = [];
async function home(token: string | null) {
  const h = await fakeHome(token);
  homes.push(h);
  return h;
}

beforeEach(() => resetRateLimitCache());
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

describe('readClaudeRateLimits', () => {
  it('maps the upstream buckets and clamps utilization', async () => {
    stubFetch({ ok: true, json: async () => ({ ...OK_BODY, five_hour: { utilization: 140, resets_at: 'x' } }) });
    const r = await readClaudeRateLimits({ homeDir: await home('tok') });
    // Shortest window first, and the named upstream buckets mapped to window minutes.
    expect(r?.meters).toEqual([
      { windowMinutes: 300, pct: 100, resetsAt: 'x' }, // clamped, not 140
      { windowMinutes: 10_080, pct: 31, resetsAt: '2026-08-25T00:00:00Z' },
      { windowMinutes: 10_080, pct: 18, resetsAt: '2026-08-25T00:00:00Z', scope: 'opus' },
    ]);
  });

  it('tolerates a missing bucket and a missing resets_at', async () => {
    stubFetch({ ok: true, json: async () => ({ five_hour: { utilization: 5 } }) });
    const r = await readClaudeRateLimits({ homeDir: await home('tok') });
    expect(r?.meters).toEqual([{ windowMinutes: 300, pct: 5, resetsAt: null }]);
  });

  // No end-to-end "missing credential" case: on macOS an absent file legitimately falls
  // through to the real login keychain, which on a developer's machine DOES hold a token.
  // The decision that matters is blob parsing, tested directly below.
  it('extracts the OAuth token only from a well-formed blob', () => {
    expect(tokenFromBlob(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-tok' } }))).toBe('sk-tok');
    expect(tokenFromBlob(JSON.stringify({ claudeAiOauth: { accessToken: '' } }))).toBeNull();
    expect(tokenFromBlob(JSON.stringify({ claudeAiOauth: {} }))).toBeNull();
    expect(tokenFromBlob(JSON.stringify({ primaryApiKey: 'sk-ant-...' }))).toBeNull(); // API-key auth, not a subscription
    expect(tokenFromBlob('not json')).toBeNull();
    expect(tokenFromBlob('')).toBeNull();
  });

  it('returns null on a non-ok response and on an unrecognised 200 body', async () => {
    stubFetch({ ok: false });
    expect(await readClaudeRateLimits({ homeDir: await home('tok') })).toBeNull();

    resetRateLimitCache();
    stubFetch({ ok: true, json: async () => ({ something_else: 1 }) });
    expect(await readClaudeRateLimits({ homeDir: await home('tok') })).toBeNull();
  });

  it('memoises inside the TTL and refetches once it lapses', async () => {
    const f = stubFetch({ ok: true, json: async () => OK_BODY });
    const h = await home('tok');
    const t0 = 1_000_000;
    await readClaudeRateLimits({ homeDir: h, now: t0 });
    await readClaudeRateLimits({ homeDir: h, now: t0 + 59_000 });
    expect(f).toHaveBeenCalledTimes(1);
    await readClaudeRateLimits({ homeDir: h, now: t0 + 61_000 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent cold-cache reads into one upstream call', async () => {
    const f = stubFetch({ ok: true, json: async () => OK_BODY });
    const h = await home('tok');
    const [a, b, c] = await Promise.all([
      readClaudeRateLimits({ homeDir: h, now: 3_000_000 }),
      readClaudeRateLimits({ homeDir: h, now: 3_000_000 }),
      readClaudeRateLimits({ homeDir: h, now: 3_000_000 }),
    ]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('does not serve one home a cached result belonging to another', async () => {
    stubFetch({ ok: true, json: async () => OK_BODY });
    const t0 = 4_000_000;
    const first = await readClaudeRateLimits({ homeDir: await home('tok-a'), now: t0 });
    expect(first?.meters[0].pct).toBe(62.4);

    // Same instant, well inside the TTL — a homeDir-blind cache would return the above.
    vi.restoreAllMocks();
    stubFetch({ ok: true, json: async () => ({ five_hour: { utilization: 7, resets_at: null } }) });
    const second = await readClaudeRateLimits({ homeDir: await home('tok-b'), now: t0 });
    expect(second?.meters[0].pct).toBe(7);
  });

  it('backs off harder after a failure than after a success', async () => {
    const f = stubFetch({ ok: false });
    const h = await home('tok');
    const t0 = 2_000_000;
    await readClaudeRateLimits({ homeDir: h, now: t0 });
    // Past the 60s success TTL but inside the 5min failure TTL — still no second call.
    await readClaudeRateLimits({ homeDir: h, now: t0 + 120_000 });
    expect(f).toHaveBeenCalledTimes(1);
    await readClaudeRateLimits({ homeDir: h, now: t0 + 301_000 });
    expect(f).toHaveBeenCalledTimes(2);
  });
});

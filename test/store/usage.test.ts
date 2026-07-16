import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, utimesSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateUsage } from '../../server/lib/store/usage';

// Isolated root: a fresh temp dir containing only the myrepo project, copied from the
// shared fixtures. Using the shared fixtures/ dir directly would pull in the sibling
// -Users-demo-github-other and codex-sessions fixtures (mtime=now, no utimesSync),
// polluting sessions/byProject counts. Copy, don't symlink — scanProjects skips
// symlinked dirs (dirent.isDirectory() is false for them).
// fileURLToPath, not .pathname — see test/store/scan.test.ts for why the raw pathname
// doubles the drive letter on Windows.
const fixturesRoot = fileURLToPath(new URL('../fixtures', import.meta.url));
const srcProjDir = join(fixturesRoot, '-Users-demo-github-myrepo');

let root: string;
let projDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'seshmux-usage-'));
  projDir = join(root, '-Users-demo-github-myrepo');
  mkdirSync(projDir);
  for (const f of ['aaaa-1111.jsonl', 'bbbb-2222.jsonl']) {
    copyFileSync(join(srcProjDir, f), join(projDir, f));
  }
  // Deterministic mtimes: both "now" so a 30-day window includes them.
  const now = new Date();
  utimesSync(join(projDir, 'aaaa-1111.jsonl'), now, now);
  utimesSync(join(projDir, 'bbbb-2222.jsonl'), now, now);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// Expected totals hand-computed from the fixtures (definition: totalTokens =
// output_tokens + input_tokens + cache_creation_input_tokens; cacheReads = cache_read_input_tokens, tracked separately):
//
// aaaa-1111 (3 assistant lines):
//   a1: in=100  cc=200  cr=300    out=50   -> tokens 350,  cacheReads 300
//   a2: in=120  cc=220  cr=320    out=40   -> tokens 380,  cacheReads 320
//   a3: in=5000 cc=3235 cr=180000 out=300  -> tokens 8535, cacheReads 180000
//   subtotal: tokens 9265, cacheReads 180620
// bbbb-2222 (1 assistant line):
//   b1: in=10 cc=20 cr=30 out=5 -> tokens 35, cacheReads 30
//
// totals: totalTokens = 9265 + 35 = 9300, cacheReads = 180620 + 30 = 180650
const EXPECTED_TOTAL_TOKENS = 9300;
const EXPECTED_CACHE_READS = 180650;

describe('aggregateUsage', () => {
  it('aggregates sessions, tokens, cacheReads, and splits within the window', async () => {
    const result = await aggregateUsage(30, root, 'claude');
    expect(result.sessions).toBe(2);
    expect(result.totalTokens).toBe(EXPECTED_TOTAL_TOKENS);
    expect(result.cacheReads).toBe(EXPECTED_CACHE_READS);
    // Fixtures are all model "claude-opus-4-8" -> opus family rate ($5 in / $6.25 cache
    // write / $0.50 cache read / $25 out per million). Hand-computed from the three
    // aaaa-1111 lines + the one bbbb-2222 line (see breakdown above).
    expect(result.estCostUsd).toBeCloseTo(0.14931875, 8);
    expect(result.byProject).toEqual([{ name: 'myrepo', pct: 100 }]);
    expect(result.byProvider).toEqual([{ provider: 'claude', pct: 100 }]);
  });

  it('excludes files outside the mtime window (0-day window yields nothing)', async () => {
    const result = await aggregateUsage(0, root, 'claude');
    expect(result.sessions).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.cacheReads).toBe(0);
    expect(result.estCostUsd).toBe(0);
    expect(result.byProject).toEqual([]);
    expect(result.byProvider).toEqual([]);
  });

  it('counts only turns within the window, not the whole file, for a recently-touched old session (S4-1)', async () => {
    // A file with a recent mtime (resumed today) but whose turns span old + new. A 3-day
    // window must exclude the weeks-old turns and count ONLY the fresh one.
    const isoRoot = mkdtempSync(join(tmpdir(), 'seshmux-usage-window-'));
    const isoProj = join(isoRoot, '-Users-demo-github-myrepo');
    mkdirSync(isoProj);
    const mkLine = (iso: string, out: number) =>
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 0, output_tokens: out } },
        timestamp: iso,
      });
    const now = new Date();
    const old1 = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString(); // 20d ago
    const old2 = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10d ago
    const fresh = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const file = join(isoProj, 'resumed.jsonl');
    writeFileSync(file, [mkLine(old1, 111), mkLine(old2, 222), mkLine(fresh, 7)].join('\n') + '\n');
    utimesSync(file, now, now); // mtime = now, so the file passes the coarse mtime gate

    try {
      const result = await aggregateUsage(3, isoRoot, 'claude'); // 3-day window
      expect(result.sessions).toBe(1);
      expect(result.totalTokens).toBe(7); // only the fresh turn, not 111+222+7
    } finally {
      rmSync(isoRoot, { recursive: true, force: true });
    }
  });

  it('does not corrupt a wider window from a narrower cached read (window-independent cache, S4-1)', async () => {
    // Read a 3-day window first (caches the parsed turns), then a 30-day window against the
    // SAME file+mtime — the wider window must still see the old turns, proving the cache
    // holds all turns and the cutoff is applied post-cache, not baked into the cache key.
    const isoRoot = mkdtempSync(join(tmpdir(), 'seshmux-usage-cachekey-'));
    const isoProj = join(isoRoot, '-Users-demo-github-myrepo');
    mkdirSync(isoProj);
    const now = new Date();
    const old = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();
    const line = (iso: string, out: number) =>
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 0, output_tokens: out } },
        timestamp: iso,
      });
    const file = join(isoProj, 's.jsonl');
    writeFileSync(file, [line(old, 500), line(fresh, 5)].join('\n') + '\n');
    utimesSync(file, now, now);
    try {
      const narrow = await aggregateUsage(3, isoRoot, 'claude'); // caches turns
      expect(narrow.totalTokens).toBe(5);
      const wide = await aggregateUsage(30, isoRoot, 'claude'); // same file+mtime, wider window
      expect(wide.totalTokens).toBe(505); // old turn re-included, cache not poisoned
    } finally {
      rmSync(isoRoot, { recursive: true, force: true });
    }
  });

  it('returns all zeros for a nonexistent root without throwing', async () => {
    const result = await aggregateUsage(30, join(root, 'does-not-exist'), 'claude');
    expect(result).toEqual({
      sessions: 0,
      totalTokens: 0,
      cacheReads: 0,
      estCostUsd: 0,
      byProject: [],
      byProvider: [],
    });
  });
});

// Builds an isolated root with a single project dir containing one jsonl file with one
// assistant usage line for the given model, so estCostUsd for that run reflects exactly
// that model's per-bucket rate. input/cacheCreate/cacheRead/output chosen as 1,000,000
// each so the resulting cost equals rate.input + rate.cacheWrite + rate.cacheRead +
// rate.output directly (in USD), easy to hand-check.
function makeUsageRoot(model: string) {
  const root = mkdtempSync(join(tmpdir(), 'seshmux-usage-family-'));
  const projDir = join(root, '-Users-demo-github-priced');
  mkdirSync(projDir);
  const line = JSON.stringify({
    parentUuid: null,
    type: 'assistant',
    message: {
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      },
    },
    uuid: 'p1',
    timestamp: '2026-07-05T00:00:00.000Z',
    cwd: '/Users/demo/github/priced',
    sessionId: 'pppp-0001',
    gitBranch: 'main',
  });
  const filePath = join(projDir, 'pppp-0001.jsonl');
  writeFileSync(filePath, line + '\n');
  const now = new Date();
  utimesSync(filePath, now, now);
  return root;
}

describe('aggregateUsage cost — family pricing', () => {
  it('prices claude-opus-4-8 at the current $5/$25 opus rate, not legacy $15/$75', async () => {
    const root = makeUsageRoot('claude-opus-4-8');
    try {
      const result = await aggregateUsage(30, root, 'claude');
      // opus: input 5 + cacheWrite 6.25 + cacheRead 0.5 + output 25 = 36.75
      expect(result.estCostUsd).toBeCloseTo(36.75, 6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves claude-opus-4-7 (not an exact-match key) to the opus family rate', async () => {
    const root = makeUsageRoot('claude-opus-4-7');
    try {
      const result = await aggregateUsage(30, root, 'claude');
      expect(result.estCostUsd).toBeCloseTo(36.75, 6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a date-suffixed haiku id to the haiku family rate, not the opus fallback', async () => {
    const root = makeUsageRoot('claude-haiku-4-5-20251001');
    try {
      const result = await aggregateUsage(30, root, 'claude');
      // haiku: input 1 + cacheWrite 1.25 + cacheRead 0.1 + output 5 = 7.35
      expect(result.estCostUsd).toBeCloseTo(7.35, 6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves claude-fable-5 to the fable family rate ($10/$50)', async () => {
    const root = makeUsageRoot('claude-fable-5');
    try {
      const result = await aggregateUsage(30, root, 'claude');
      // fable: input 10 + cacheWrite 12.5 + cacheRead 1 + output 50 = 73.5
      expect(result.estCostUsd).toBeCloseTo(73.5, 6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prices cache_read and cache_creation in distinct buckets (0.1x vs 1.25x input), not both at input rate', async () => {
    const root = makeUsageRoot('claude-sonnet-4-6');
    try {
      const result = await aggregateUsage(30, root, 'claude');
      // sonnet: input 3 + cacheWrite 3.75 + cacheRead 0.3 + output 15 = 22.05.
      // If cacheCreate were (wrongly) priced at the input rate instead of cacheWrite,
      // this would be input 3 + 3(mispriced) + 0.3 + 15 = 21.3 — a different number.
      expect(result.estCostUsd).toBeCloseTo(22.05, 6);
      expect(result.estCostUsd).not.toBeCloseTo(21.3, 6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

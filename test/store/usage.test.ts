import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateUsage } from '../../server/lib/store/usage';

// Isolated root: a fresh temp dir containing only the myrepo project, copied from the
// shared fixtures. Using the shared fixtures/ dir directly would pull in the sibling
// -Users-demo-github-other and codex-sessions fixtures (mtime=now, no utimesSync),
// polluting sessions/byProject counts. Copy, don't symlink — scanProjects skips
// symlinked dirs (dirent.isDirectory() is false for them).
const fixturesRoot = new URL('../fixtures', import.meta.url).pathname;
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
    expect(result.estCostUsd).toBeGreaterThan(0);
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

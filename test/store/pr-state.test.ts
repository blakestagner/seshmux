import { describe, it, expect, beforeEach } from 'vitest';
import { filterOpenPrs, _resetPrStateCacheForTest } from '../../server/lib/store/pr-state';
import type { PrRef } from '../../server/lib/store/prs';

const pr = (number: number): PrRef => ({
  url: `https://github.com/o/r/pull/${number}`,
  owner: 'o',
  repo: 'r',
  number,
});

describe('filterOpenPrs', () => {
  beforeEach(() => _resetPrStateCacheForTest());

  it('keeps open PRs and drops closed/merged ones', async () => {
    const openNums = new Set([1, 3]); // 2 is closed/merged
    const kept = await filterOpenPrs([pr(1), pr(2), pr(3)], async (p) => openNums.has(p.number));
    expect(kept.map((p) => p.number)).toEqual([1, 3]);
  });

  it('fails open: keeps a PR whose state cannot be determined', async () => {
    const kept = await filterOpenPrs([pr(5)], async () => true); // ghState resolves true on error
    expect(kept.map((p) => p.number)).toEqual([5]);
  });

  it('caches state so a second call does not refetch', async () => {
    let calls = 0;
    const fetch = async (p: PrRef) => (calls++, p.number === 1);
    await filterOpenPrs([pr(1), pr(2)], fetch);
    const kept = await filterOpenPrs([pr(1), pr(2)], fetch);
    expect(calls).toBe(2); // only the first pass hit the fetcher
    expect(kept.map((p) => p.number)).toEqual([1]);
  });
});

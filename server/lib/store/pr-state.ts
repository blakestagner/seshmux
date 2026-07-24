// Keep only PRs that are still OPEN, via `gh api`. Extraction (store/prs.ts)
// only reads transcript text, so it can't know a PR was later closed/merged —
// and merging a PR never touches the session jsonl, so routes/prs.ts's
// mtime-keyed cache can't see the change either. Hence a SEPARATE short-TTL
// cache keyed by URL, so a merge drops the chip within a minute on the next poll.
//
// Fail-OPEN: if gh can't answer (not installed, unauthed, network, deleted PR),
// keep the PR rather than hide a possibly-open one. So when gh is unavailable
// this degrades to the old "show everything" behavior instead of hiding all.
// ponytail: one `gh api` per PR; the URL cache keeps focus-polls from hammering.

import { execFile } from 'node:child_process';
import type { PrRef } from './prs';

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; open: boolean }>();

export type StateFetcher = (pr: PrRef) => Promise<boolean>;

const ghState: StateFetcher = (pr) =>
  new Promise((resolve) => {
    execFile(
      'gh',
      ['api', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, '--jq', '.state'],
      { timeout: 5000 },
      (err, stdout) => resolve(err ? true : stdout.trim() === 'open'),
    );
  });

export async function filterOpenPrs(prs: PrRef[], fetchState: StateFetcher = ghState): Promise<PrRef[]> {
  const now = Date.now();
  if (cache.size > 500) cache.clear(); // crude bound
  const open = await Promise.all(
    prs.map(async (pr) => {
      const hit = cache.get(pr.url);
      if (hit && now - hit.at < TTL_MS) return hit.open;
      const isOpen = await fetchState(pr);
      cache.set(pr.url, { at: now, open: isOpen });
      return isOpen;
    }),
  );
  return prs.filter((_, i) => open[i]);
}

export function _resetPrStateCacheForTest(): void {
  cache.clear();
}

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { searchStore } from '../../server/lib/store/search';

// fileURLToPath, not .pathname — see test/store/scan.test.ts for why the raw pathname
// doubles the drive letter on Windows.
const root = fileURLToPath(new URL('../fixtures', import.meta.url));

describe('searchStore (JS fallback, rg forced off)', () => {
  it('finds a hit inside a claude session and tags it with project/title/provider', async () => {
    const hits = await searchStore(root, 'claude', 'z-index', { useRg: false });
    const hit = hits.find((h) => h.sessionId === 'aaaa-1111');
    expect(hit).toBeDefined();
    expect(hit!.provider).toBe('claude');
    expect(hit!.project).toBe('myrepo'); // project name, not id
    expect(hit!.title).toBe('fix the nav z-index bug');
    expect(hit!.snippet.toLowerCase()).toContain('z-index');
    expect(typeof hit!.ts).toBe('number');
  });

  it('is case-insensitive and returns no hits for a miss', async () => {
    const hits = await searchStore(root, 'claude', 'Z-INDEX', { useRg: false });
    expect(hits.some((h) => h.sessionId === 'aaaa-1111')).toBe(true);
    const none = await searchStore(root, 'claude', 'zzzznomatchzzzz', { useRg: false });
    expect(none).toHaveLength(0);
  });

  it('respects the per-call hit cap', async () => {
    const hits = await searchStore(root, 'claude', 'a', { useRg: false, limit: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { utimesSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanProjects, listSessions, storeBytes } from '../../server/lib/store/scan';

const root = new URL('../fixtures', import.meta.url).pathname;
const projDir = `${root}/-Users-demo-github-myrepo`;
const opts = { root, provider: 'claude' as const };

// Deterministic mtimes: bbbb (Jul 2) newer than aaaa (Jul 1).
beforeAll(() => {
  utimesSync(`${projDir}/aaaa-1111.jsonl`, new Date('2026-07-01T10:00:15Z'), new Date('2026-07-01T10:00:15Z'));
  utimesSync(`${projDir}/bbbb-2222.jsonl`, new Date('2026-07-02T09:00:03Z'), new Date('2026-07-02T09:00:03Z'));
});

describe('scanProjects', () => {
  it('decodes project dirs into path + name', async () => {
    const ps = await scanProjects(root, 'claude');
    const p = ps.find((x) => x.id === '-Users-demo-github-myrepo');
    expect(p).toBeDefined();
    expect(p).toMatchObject({
      name: 'myrepo',
      path: '/Users/demo/github/myrepo',
      provider: 'claude',
    });
    expect(p!.sessionCount).toBe(2);
  });
});

describe('listSessions', () => {
  it('extracts title from first real user message and branch from last gitBranch', async () => {
    const ss = await listSessions('-Users-demo-github-myrepo', { ...opts, limit: 5 });
    const aaaa = ss.find((s) => s.id === 'aaaa-1111')!;
    expect(aaaa.title).toBe('fix the nav z-index bug');
    expect(aaaa.branch).toBe('fix/nav-zindex');
    expect(aaaa.provider).toBe('claude');
    expect(aaaa.projectId).toBe('-Users-demo-github-myrepo');
    expect(aaaa.startedAt).toBe(Date.parse('2026-07-01T10:00:00.000Z'));
  });

  it('skips command-name entries when picking the title', async () => {
    const ss = await listSessions('-Users-demo-github-myrepo', { ...opts });
    const aaaa = ss.find((s) => s.id === 'aaaa-1111')!;
    expect(aaaa.title).not.toContain('command-name');
  });

  it('paginates by mtime desc with limit', async () => {
    const first = await listSessions('-Users-demo-github-myrepo', { ...opts, limit: 1 });
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe('bbbb-2222'); // newest first
  });

  it('paginates with before cursor', async () => {
    const newest = await listSessions('-Users-demo-github-myrepo', { ...opts, limit: 1 });
    const older = await listSessions('-Users-demo-github-myrepo', {
      ...opts,
      before: newest[0].mtime,
      limit: 5,
    });
    expect(older.map((s) => s.id)).toEqual(['aaaa-1111']);
  });
});

describe('storeBytes', () => {
  it('recursively sums the byte size of every .jsonl under the root', async () => {
    // Independent recursive sum of real fixture file sizes for the assertion.
    const sum = (dir: string): number => {
      let total = 0;
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, d.name);
        if (d.isDirectory()) total += sum(p);
        else if (d.name.endsWith('.jsonl')) total += statSync(p).size;
      }
      return total;
    };
    const expected = sum(root);
    const bytes = await storeBytes(root);
    expect(bytes).toBe(expected);
    expect(bytes).toBeGreaterThan(0);
  });

  it('returns 0 for a missing store root, never throws', async () => {
    expect(await storeBytes('/no/such/store/anywhere')).toBe(0);
  });
});

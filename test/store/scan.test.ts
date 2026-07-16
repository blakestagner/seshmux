import { describe, it, expect, beforeAll } from 'vitest';
import { utimesSync, statSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProjects, listSessions, storeBytes } from '../../server/lib/store/scan';

// fileURLToPath (not new URL(...).pathname) — on Windows a file:// URL's pathname is
// "/C:/Users/..." (leading slash before the drive letter); joining that raw string
// doubles the drive letter into "C:\C:\Users\...". fileURLToPath decodes it correctly
// on every platform.
const root = fileURLToPath(new URL('../fixtures', import.meta.url));
const projDir = join(root, '-Users-demo-github-myrepo');
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

describe('scanProjects — unreadable session file does not break the whole scan (BUG-7)', () => {
  it('skips an unreadable .jsonl and still returns the other readable sessions', async () => {
    const tRoot = mkdtempSync(join(tmpdir(), 'scan-bug7-'));
    const dirName = '-Users-demo-github-unreadable-repo';
    const projDir = join(tRoot, dirName);
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'good-1111.jsonl'),
      '{"type":"user","message":{"role":"user","content":"a real task"},"timestamp":"2026-07-01T10:00:00.000Z","cwd":"/Users/demo/github/unreadable-repo","gitBranch":"main"}\n',
    );
    const badPath = join(projDir, 'bad-2222.jsonl');
    writeFileSync(badPath, '{"type":"user"}\n');
    chmodSync(badPath, 0o000);

    try {
      const projects = await scanProjects(tRoot, 'claude');
      const p = projects.find((x) => x.id === dirName);
      expect(p).toBeDefined();
      expect(p!.sessionCount).toBe(2); // both files counted, unreadable one just degrades

      const sessions = await listSessions(dirName, { root: tRoot, provider: 'claude' });
      expect(sessions).toHaveLength(2);
      const good = sessions.find((s) => s.id === 'good-1111')!;
      expect(good.title).toBe('a real task');
      const bad = sessions.find((s) => s.id === 'bad-2222')!;
      expect(bad.title).toBe(''); // degraded to empty head, not thrown
    } finally {
      chmodSync(badPath, 0o644); // restore so the tmpdir can be cleaned up
    }
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

describe('computeHead — giant first line past the 256KB cap (round-3 regression)', () => {
  it('recovers cwd from the tail so the project path is not the lossy dash-decode', async () => {
    const tRoot = mkdtempSync(join(tmpdir(), 'scan-bighead-'));
    const dirName = '-Users-demo-github-hyphen-repo';
    const projDir = join(tRoot, dirName);
    mkdirSync(projDir, { recursive: true });
    const realCwd = '/Users/demo/github/hyphen-repo';
    // First line: a user event whose pasted content pushes the LINE past 256KB.
    const giant = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'x'.repeat(300 * 1024) },
      timestamp: '2026-07-01T10:00:00.000Z',
      cwd: realCwd,
    });
    const later = JSON.stringify({ type: 'assistant', cwd: realCwd, gitBranch: 'main' });
    writeFileSync(join(projDir, 'big-1111.jsonl'), giant + '\n' + later + '\n');

    const projects = await scanProjects(tRoot, 'claude');
    const p = projects.find((x) => x.id === dirName);
    expect(p).toBeDefined();
    // cwd recovered from tail — NOT the dash-decode '/Users/demo/github/hyphen/repo'.
    expect(p!.path).toBe(realCwd);
  });

  it('a single giant line with no later lines still degrades gracefully (no throw)', async () => {
    const tRoot = mkdtempSync(join(tmpdir(), 'scan-bighead2-'));
    const dirName = '-tmp-solo';
    mkdirSync(join(tRoot, dirName), { recursive: true });
    writeFileSync(
      join(tRoot, dirName, 'solo-1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'y'.repeat(400 * 1024) }, cwd: '/tmp/solo' }),
    );
    const projects = await scanProjects(tRoot, 'claude');
    expect(projects.find((x) => x.id === dirName)).toBeDefined(); // falls back to decode, no crash
  });
});

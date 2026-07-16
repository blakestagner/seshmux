// The store scan is memoized per (provider, root) with a short TTL and
// watcher-driven invalidation (server/events-hub wires the chokidar watcher to
// invalidateScanCache) so a request stops re-crawling the whole store. These
// tests pin the three properties that keep it correct: TTL expiry, explicit
// invalidation, and no cross-provider bleed.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProjects, invalidateScanCache } from '../../server/lib/store/scan';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'seshmux-scancache-'));
  roots.push(root);
  return root;
}

// One claude-shaped project dir with a single session whose jsonl carries the
// real cwd (used for both title and project path, matching scan.ts's readHead).
function writeProject(root: string, cwd: string, sessionId: string): void {
  const dir = join(root, cwd.replace(/\//g, '-'));
  mkdirSync(dir, { recursive: true });
  const line = {
    type: 'user',
    message: { role: 'user', content: `session in ${cwd}` },
    uuid: 'u0',
    timestamp: '2026-07-05T10:00:00.000Z',
    cwd,
    sessionId,
    gitBranch: 'main',
  };
  writeFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify(line) + '\n');
}

afterEach(() => {
  invalidateScanCache(); // clear module-global cache between tests
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('scan cache', () => {
  it('serves a cached scan and re-walks only after explicit invalidation', async () => {
    const root = makeRoot();
    writeProject(root, '/Users/demo/github/one', 's1');

    expect(await scanProjects(root, 'claude')).toHaveLength(1);

    // A second project added without invalidating stays invisible — proving the
    // first scan was cached, not re-walked.
    writeProject(root, '/Users/demo/github/two', 's2');
    expect(await scanProjects(root, 'claude')).toHaveLength(1);

    invalidateScanCache('claude');
    expect(await scanProjects(root, 'claude')).toHaveLength(2);
  });

  it('re-walks after the TTL expires with no explicit invalidation', async () => {
    const root = makeRoot();
    writeProject(root, '/Users/demo/github/ttl-one', 's1');
    expect(await scanProjects(root, 'claude')).toHaveLength(1);

    writeProject(root, '/Users/demo/github/ttl-two', 's2');
    // Jump the clock past the TTL floor (3s) — only Date.now is faked, so real
    // fs I/O in the re-walk is untouched.
    const later = Date.now() + 5000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      expect(await scanProjects(root, 'claude')).toHaveLength(2);
    } finally {
      now.mockRestore();
    }
  });

  it('invalidating one provider leaves another provider cache intact', async () => {
    const root = makeRoot();
    writeProject(root, '/Users/demo/github/x', 's1');
    expect(await scanProjects(root, 'claude')).toHaveLength(1);

    // A codex invalidation must not touch the claude:<root> entry.
    writeProject(root, '/Users/demo/github/y', 's2');
    invalidateScanCache('codex');
    expect(await scanProjects(root, 'claude')).toHaveLength(1);
  });
});

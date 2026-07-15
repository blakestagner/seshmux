import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { CodexProvider, invalidateCodexSummaries } from '../../server/lib/providers/codex';

const root = new URL('../fixtures/codex-sessions', import.meta.url).pathname;

// A project id is the dash-encoded cwd, matching the claude scheme so the same repo
// path merges across providers in Task 7.
const PROJ_ID = '-Users-demo-github-myrepo';
const SESSION_ID = '019aebe9-51ba-7810-959a-6b8c07979e39';

describe('CodexProvider.scanProjects', () => {
  it('groups sessions by cwd into a decoded project', async () => {
    const cx = new CodexProvider(root);
    const ps = await cx.scanProjects();
    const p = ps.find((x) => x.id === PROJ_ID)!;
    expect(p).toBeDefined();
    expect(p).toMatchObject({ name: 'myrepo', path: '/Users/demo/github/myrepo', provider: 'codex' });
    expect(p.sessionCount).toBe(1);
  });
});

describe('CodexProvider.listSessions', () => {
  it('extracts title from first event_msg user_message and branch from git', async () => {
    const cx = new CodexProvider(root);
    const ss = await cx.listSessions(PROJ_ID);
    expect(ss).toHaveLength(1);
    const s = ss[0];
    expect(s.id).toBe(SESSION_ID);
    expect(s.title).toBe('add a codex feature');
    expect(s.branch).toBe('feat/codex');
    expect(s.provider).toBe('codex');
  });
});

describe('CodexProvider.parseTranscript', () => {
  it('parses messages and pairs function_call with output', async () => {
    const cx = new CodexProvider(root);
    const { msgs, ctx } = await cx.parseTranscript(PROJ_ID, SESSION_ID);
    expect(msgs[0]).toMatchObject({ role: 'user', text: 'add a codex feature' });
    const withTool = msgs.find((m) => m.tools.length > 0)!;
    expect(withTool.tools[0].name).toBe('exec_command');
    expect(withTool.tools[0].input).toContain('ls src');
    expect(withTool.tools[0].output).toContain('feature.ts');
    expect(ctx).not.toBeNull();
    expect(ctx!.tokens).toBe(129200);
    expect(ctx!.window).toBe(258400);
    expect(ctx!.pct).toBe(50);
    expect(ctx!.model).toBe('gpt-5.4-mini');
  });
});

describe('CodexProvider.readCtx / commands', () => {
  it('reads ctx and exposes resume commands without a plan mode', async () => {
    const cx = new CodexProvider(root);
    const ctx = await cx.readCtx(PROJ_ID, SESSION_ID);
    expect(ctx).toMatchObject({ tokens: 129200, window: 258400, model: 'gpt-5.4-mini' });

    expect(cx.commands.fresh('/tmp/x')).toEqual(['codex']);
    expect(cx.commands.continue('/tmp/x')).toEqual(['codex', 'resume', '--last']);
    expect(cx.commands.resume('/tmp/x', SESSION_ID)).toEqual(['codex', 'resume', '--', SESSION_ID]);
    expect(cx.commands.plan).toBeUndefined();

    // Flag-proof: a hostile id starting with `-` sits AFTER the `--` separator, so it can
    // never parse as a flag (defense-in-depth atop route-layer validation).
    const evil = cx.commands.resume('/tmp/x', '--dangerously-bypass-approvals-and-sandbox');
    expect(evil[evil.length - 2]).toBe('--');
    expect(evil[evil.length - 1]).toBe('--dangerously-bypass-approvals-and-sandbox');
  });
});

describe('CodexProvider.search (PERF-6 (file,mtime) line cache)', () => {
  // Copy the fixture store to a temp dir so we can prove the (file,mtime) cache serves a
  // second query without re-reading disk: after warming, we truncate the rollout but
  // RESTORE its mtime — a cached read still finds the hit; a live re-read would find none.
  function findRollout(dir: string): string {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const hit = findRollout(p);
        if (hit) return hit;
      } else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        return p;
      }
    }
    return '';
  }

  it('serves a repeat query from cache (no disk re-read) and honours mtime invalidation', async () => {
    const tmp = mkdtempSync(join(os.tmpdir(), 'seshmux-codex-search-'));
    try {
      cpSync(root, tmp, { recursive: true });
      const rollout = findRollout(tmp);
      expect(rollout).not.toBe('');
      const cx = new CodexProvider(tmp);

      // Pin a whole-second mtime BEFORE warming: fs mtimes carry sub-ms precision
      // that a Date round-trip truncates, so restoring the stat()'d mtime sometimes
      // changed the cache key (flake). A whole second survives the round-trip exactly.
      const t0 = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
      utimesSync(rollout, t0, t0);

      const first = await cx.search('feature');
      expect(first.length).toBeGreaterThan(0);
      expect(first[0]).toMatchObject({ provider: 'codex', sessionId: SESSION_ID });
      expect(first[0].snippet.toLowerCase()).toContain('feature');

      // Gut the file but keep its (whole-second, exactly-representable) mtime →
      // cache key unchanged → still a hit from memory.
      writeFileSync(rollout, '');
      utimesSync(rollout, t0, t0);
      const cached = await cx.search('feature');
      expect(cached.length).toBe(first.length);

      // Bump mtime → cache key changes → the now-empty file is re-read → no hit.
      // In production the chokidar watcher fires invalidateCodexSummaries on the
      // change; here we call it directly (the walk memo would otherwise hold the
      // old mtime for its 3s TTL).
      const later = new Date(t0.getTime() + 5_000);
      utimesSync(rollout, later, later);
      invalidateCodexSummaries();
      expect(await cx.search('feature')).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// getProviders() includes codex only when detect() reports found. Reporting found purely
// from store presence was a chicken-and-egg: a user who installs the codex CLI but has never
// run it got NO codex UI at all — including the New-session option that would have created
// the first session. An installed CLI with an empty store is a usable agent.
describe('CodexProvider.detect — installed CLI with an empty store', () => {
  it('reports found when sessions exist, regardless of the CLI', async () => {
    const p = new CodexProvider({ root });
    const d = await p.detect();
    expect(d.found).toBe(true);
    expect(d.store?.projects ?? 0).toBeGreaterThan(0);
  });

  it('still reports found when the store is EMPTY but the codex CLI is installed', async () => {
    const empty = mkdtempSync(join(os.tmpdir(), 'codex-empty-'));
    try {
      const p = new CodexProvider({ root: empty });
      const d = await p.detect();
      expect(d.store?.projects ?? 0).toBe(0);
      // `which codex` decides. On a machine without codex this is correctly false — assert the
      // rule rather than the machine: found must track CLI presence when the store is empty.
      const cliPresent = await new Promise<boolean>((resolve) => {
        import('node:child_process').then(({ execFile }) =>
          execFile('which', ['codex'], (err, stdout) => resolve(!err && !!stdout.trim())),
        );
      });
      expect(d.found).toBe(cliPresent);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

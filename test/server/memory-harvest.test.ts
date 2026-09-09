// memory/harvest: watermarked forward walking of sessions. The property that matters
// throughout is IDEMPOTENCE — a session harvested, appended to, and harvested again must
// yield only the new records, never a duplicate of what was already stored.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProvider, SessionMeta } from '../../server/lib/providers/types';
import { ClaudeProvider } from '../../server/lib/providers/claude';
import {
  createHarvester,
  harvestSession,
  markKey,
  pickBackfill,
  shouldHarvest,
  type HarvestTarget,
  type Watermark,
} from '../../server/lib/memory/harvest';

let dir: string;
let store: string;
let prevConfigDir: string | undefined;

async function freshModules() {
  const s = await import('../../server/lib/memory/store');
  const h = await import('../../server/lib/memory/harvest');
  s._resetMemoryForTest();
  h._resetHarvestForTest();
  return { s, h };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'smx-harv-'));
  store = join(dir, 'claude-store');
  mkdirSync(join(store, '-repo-alpha'), { recursive: true });
  prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
  process.env.SESHMUX_CONFIG_DIR = join(dir, 'config');
  await freshModules();
});

afterEach(async () => {
  await freshModules();
  if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
  else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 8, 9);

// A minimal but REAL claude jsonl — the harvester goes through the provider's own parser,
// so hand-built Msg objects would not exercise the seam under test.
function line(kind: 'user' | 'assistant', body: unknown, ts: string): string {
  return (
    JSON.stringify(
      kind === 'user'
        ? { type: 'user', message: { role: 'user', content: body }, timestamp: ts }
        : { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: body }, timestamp: ts },
    ) + '\n'
  );
}

function writeSession(id: string, lines: string[]): string {
  const file = join(store, '-repo-alpha', `${id}.jsonl`);
  writeFileSync(file, lines.join(''));
  return file;
}

function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    provider: 'claude',
    projectId: '-repo-alpha',
    title: 't',
    branch: 'main',
    mtime: NOW,
    startedAt: NOW,
    durationMs: null,
    live: false,
    cwd: '/repo/alpha',
    ...over,
  };
}

const target = (id: string, over: Partial<SessionMeta> = {}): HarvestTarget => ({
  provider: 'claude',
  projectId: '-repo-alpha',
  repo: '/repo/alpha',
  session: meta(id, over),
});

const provider = () => new ClaudeProvider({ root: store }) as AgentProvider;
const noThrottle = { throttleMs: 0, quietMs: 0 };

// ---------------------------------------------------------------------------

describe('shouldHarvest (pure)', () => {
  const m = (over: Partial<Watermark> = {}): Watermark => ({ offset: 100, at: NOW, mtime: NOW, ...over });

  it('harvests a session it has never seen', () => {
    expect(shouldHarvest(undefined, meta('s'), NOW)).toBeNull();
  });

  it('never re-reads a session already read to completion', () => {
    expect(shouldHarvest(m({ complete: true }), meta('s'), NOW)).toBe('complete');
  });

  it('waits out a live session that is still mid-turn', () => {
    // Harvesting a half-written turn costs a full re-read and remembers nothing useful.
    const live = meta('s', { live: true, mtime: NOW - 1000 });
    expect(shouldHarvest(undefined, live, NOW)).toBe('still-writing');
  });

  it('harvests a live session once it has gone quiet', () => {
    const settled = meta('s', { live: true, mtime: NOW - 60_000 });
    expect(shouldHarvest(undefined, settled, NOW)).toBeNull();
  });

  it('throttles a session harvested moments ago', () => {
    expect(shouldHarvest(m({ at: NOW - 1000 }), meta('s', { mtime: NOW + 1 }), NOW)).toBe('throttled');
  });

  it('skips a session that has not been written to since the last look', () => {
    expect(shouldHarvest(m({ at: NOW - 999_999, mtime: NOW }), meta('s', { mtime: NOW }), NOW)).toBe('unchanged');
  });

  it('harvests again once the session grows', () => {
    expect(shouldHarvest(m({ at: NOW - 999_999, mtime: NOW }), meta('s', { mtime: NOW + 1 }), NOW)).toBeNull();
  });
});

describe('pickBackfill (pure)', () => {
  it('takes the newest sessions first and honours the limit', () => {
    const targets = [target('a', { mtime: 1 }), target('b', { mtime: 3 }), target('c', { mtime: 2 })];
    expect(pickBackfill(targets, {}, 2).map((t) => t.session.id)).toEqual(['b', 'c']);
  });

  it('skips sessions already fully harvested, so a restart is cheap', () => {
    const targets = [target('a', { mtime: 2 }), target('b', { mtime: 1 })];
    const marks = { [markKey('claude', 'a')]: { offset: 9, at: 0, mtime: 2, complete: true } };
    expect(pickBackfill(targets, marks).map((t) => t.session.id)).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------

describe('harvestSession', () => {
  it('extracts records from a real session file', async () => {
    const { s } = await freshModules();
    writeSession('s1', [
      line('user', 'fix the nav bug', '2026-09-01T10:00:00.000Z'),
      line('assistant', [{ type: 'text', text: 'Looking now.' }], '2026-09-01T10:00:01.000Z'),
      line('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'nav.css' } }], '2026-09-01T10:00:02.000Z'),
    ]);
    const res = await harvestSession(target('s1'), provider(), { providers: async () => [], schedule: noThrottle });
    expect(res.harvested).toBeGreaterThan(0);

    const records = await s.readAllRecords();
    expect(records.map((r) => r.kind).sort()).toEqual(['outcome', 'prompt', 'tool-call']);
    expect(records.every((r) => r.scope.repo === '/repo/alpha')).toBe(true);
    expect(records.every((r) => r.origin.sessionId === 's1')).toBe(true);
  });

  it('records a watermark so the next run knows where it stopped', async () => {
    const { h } = await freshModules();
    writeSession('s1', [line('user', 'hello', '2026-09-01T10:00:00.000Z')]);
    await harvestSession(target('s1'), provider(), { providers: async () => [], schedule: noThrottle });

    const marks = await (await import('../../server/lib/json-store')).createJsonStore<any>(h.watermarksPath(), () => ({
      v: 1,
      marks: {},
    })).read();
    expect(marks.marks[markKey('claude', 's1')].offset).toBeGreaterThan(0);
  });

  it('appends nothing the second time when nothing changed', async () => {
    const { s } = await freshModules();
    writeSession('s1', [line('user', 'hello', '2026-09-01T10:00:00.000Z')]);
    const first = await harvestSession(target('s1'), provider(), { providers: async () => [], schedule: noThrottle });
    const before = (await s.readAllRecords()).length;

    const second = await harvestSession(target('s1'), provider(), { providers: async () => [], schedule: noThrottle });
    expect(first.harvested).toBeGreaterThan(0);
    expect(second.harvested).toBe(0);
    expect(await s.readAllRecords()).toHaveLength(before);
  });

  it('picks up ONLY the new part when the session grows', async () => {
    // The core idempotence property: resumption must not re-deliver old records.
    const { s } = await freshModules();
    const file = writeSession('s1', [line('user', 'first question', '2026-09-01T10:00:00.000Z')]);
    await harvestSession(target('s1'), provider(), { providers: async () => [], schedule: noThrottle });
    const afterFirst = (await s.readAllRecords()).map((r) => r.id).sort();

    appendFileSync(file, line('user', 'second question', '2026-09-01T10:05:00.000Z'));
    await harvestSession(target('s1', { mtime: NOW + 1000, live: true }), provider(), {
      providers: async () => [],
      schedule: noThrottle,
    });

    const afterSecond = await s.readAllRecords();
    const texts = afterSecond.filter((r) => r.kind === 'prompt').map((r) => r.text).sort();
    expect(texts).toEqual(['first question', 'second question']);
    // Everything from the first pass survived exactly once.
    for (const id of afterFirst) {
      expect(afterSecond.filter((r) => r.id === id)).toHaveLength(1);
    }
  });

  it('completes a session larger than one slice across the same call', async () => {
    const { s } = await freshModules();
    const lines = Array.from({ length: 40 }, (_, i) =>
      line('user', `question number ${i} padded out with extra words`, `2026-09-01T10:${String(i).padStart(2, '0')}:00.000Z`),
    );
    writeSession('big', lines);

    // Work is bounded PER CALL (maxSlicesPerCall), so a big session is absorbed over
    // several ticks. What matters is that it converges and never double-writes.
    let calls = 0;
    for (; calls < 20; calls++) {
      const res = await harvestSession(target('big', { mtime: NOW + calls }), provider(), {
        providers: async () => [],
        schedule: noThrottle,
        maxBytes: 200, // force many slices
      });
      if (res.skipped === 'complete') break;
    }
    expect(calls).toBeGreaterThan(1); // genuinely took multiple bounded passes

    const records = await s.readAllRecords();
    const prompts = records.filter((r) => r.kind === 'prompt');
    expect(prompts.length).toBe(40); // every prompt in the file, none lost, none doubled
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length); // no duplicates
  });

  it('caps how much one session may contribute, across slices', async () => {
    // extract.ts's caps are per SLICE (it is stateless across them), so the genuine
    // per-session bound has to live in the harvester, which can see the stored total.
    const { s } = await freshModules();
    const lines = Array.from({ length: 60 }, (_, i) =>
      line('user', `question number ${i} padded out with extra words`, `2026-09-01T10:${String(i % 60).padStart(2, '0')}:00.000Z`),
    );
    writeSession('greedy', lines);

    for (let i = 0; i < 20; i++) {
      const res = await harvestSession(target('greedy', { mtime: NOW + i }), provider(), {
        providers: async () => [],
        schedule: noThrottle,
        maxBytes: 200,
        maxPerSession: 10,
      });
      if (res.skipped === 'complete') break;
    }
    expect((await s.readAllRecords()).length).toBe(10);
  });

  it('marks a finished session complete but a live one not', async () => {
    const { h } = await freshModules();
    const readMarks = async () =>
      (
        await (await import('../../server/lib/json-store'))
          .createJsonStore<any>(h.watermarksPath(), () => ({ v: 1, marks: {} }))
          .read()
      ).marks;

    writeSession('done', [line('user', 'a question here', '2026-09-01T10:00:00.000Z')]);
    await harvestSession(target('done'), provider(), { providers: async () => [], schedule: noThrottle });
    expect((await readMarks())[markKey('claude', 'done')].complete).toBe(true);

    writeSession('live', [line('user', 'another question', '2026-09-01T10:00:00.000Z')]);
    await harvestSession(target('live', { live: true, mtime: NOW - 999_999 }), provider(), {
      providers: async () => [],
      schedule: noThrottle,
    });
    expect((await readMarks())[markKey('claude', 'live')].complete).toBe(false);
  });

  it('emits an outcome for a finished session but not for a live one', async () => {
    const { s } = await freshModules();
    const body = [
      line('user', 'do it', '2026-09-01T10:00:00.000Z'),
      line('assistant', [{ type: 'text', text: 'All finished.' }], '2026-09-01T10:00:01.000Z'),
    ];
    writeSession('live', body);
    await harvestSession(target('live', { live: true, mtime: NOW - 999_999 }), provider(), {
      providers: async () => [],
      schedule: noThrottle,
    });
    expect((await s.readAllRecords()).some((r) => r.kind === 'outcome')).toBe(false);
  });

  it('returns the skip reason instead of working when throttled', async () => {
    writeSession('s1', [line('user', 'hello there', '2026-09-01T10:00:00.000Z')]);
    await harvestSession(target('s1'), provider(), { providers: async () => [], schedule: noThrottle });
    const again = await harvestSession(target('s1'), provider(), { providers: async () => [] });
    expect(again.skipped).toBe('complete');
  });

  it('re-harvests a session that was completed and then resumed', async () => {
    // A finished session can be picked up again with --resume hours later. Treating
    // "complete" as permanent would lose the whole continuation.
    const { s } = await freshModules();
    const file = writeSession('s1', [line('user', 'first question', '2026-09-01T10:00:00.000Z')]);
    await harvestSession(target('s1'), provider(), { providers: async () => [], schedule: noThrottle });

    appendFileSync(file, line('user', 'resumed question', '2026-09-01T12:00:00.000Z'));
    const again = await harvestSession(target('s1', { mtime: NOW + 5000 }), provider(), {
      providers: async () => [],
      schedule: noThrottle,
    });
    expect(again.skipped).toBeNull();
    expect(
      (await s.readAllRecords()).filter((r) => r.kind === 'prompt').map((r) => r.text).sort(),
    ).toEqual(['first question', 'resumed question']);
  });

  it('does not mark a session complete while its last line is unterminated', async () => {
    // A file that never got its trailing newline used to be marked done with its final turn
    // unread — and since the mtime never moves again, never revisited. That turn is the one
    // the `outcome` record comes from.
    const { s, h } = await freshModules();
    const file = join(store, '-repo-alpha', 'partial.jsonl');
    writeFileSync(file, line('user', 'a complete question', '2026-09-01T10:00:00.000Z') + '{"type":"user","mess');

    await harvestSession(target('partial'), provider(), { providers: async () => [], schedule: noThrottle });

    const marks = await (await import('../../server/lib/json-store'))
      .createJsonStore<any>(h.watermarksPath(), () => ({ v: 1, marks: {} }))
      .read();
    expect(marks.marks[markKey('claude', 'partial')].complete).toBe(false);
    expect((await s.readAllRecords()).some((r) => r.kind === 'prompt')).toBe(true);
  });

  it('advances the throttle clock on failure, so a broken session is not retried hot', async () => {
    // Returning early on error left mark.at unset, so the throttle never tripped and every
    // session-touch re-read the whole store plus megabytes of transcript, for ever.
    const { h } = await freshModules();
    const broken = {
      id: 'claude',
      harvestFrom: async () => {
        throw new Error('disk on fire');
      },
    } as unknown as AgentProvider;

    await harvestSession(target('s1'), broken, {
      providers: async () => [],
      schedule: noThrottle,
      log: () => {},
      now: () => NOW,
    });

    const marks = await (await import('../../server/lib/json-store'))
      .createJsonStore<any>(h.watermarksPath(), () => ({ v: 1, marks: {} }))
      .read();
    expect(marks.marks[markKey('claude', 's1')].at).toBe(NOW);

    // With a real throttle the next attempt is now suppressed rather than hammering.
    const again = await harvestSession(target('s1'), broken, { providers: async () => [], now: () => NOW + 1000 });
    expect(again.skipped).toBe('throttled');
  });

  it('swallows a provider failure rather than disturbing the caller', async () => {
    const broken = {
      id: 'claude',
      harvestFrom: async () => {
        throw new Error('disk on fire');
      },
    } as unknown as AgentProvider;
    const logged: string[] = [];
    const res = await harvestSession(target('s1'), broken, {
      providers: async () => [],
      schedule: noThrottle,
      log: (m) => logged.push(m),
    });
    expect(res.harvested).toBe(0);
    expect(logged[0]).toContain('harvest failed');
  });

  it('is a no-op for a provider without the harvest seam', async () => {
    const noSeam = { id: 'claude' } as unknown as AgentProvider;
    expect(await harvestSession(target('s1'), noSeam, { providers: async () => [] })).toEqual({
      harvested: 0,
      slices: 0,
      skipped: null,
    });
  });
});

// ---------------------------------------------------------------------------

describe('createHarvester', () => {
  it('backfills the sessions on disk', async () => {
    const { s } = await freshModules();
    writeSession('a', [line('user', 'question alpha', '2026-09-01T10:00:00.000Z')]);
    writeSession('b', [line('user', 'question beta', '2026-09-01T11:00:00.000Z')]);

    const harvester = createHarvester({ providers: async () => [provider()], schedule: noThrottle });
    const count = await harvester.backfill();
    expect(count).toBeGreaterThan(0);

    const prompts = (await s.readAllRecords()).filter((r) => r.kind === 'prompt').map((r) => r.text).sort();
    expect(prompts).toEqual(['question alpha', 'question beta']);
  });

  it('does not re-harvest on a second backfill', async () => {
    const { s } = await freshModules();
    writeSession('a', [line('user', 'question alpha', '2026-09-01T10:00:00.000Z')]);
    const harvester = createHarvester({ providers: async () => [provider()], schedule: noThrottle });
    await harvester.backfill();
    const n = (await s.readAllRecords()).length;
    expect(await harvester.backfill()).toBe(0);
    expect(await s.readAllRecords()).toHaveLength(n);
  });

  it('coalesces a burst of touches into a single harvest', async () => {
    // The watch fan-out fires on every jsonl write; without debouncing this would re-read
    // the session continuously through an active turn.
    const { s } = await freshModules();
    writeSession('a', [line('user', 'question alpha', '2026-09-01T10:00:00.000Z')]);

    let harvests = 0;
    const counting = new Proxy(provider(), {
      get(t, p, r) {
        if (p === 'harvestFrom') {
          return async (...args: unknown[]) => {
            harvests++;
            return (t as any).harvestFrom(...args);
          };
        }
        return Reflect.get(t, p, r);
      },
    }) as AgentProvider;

    const harvester = createHarvester({
      providers: async () => [counting],
      schedule: { throttleMs: 0, quietMs: 1 },
    });
    for (let i = 0; i < 25; i++) harvester.onSessionTouched('claude', '-repo-alpha', 'a');

    await new Promise((r) => setTimeout(r, 40));
    await harvester.drain();
    harvester.stop();

    // One settled harvest, not 25 — the file is small so it completes in a couple of slices.
    expect(harvests).toBeLessThanOrEqual(2);
    expect((await s.readAllRecords()).length).toBeGreaterThan(0);
  });

  it('ignores a touch for a session that does not exist', async () => {
    const harvester = createHarvester({
      providers: async () => [provider()],
      schedule: { throttleMs: 0, quietMs: 1 },
    });
    harvester.onSessionTouched('claude', '-repo-alpha', 'ghost');
    await new Promise((r) => setTimeout(r, 20));
    await expect(harvester.drain()).resolves.toBeUndefined();
    harvester.stop();
  });

  it('drops queued work once stopped', async () => {
    const { s } = await freshModules();
    writeSession('a', [line('user', 'question alpha', '2026-09-01T10:00:00.000Z')]);
    const harvester = createHarvester({
      providers: async () => [provider()],
      schedule: { throttleMs: 0, quietMs: 5 },
    });
    harvester.onSessionTouched('claude', '-repo-alpha', 'a');
    harvester.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(await s.readAllRecords()).toEqual([]);
  });
});

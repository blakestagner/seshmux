// memory/store: append-only NDJSON shards + the replayed mutation overlay. Each case runs
// against a fresh tmp SESHMUX_CONFIG_DIR with the read cache reset, so the real on-disk
// append/replay/compaction mechanics are exercised rather than mocked.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryKind, MemoryRecord } from '../../server/lib/memory/types';
import { DEFAULT_MEMORY_SETTINGS, MEMORY_SCHEMA } from '../../server/lib/memory/types';

let dir: string;
let prevConfigDir: string | undefined;

async function fresh() {
  const mod = await import('../../server/lib/memory/store');
  mod._resetMemoryForTest();
  return mod;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'smx-mem-'));
  prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
  process.env.SESHMUX_CONFIG_DIR = dir;
  (await import('../../server/lib/memory/store'))._resetMemoryForTest();
});

afterEach(async () => {
  (await import('../../server/lib/memory/store'))._resetMemoryForTest();
  if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
  else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 9);

function rec(id: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    v: MEMORY_SCHEMA,
    id,
    kind: (extra.kind ?? 'tool-call') as MemoryKind,
    text: extra.text ?? `body of ${id}`,
    scope: extra.scope ?? { projectId: 'p1', repo: '/repo/a', branch: 'main' },
    origin: extra.origin ?? { provider: 'claude', sessionId: 's1', ts: NOW },
    entities: extra.entities ?? { files: [], commands: [], symbols: [] },
    validFrom: extra.validFrom ?? NOW,
    hits: extra.hits ?? 0,
    lastHit: extra.lastHit ?? 0,
    ...extra,
  } as MemoryRecord;
}

describe('memory store — append + read', () => {
  it('reads back nothing before anything is written', async () => {
    const s = await fresh();
    expect(await s.readAllRecords()).toEqual([]);
  });

  it('round-trips appended records', async () => {
    const s = await fresh();
    await s.appendRecords([rec('a'), rec('b')]);
    const got = await s.readAllRecords();
    expect(got.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('collapses a re-appended id rather than duplicating it', async () => {
    // This is the property that lets harvest re-read a growing session safely.
    const s = await fresh();
    await s.appendRecords([rec('a', { text: 'first' })]);
    await s.appendRecords([rec('a', { text: 'second' })]);
    const got = await s.readAllRecords();
    expect(got).toHaveLength(1);
    expect(got[0].text).toBe('second'); // later line wins
  });

  it('dedups within a single batch', async () => {
    const s = await fresh();
    const written = await s.appendRecords([rec('a'), rec('a'), rec('b')]);
    expect(written.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('shards by the origin month, not by write time', async () => {
    const s = await fresh();
    await s.appendRecords([
      rec('jan', { origin: { provider: 'claude', sessionId: 's', ts: Date.UTC(2026, 0, 5) } }),
      rec('sep', { origin: { provider: 'claude', sessionId: 's', ts: Date.UTC(2026, 8, 5) } }),
    ]);
    expect(readFileSync(join(dir, 'memory', 'records', '2026-01.ndjson'), 'utf8')).toContain('jan');
    expect(readFileSync(join(dir, 'memory', 'records', '2026-09.ndjson'), 'utf8')).toContain('sep');
  });

  it('survives a torn last line instead of losing the file', async () => {
    const s = await fresh();
    await s.appendRecords([rec('a'), rec('b')]);
    // Simulate a crash mid-append.
    appendFileSync(join(dir, 'memory', 'records', s.shardName(NOW)), '{"v":1,"id":"c","ki');
    s._resetMemoryForTest();
    const got = await s.readAllRecords();
    expect(got.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('ignores records written under a different schema version', async () => {
    const s = await fresh();
    await s.appendRecords([rec('a')]);
    appendFileSync(
      join(dir, 'memory', 'records', s.shardName(NOW)),
      JSON.stringify({ ...rec('future'), v: 99 }) + '\n',
    );
    s._resetMemoryForTest();
    expect((await s.readAllRecords()).map((r) => r.id)).toEqual(['a']);
  });

  it('re-reads after an out-of-process append (the mcp-bridge case)', async () => {
    // The cache signature must notice a write this process did not make.
    const s = await fresh();
    await s.appendRecords([rec('a')]);
    expect(await s.readAllRecords()).toHaveLength(1);
    appendFileSync(join(dir, 'memory', 'records', s.shardName(NOW)), JSON.stringify(rec('b')) + '\n');
    expect((await s.readAllRecords()).map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});

describe('memory store — overlay replay', () => {
  it('hides a deleted record', async () => {
    const s = await fresh();
    await s.appendRecords([rec('a'), rec('b')]);
    await s.appendOverlay([{ op: 'delete', id: 'a', at: NOW }]);
    expect((await s.readAllRecords()).map((r) => r.id)).toEqual(['b']);
  });

  it('keeps a deleted record visible to includeRemoved (compaction needs it)', async () => {
    const s = await fresh();
    await s.appendRecords([rec('a')]);
    await s.appendOverlay([{ op: 'delete', id: 'a', at: NOW }]);
    expect(await s.readAllRecords({ includeRemoved: true })).toHaveLength(1);
  });

  it('marks a superseded record without removing it', async () => {
    // Zep-style validity window: the old belief stays citable, it is just not current.
    const s = await fresh();
    await s.appendRecords([rec('old'), rec('new')]);
    await s.appendOverlay([{ op: 'supersede', id: 'old', at: NOW, by: 'new' }]);
    const got = await s.readAllRecords();
    expect(got).toHaveLength(2);
    expect(got.find((r) => r.id === 'old')!.supersededBy).toBe('new');
  });

  it('resolves pin/unpin by file order, not by op precedence', async () => {
    const s = await fresh();
    await s.appendRecords([rec('a')]);
    await s.appendOverlay([{ op: 'pin', id: 'a', at: 1 }]);
    await s.appendOverlay([{ op: 'unpin', id: 'a', at: 2 }]);
    await s.appendOverlay([{ op: 'pin', id: 'a', at: 3 }]);
    expect((await s.readAllRecords())[0].pinned).toBe(true);
  });

  it('accumulates hits and takes the newest lastHit', async () => {
    const s = await fresh();
    await s.appendRecords([rec('a')]);
    await s.appendOverlay([
      { op: 'hit', id: 'a', at: 100 },
      { op: 'hit', id: 'a', at: 300 },
      { op: 'hit', id: 'a', at: 200 },
    ]);
    const got = (await s.readAllRecords())[0];
    expect(got.hits).toBe(3);
    expect(got.lastHit).toBe(300);
  });

  it('sanitizes text supplied by an edit op', async () => {
    const s = await fresh();
    await s.appendRecords([rec('a')]);
    await s.appendOverlay([{ op: 'edit', id: 'a', at: NOW, text: `bad${String.fromCharCode(27)}[2Jtext` }]);
    expect((await s.readAllRecords())[0].text).toBe('bad[2Jtext');
  });

  it('ignores overlay ops for ids that do not exist', async () => {
    const s = await fresh();
    await s.appendRecords([rec('a')]);
    await s.appendOverlay([{ op: 'delete', id: 'ghost', at: NOW }]);
    expect(await s.readAllRecords()).toHaveLength(1);
  });
});

describe('memory store — sanitizeText', () => {
  it('strips C0/C1 controls but keeps tab and newline', async () => {
    const s = await fresh();
    const esc = String.fromCharCode(27);
    const bell = String.fromCharCode(7);
    expect(s.sanitizeText(`a${esc}b${bell}c\td\ne`)).toBe('abc\td\ne');
  });

  it('collapses CRLF to LF by dropping the CR', async () => {
    const s = await fresh();
    expect(s.sanitizeText(`a${String.fromCharCode(13)}\nb`)).toBe('a\nb');
  });

  it('clamps to the max length with an ellipsis', async () => {
    const s = await fresh();
    const out = s.sanitizeText('x'.repeat(100), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('memory store — contentId', () => {
  it('is stable for identical content', async () => {
    const s = await fresh();
    const a = s.contentId({ kind: 'error', text: 'boom', scope: 's1' });
    const b = s.contentId({ kind: 'error', text: 'boom', scope: 's1' });
    expect(a).toBe(b);
  });

  it('separates the same observation made in two different scopes', async () => {
    const s = await fresh();
    const a = s.contentId({ kind: 'lesson', text: 'same', scope: 's1' });
    const b = s.contentId({ kind: 'lesson', text: 'same', scope: 's2' });
    expect(a).not.toBe(b);
  });
});

describe('memory store — retention (planCompaction, pure)', () => {
  const settings = { ...DEFAULT_MEMORY_SETTINGS, retentionDays: 30, maxRecords: 3 };

  it('expires an old deterministic record', async () => {
    const s = await fresh();
    const old = rec('old', { origin: { provider: 'claude', sessionId: 's', ts: NOW - 60 * DAY } });
    const { drop } = s.planCompaction([old], settings, NOW);
    expect([...drop]).toEqual(['old']);
  });

  it('never expires a distilled record, however old', async () => {
    const s = await fresh();
    const lesson = rec('l', { kind: 'lesson', origin: { provider: 'claude', sessionId: 's', ts: NOW - 900 * DAY } });
    expect(s.planCompaction([lesson], settings, NOW).drop.size).toBe(0);
  });

  it('never expires a pinned record, however old', async () => {
    const s = await fresh();
    const pinned = rec('p', { pinned: true, origin: { provider: 'claude', sessionId: 's', ts: NOW - 900 * DAY } });
    expect(s.planCompaction([pinned], settings, NOW).drop.size).toBe(0);
  });

  it('keeps an old record that is still being recalled', async () => {
    const s = await fresh();
    const used = rec('u', {
      origin: { provider: 'claude', sessionId: 's', ts: NOW - 60 * DAY },
      lastHit: NOW - 2 * DAY,
    });
    expect(s.planCompaction([used], settings, NOW).drop.size).toBe(0);
  });

  it('enforces the record cap by evicting the least valuable first', async () => {
    const s = await fresh();
    const records = [
      rec('err', { kind: 'error', origin: { provider: 'claude', sessionId: 's', ts: NOW } }),
      rec('out', { kind: 'outcome', origin: { provider: 'claude', sessionId: 's', ts: NOW } }),
      rec('tool', { kind: 'tool-call', origin: { provider: 'claude', sessionId: 's', ts: NOW } }),
      rec('oldtool', { kind: 'tool-call', origin: { provider: 'claude', sessionId: 's', ts: NOW - 10 * DAY } }),
    ];
    const { drop, keep } = s.planCompaction(records, settings, NOW);
    expect(keep).toHaveLength(3);
    expect([...drop]).toEqual(['oldtool']); // oldest + lowest kind weight
  });
});

describe('memory store — compact()', () => {
  it('rewrites shards, folds the overlay in, and removes it', async () => {
    const s = await fresh();
    await s.appendRecords([rec('a'), rec('b')]);
    await s.appendOverlay([{ op: 'pin', id: 'a', at: NOW }]);

    const res = await s.compact(DEFAULT_MEMORY_SETTINGS, NOW);
    expect(res.kept).toBe(2);

    // The overlay is gone, but its effect survives in the rewritten record.
    expect(() => readFileSync(s.overlayPath(), 'utf8')).toThrow();
    s._resetMemoryForTest();
    expect((await s.readAllRecords()).find((r) => r.id === 'a')!.pinned).toBe(true);
  });

  it('drops a shard whose every record expired', async () => {
    const s = await fresh();
    const stale = rec('stale', { origin: { provider: 'claude', sessionId: 's', ts: Date.UTC(2020, 0, 1) } });
    await s.appendRecords([stale, rec('fresh')]);
    await s.compact({ ...DEFAULT_MEMORY_SETTINGS, retentionDays: 30 }, NOW);
    s._resetMemoryForTest();
    const got = await s.readAllRecords();
    expect(got.map((r) => r.id)).toEqual(['fresh']);
    expect(() => readFileSync(join(dir, 'memory', 'records', '2020-01.ndjson'), 'utf8')).toThrow();
  });

  it('is a no-op on an empty store', async () => {
    const s = await fresh();
    await expect(s.compact(DEFAULT_MEMORY_SETTINGS, NOW)).resolves.toEqual({ dropped: 0, kept: 0 });
  });
});

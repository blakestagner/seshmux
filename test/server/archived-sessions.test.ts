// archived-sessions: the per-session archive set over json-store. Each case runs
// against a fresh tmp SESHMUX_CONFIG_DIR with the memoized store reset, so the
// on-disk persistence is exercised for real (a "server restart" = a store reset).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevConfigDir: string | undefined;

async function fresh() {
  const mod = await import('../../server/lib/archived-sessions');
  mod._resetArchivedStoreForTest();
  return mod;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'smx-archived-'));
  prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
  process.env.SESHMUX_CONFIG_DIR = dir;
  (await import('../../server/lib/archived-sessions'))._resetArchivedStoreForTest();
});

afterEach(async () => {
  (await import('../../server/lib/archived-sessions'))._resetArchivedStoreForTest();
  if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
  else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

const S = { provider: 'claude', sessionId: 'abc-1', projectId: 'proj-a' };

describe('archived-sessions store', () => {
  it('a missing file reads as an empty set', async () => {
    const a = await fresh();
    expect(await a.readArchived()).toEqual({});
    expect(await a.archivedKeys()).toEqual(new Set());
  });

  it('archive then restore round-trips', async () => {
    const a = await fresh();
    await a.setArchived(S, true);
    const m = await a.readArchived();
    expect(Object.keys(m)).toEqual(['claude:abc-1']);
    expect(m['claude:abc-1']).toMatchObject(S);
    expect(typeof m['claude:abc-1'].archivedAt).toBe('number');

    await a.setArchived(S, false);
    expect(await a.readArchived()).toEqual({});
  });

  it('is idempotent both ways and keeps the original archivedAt', async () => {
    const a = await fresh();
    const first = (await a.setArchived(S, true))['claude:abc-1'].archivedAt;
    const again = (await a.setArchived(S, true))['claude:abc-1'].archivedAt;
    expect(again).toBe(first);
    await a.setArchived(S, false);
    await expect(a.setArchived(S, false)).resolves.toEqual({});
  });

  it('keys by provider too — the same id in two stores is two sessions', async () => {
    const a = await fresh();
    await a.setArchived(S, true);
    expect(await a.archivedKeys()).toEqual(new Set(['claude:abc-1']));
    expect((await a.archivedKeys()).has(a.archivedKey('codex', 'abc-1'))).toBe(false);
  });

  it('persists across a restart (fresh store over the same dir)', async () => {
    let a = await fresh();
    await a.setArchived(S, true);
    expect(existsSync(join(dir, 'archived-sessions.json'))).toBe(true);
    a = await fresh();
    expect(await a.archivedKeys()).toEqual(new Set(['claude:abc-1']));
  });

  it('serializes concurrent writes — none are lost', async () => {
    const a = await fresh();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => a.setArchived({ ...S, sessionId: `s-${i}` }, true)),
    );
    expect((await a.archivedKeys()).size).toBe(10);
  });

  it('drops malformed entries instead of handing them to callers', async () => {
    writeFileSync(
      join(dir, 'archived-sessions.json'),
      JSON.stringify({
        'claude:x': null,
        'claude:y': { provider: 'claude', sessionId: 'y' }, // missing fields
        'claude:ok': { provider: 'claude', sessionId: 'ok', projectId: 'p', archivedAt: 1 },
      }),
    );
    const a = await fresh();
    expect(Object.keys(await a.readArchived())).toEqual(['claude:ok']);
  });


  it('a corrupt file is moved aside (not silently overwritten) by the next write', async () => {
    writeFileSync(join(dir, 'archived-sessions.json'), '{"claude:a": {"provider": "claude", tor');
    const a = await fresh();
    expect(await a.readArchived()).toEqual({});
    // A READ never renames (only the serialized write path may) …
    expect(readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toHaveLength(0);
    await a.setArchived(S, true);
    // … the write quarantines first, keeping the original bytes.
    const aside = readdirSync(dir).filter((f) => f.startsWith('archived-sessions.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]), 'utf8')).toContain('tor');
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'archived-sessions.json'), 'utf8')))).toEqual([
      'claude:abc-1',
    ]);
  });

  it('a non-object JSON file is also quarantined', async () => {
    writeFileSync(join(dir, 'archived-sessions.json'), '[1,2,3]');
    const a = await fresh();
    await a.setArchived(S, true);
    expect(readdirSync(dir).some((f) => f.startsWith('archived-sessions.json.corrupt-'))).toBe(true);
  });

  it('a read racing a write never moves the freshly written file aside', async () => {
    writeFileSync(join(dir, 'archived-sessions.json'), 'not json');
    const a = await fresh();
    await Promise.all([a.readArchived(), a.setArchived(S, true), a.readArchived()]);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'archived-sessions.json'), 'utf8')))).toEqual([
      'claude:abc-1',
    ]);
    expect(readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toHaveLength(1);
  });

  it('an unreadable file (read error other than ENOENT) refuses writes instead of overwriting', async () => {
    // A directory at the file's path: readFile fails with EISDIR on every platform.
    mkdirSync(join(dir, 'archived-sessions.json'));
    const a = await fresh();
    expect(await a.readArchived()).toEqual({}); // listing degrades, doesn't crash
    await expect(a.readArchivedStrict()).rejects.toThrow(); // the GET route surfaces this
    await expect(a.setArchived(S, true)).rejects.toThrow();
    expect(existsSync(join(dir, 'archived-sessions.json'))).toBe(true);
  });

  it('a write builds on the STRICT read of the file, not a lenient one', async () => {
    const a = await fresh();
    await a.setArchived(S, true);
    // Another writer's valid content appears on disk; the next write must keep it.
    const onDisk = JSON.parse(readFileSync(join(dir, 'archived-sessions.json'), 'utf8'));
    onDisk['claude:ext'] = { provider: 'claude', sessionId: 'ext', projectId: 'p', archivedAt: 1 };
    writeFileSync(join(dir, 'archived-sessions.json'), JSON.stringify(onDisk));
    await a.setArchived({ ...S, sessionId: 'abc-2' }, true);
    expect(Object.keys(await a.readArchived()).sort()).toEqual(['claude:abc-1', 'claude:abc-2', 'claude:ext']);
  });

  it('concurrent first reads share one load and never clobber a newer write', async () => {
    const a = await fresh();
    await Promise.all([a.readArchived(), a.setArchived(S, true), a.readArchived()]);
    expect(Object.keys(await a.readArchived())).toEqual(['claude:abc-1']);
  });
});

describe('filterArchived', () => {
  const row = (id: string, provider = 'claude') => ({ id, provider });
  const setup = async () => {
    const a = await fresh();
    await a.setArchived({ provider: 'claude', sessionId: 'kept', projectId: 'p' }, true);
    await a.setArchived({ provider: 'claude', sessionId: 'gone', projectId: 'p' }, true);
    await a.setArchived({ provider: 'codex', sessionId: 'cx', projectId: 'p' }, true);
    await a.setArchived({ provider: 'claude', sessionId: 'other', projectId: 'q' }, true);
    return a;
  };
  type Opts = {
    projectId: string;
    listedAt: number;
    completeProviders: string[];
    existingIds: (provider: string) => Promise<Set<string> | null>;
    locate: (provider: string, sessionId: string) => Promise<string | null>;
  };
  // Default: the store holds nothing but 'kept' → every other candidate is gone.
  const opts = (over: Partial<Opts> = {}): Opts => ({
    projectId: 'p',
    listedAt: Date.now() + 60_000,
    completeProviders: ['claude', 'codex'],
    existingIds: async () => new Set(['kept']),
    locate: async () => null,
    ...over,
  });

  it('exclude drops archived sessions; only returns just them', async () => {
    const a = await setup();
    expect((await a.filterArchived([row('kept'), row('live')], 'exclude', opts())).map((s) => s.id)).toEqual(['live']);
    expect((await a.filterArchived([row('kept'), row('live')], 'only', opts())).map((s) => s.id)).toEqual(['kept']);
  });

  it('prunes a record only when the provider CONFIRMS the transcript is gone', async () => {
    const a = await setup();
    const asked: string[] = [];
    await a.filterArchived(
      [row('kept')],
      'only',
      opts({
        existingIds: async (p) => {
          asked.push(p);
          return new Set(['kept']);
        },
      }),
    );
    const keys = await a.archivedKeys();
    expect(keys.has('claude:gone')).toBe(false);
    expect(keys.has('codex:cx')).toBe(false);
    expect(keys.has('claude:other')).toBe(true); // another project's record is never judged
    expect(asked.sort()).toEqual(['claude', 'codex']);
  });

  it('(a) a record whose session re-grouped is RE-HOMED to where it lists now', async () => {
    const a = await setup();
    await a.filterArchived(
      [row('kept')],
      'only',
      opts({ existingIds: async () => new Set(['kept', 'gone', 'cx']), locate: async (_p, id) => (id === 'gone' ? 'w' : null) }),
    );
    const m = await a.readArchived();
    expect(m['claude:gone'].projectId).toBe('w'); // follows the session
    expect(m['codex:cx'].projectId).toBe('p'); // exists but can't be located → left alone
  });

  it('(b) never judges a record archived after the listing started', async () => {
    const a = await setup();
    let called = false;
    await a.filterArchived(
      [row('kept')],
      'only',
      opts({
        listedAt: 0, // every record is newer than this listing
        existingIds: async () => {
          called = true;
          return new Set();
        },
      }),
    );
    expect(called).toBe(false);
    expect((await a.archivedKeys()).has('claude:gone')).toBe(true);
  });

  it('(c) keeps the record when the store walk errors (unreadable dir) — fails closed', async () => {
    const a = await setup();
    await a.filterArchived(
      [row('kept')],
      'only',
      opts({
        existingIds: async () => {
          throw new Error('EACCES');
        },
      }),
    );
    expect((await a.archivedKeys()).has('claude:gone')).toBe(true);
  });

  it('keeps records for a provider that cannot answer (null id set)', async () => {
    const a = await setup();
    await a.filterArchived([row('kept')], 'only', opts({ existingIds: async () => null }));
    expect((await a.archivedKeys()).has('claude:gone')).toBe(true);
  });

  it('never prunes for a provider whose listing failed / was filtered', async () => {
    const a = await setup();
    await a.filterArchived([row('kept')], 'only', opts({ completeProviders: [] }));
    expect((await a.archivedKeys()).has('claude:gone')).toBe(true);
  });

  it('exclude never prunes', async () => {
    const a = await setup();
    await a.filterArchived([row('live')], 'exclude', opts());
    expect((await a.archivedKeys()).has('claude:gone')).toBe(true);
  });

  it('exclude filters by provider+id regardless of project, and never writes', async () => {
    const a = await setup();
    // 'other' was archived under q; it also lists under p (e.g. a case-variant id).
    const out = await a.filterArchived([row('other'), row('live')], 'exclude', opts());
    expect(out.map((s) => s.id)).toEqual(['live']);
    expect((await a.readArchived())['claude:other'].projectId).toBe('q'); // no flip-flop
  });

  it('a record restored + re-archived while the listing ran is not clobbered', async () => {
    const a = await setup();
    const listedAt = Date.now() + 5; // listing "started" now
    await new Promise((r) => setTimeout(r, 10));
    const run = a.filterArchived(
      [row('kept')],
      'only',
      opts({
        listedAt,
        existingIds: async () => {
          // Meanwhile the user restores and re-archives 'gone' (fresh record).
          await a.setArchived({ provider: 'claude', sessionId: 'gone', projectId: 'p' }, false);
          await a.setArchived({ provider: 'claude', sessionId: 'gone', projectId: 'p' }, true);
          return new Set(['kept']);
        },
      }),
    );
    await run;
    expect((await a.archivedKeys()).has('claude:gone')).toBe(true);
  });

  it('only-mode reads strictly: an unreadable archive file throws (route → 500)', async () => {
    mkdirSync(join(dir, 'archived-sessions.json'));
    const a = await fresh();
    await expect(a.filterArchived([row('x')], 'only', opts())).rejects.toThrow();
    expect(await a.filterArchived([row('x')], 'exclude', opts())).toEqual([row('x')]);
  });
});

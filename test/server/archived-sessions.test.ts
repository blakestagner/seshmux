// archived-sessions: the per-session archive set over json-store. Each case runs
// against a fresh tmp SESHMUX_CONFIG_DIR with the memoized store reset, so the
// on-disk persistence is exercised for real (a "server restart" = a store reset).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('a corrupt or non-object file reads as empty and self-heals on write', async () => {
    writeFileSync(join(dir, 'archived-sessions.json'), '[1,2,3]');
    const a = await fresh();
    expect(await a.readArchived()).toEqual({});
    await a.setArchived(S, true);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'archived-sessions.json'), 'utf8')))).toEqual([
      'claude:abc-1',
    ]);
  });
});

describe('filterArchived — pruning records whose transcript is gone', () => {
  const row = (id: string, provider = 'claude') => ({ id, provider });
  const setup = async () => {
    const a = await fresh();
    await a.setArchived({ provider: 'claude', sessionId: 'kept', projectId: 'p' }, true);
    await a.setArchived({ provider: 'claude', sessionId: 'gone', projectId: 'p' }, true);
    await a.setArchived({ provider: 'codex', sessionId: 'cx', projectId: 'p' }, true);
    await a.setArchived({ provider: 'claude', sessionId: 'other', projectId: 'q' }, true);
    return a;
  };

  it('only-mode drops a record its provider listed completely without it', async () => {
    const a = await setup();
    const out = await a.filterArchived([row('kept'), row('live')], 'only', {
      projectId: 'p',
      completeProviders: ['claude', 'codex'],
    });
    expect(out.map((s) => s.id)).toEqual(['kept']);
    const keys = await a.archivedKeys();
    expect(keys.has('claude:gone')).toBe(false);
    // codex listed nothing for this project → nothing proven → its record stays;
    // another project's record is never touched.
    expect(keys).toEqual(new Set(['claude:kept', 'codex:cx', 'claude:other']));
  });

  it('never prunes for a provider that failed / was filtered (not in completeProviders)', async () => {
    const a = await setup();
    await a.filterArchived([row('kept')], 'only', { projectId: 'p', completeProviders: [] });
    expect((await a.archivedKeys()).has('claude:gone')).toBe(true);
  });

  it('exclude-mode never prunes', async () => {
    const a = await setup();
    const out = await a.filterArchived([row('kept'), row('live')], 'exclude', {
      projectId: 'p',
      completeProviders: ['claude'],
    });
    expect(out.map((s) => s.id)).toEqual(['live']);
    expect((await a.archivedKeys()).has('claude:gone')).toBe(true);
  });
});

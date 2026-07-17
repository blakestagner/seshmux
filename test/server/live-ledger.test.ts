// live-ledger: typed ledger API over json-store. Pure bind rule unit-tested
// directly; the effectful surface runs against a tmp SESHMUX_CONFIG_DIR.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addEntry,
  removeByPtyId,
  readEntries,
  updateEntry,
  ledgerPath,
  pickBindTarget,
  bindSessionId,
  _resetLedgerForTest,
  type LedgerEntry,
} from '../../server/lib/live-ledger';

// Identity canon: fold `<repo>/wt/<x>` worktree paths onto `<repo>`, else passthrough.
const canon = (cwd: string) => cwd.replace(/\/wt\/[^/]+$/, '');

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ptyId: 'pty-1',
    tmuxName: null,
    provider: 'claude',
    cwd: '/repo/a',
    startedAt: 1000,
    ...over,
  };
}

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smxl-'));
  prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
  process.env.SESHMUX_CONFIG_DIR = dir;
  _resetLedgerForTest();
});
afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
  else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
  _resetLedgerForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('ledger path', () => {
  it('lives at live-sessions.json under configDir', () => {
    expect(ledgerPath()).toBe(join(dir, 'live-sessions.json'));
  });
});

describe('add / read / remove', () => {
  it('add → read round-trip; remove by ptyId; remove of unknown ptyId is a no-op', async () => {
    await addEntry(entry({ ptyId: 'pty-1' }));
    await addEntry(entry({ ptyId: 'pty-2' }));
    expect((await readEntries()).map((e) => e.ptyId)).toEqual(['pty-1', 'pty-2']);

    await removeByPtyId('pty-1');
    expect((await readEntries()).map((e) => e.ptyId)).toEqual(['pty-2']);

    await removeByPtyId('does-not-exist');
    expect((await readEntries()).map((e) => e.ptyId)).toEqual(['pty-2']);
  });

  it('entries survive when no exit is reported (nothing implicitly expires)', async () => {
    await addEntry(entry({ ptyId: 'pty-1' }));
    // No removal call — the entry must still be there on a fresh read.
    expect((await readEntries()).map((e) => e.ptyId)).toEqual(['pty-1']);
  });
});

describe('updateEntry', () => {
  it('rewrites ptyId/sessionId/tmuxName in place', async () => {
    await addEntry(entry({ ptyId: 'old', tmuxName: null }));
    await updateEntry('old', { ptyId: 'new', sessionId: 'sess-9', tmuxName: 'seshmux-x' });
    const [e] = await readEntries();
    expect(e.ptyId).toBe('new');
    expect(e.sessionId).toBe('sess-9');
    expect(e.tmuxName).toBe('seshmux-x');
  });

  it('unknown ptyId is a no-op', async () => {
    await addEntry(entry({ ptyId: 'pty-1' }));
    await updateEntry('nope', { sessionId: 'x' });
    const [e] = await readEntries();
    expect(e.sessionId).toBeUndefined();
  });
});

describe('pickBindTarget (pure)', () => {
  it('picks newest unbound for cwd+provider; ignores bound and other providers', () => {
    const entries: LedgerEntry[] = [
      entry({ ptyId: 'p1', cwd: '/repo/a', startedAt: 100 }),
      entry({ ptyId: 'p2', cwd: '/repo/a', startedAt: 300 }), // newest unbound → winner
      entry({ ptyId: 'p3', cwd: '/repo/a', startedAt: 400, sessionId: 'bound' }), // bound, ignored
      entry({ ptyId: 'p4', cwd: '/repo/a', startedAt: 500, provider: 'codex' }), // other provider
    ];
    expect(pickBindTarget(entries, 'claude', '/repo/a', canon)?.ptyId).toBe('p2');
  });

  it('folds a worktree cwd onto its parent via injected canon', () => {
    const entries: LedgerEntry[] = [entry({ ptyId: 'p1', cwd: '/repo/a/wt/feat', startedAt: 100 })];
    expect(pickBindTarget(entries, 'claude', '/repo/a', canon)?.ptyId).toBe('p1');
  });

  it('returns null when all matching entries are bound', () => {
    const entries: LedgerEntry[] = [entry({ ptyId: 'p1', cwd: '/repo/a', sessionId: 'x' })];
    expect(pickBindTarget(entries, 'claude', '/repo/a', canon)).toBeNull();
  });

  it('B1 ceiling: two unbound in one repo → newest wins deterministically', () => {
    const entries: LedgerEntry[] = [
      entry({ ptyId: 'older', cwd: '/repo/a', startedAt: 10 }),
      entry({ ptyId: 'newer', cwd: '/repo/a', startedAt: 20 }),
    ];
    expect(pickBindTarget(entries, 'claude', '/repo/a', canon)?.ptyId).toBe('newer');
  });
});

describe('bindSessionId', () => {
  it('binds the newest unbound entry and is idempotent under touch storms', async () => {
    await addEntry(entry({ ptyId: 'p1', cwd: '/repo/a', startedAt: 100 }));
    await addEntry(entry({ ptyId: 'p2', cwd: '/repo/a', startedAt: 200 }));

    expect(await bindSessionId('claude', '/repo/a', 'sess-1', canon)).toBe(true);
    const afterFirst = await readEntries();
    expect(afterFirst.find((e) => e.ptyId === 'p2')?.sessionId).toBe('sess-1');
    expect(afterFirst.find((e) => e.ptyId === 'p1')?.sessionId).toBeUndefined();

    // A session-touch replays the same id: no rebind of a second entry, no change.
    expect(await bindSessionId('claude', '/repo/a', 'sess-1', canon)).toBe(false);
    const afterSecond = await readEntries();
    expect(afterSecond.find((e) => e.ptyId === 'p1')?.sessionId).toBeUndefined();
  });

  it('returns false when nothing matches', async () => {
    await addEntry(entry({ ptyId: 'p1', cwd: '/repo/a', sessionId: 'already' }));
    expect(await bindSessionId('claude', '/repo/a', 'sess-2', canon)).toBe(false);
  });
});

describe('corrupt ledger file', () => {
  it('behaves as empty', async () => {
    writeFileSync(ledgerPath(), 'garbage{');
    expect(await readEntries()).toEqual([]);
    await addEntry(entry({ ptyId: 'recovered' }));
    expect((await readEntries()).map((e) => e.ptyId)).toEqual(['recovered']);
  });
});

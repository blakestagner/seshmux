// session-names: custom session display names over json-store (issue #63). Each case
// runs against a fresh tmp SESHMUX_CONFIG_DIR with the memoized store reset, so the
// on-disk write mechanics are exercised for real.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevConfigDir: string | undefined;

async function mod() {
  return import('../../server/lib/session-names');
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'smx-names-'));
  prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
  process.env.SESHMUX_CONFIG_DIR = dir;
  (await mod())._resetSessionNamesForTest();
});

afterEach(async () => {
  (await mod())._resetSessionNamesForTest();
  if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
  else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('normalizeSessionName', () => {
  it('trims and collapses whitespace, including newlines and tabs', async () => {
    const { normalizeSessionName } = await mod();
    expect(normalizeSessionName('  fix   the\n\tlogin  bug ')).toBe('fix the login bug');
  });

  it('treats non-strings and blank strings as empty', async () => {
    const { normalizeSessionName } = await mod();
    expect(normalizeSessionName('   ')).toBe('');
    expect(normalizeSessionName(null)).toBe('');
    expect(normalizeSessionName(42)).toBe('');
  });

  it('caps at SESSION_NAME_MAX code points without splitting a surrogate pair', async () => {
    const { normalizeSessionName, SESSION_NAME_MAX } = await mod();
    expect(Array.from(normalizeSessionName('x'.repeat(500)))).toHaveLength(SESSION_NAME_MAX);
    const emoji = normalizeSessionName('😀'.repeat(SESSION_NAME_MAX + 5));
    expect(Array.from(emoji)).toHaveLength(SESSION_NAME_MAX);
    expect(emoji).toBe('😀'.repeat(SESSION_NAME_MAX));
  });
});

describe('isValidSessionId', () => {
  it('accepts any listable id (it is only a map key) but refuses empty, huge, and control-char ids', async () => {
    const { isValidSessionId } = await mod();
    expect(isValidSessionId('0b6f1c2e-1234-4abc-9def-001122334455')).toBe(true);
    expect(isValidSessionId('a b:c')).toBe(true);
    expect(isValidSessionId('x'.repeat(201))).toBe(false);
    expect(isValidSessionId('a\nb')).toBe(false);
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
  });
});

describe('session-names store', () => {
  it('reads empty when no file exists', async () => {
    const { readSessionNames } = await mod();
    expect(await readSessionNames()).toEqual({});
  });

  it('a clear issued right after a set is serialized behind it (final state: cleared)', async () => {
    const m = await mod();
    // Not awaited in between: the clear is queued while the set is still pending.
    // An existence check outside the write queue would see "absent", return null
    // early, and then the set would land — leaving 'A' on disk after a clear.
    const [setRes, clearRes] = await Promise.all([
      m.setSessionName('claude', 'race', 'A'),
      m.setSessionName('claude', 'race', ''),
    ]);
    expect(setRes).toBe('A');
    expect(clearRes).toBeNull();
    expect(await m.readSessionNames()).toEqual({});
    m._resetSessionNamesForTest();
    expect(await m.readSessionNames()).toEqual({}); // and on disk
  });

  it('clearing a name that was never set is a no-op that does not write the file', async () => {
    const m = await mod();
    expect(await m.setSessionName('claude', 'ghost', '')).toBeNull();
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(dir, 'session-names.json'))).toBe(false);
  });

  it('sets a name keyed by provider:sessionId and persists it to the config dir', async () => {
    const m = await mod();
    expect(await m.setSessionName('claude', 's1', '  My   session ')).toBe('My session');
    expect(await m.readSessionNames()).toEqual({ 'claude:s1': 'My session' });
    const onDisk = JSON.parse(readFileSync(join(dir, 'session-names.json'), 'utf8'));
    expect(onDisk).toEqual({ 'claude:s1': 'My session' });
  });

  it('survives a process restart (fresh store instance reads the same file)', async () => {
    const m = await mod();
    await m.setSessionName('codex', 's2', 'kept');
    m._resetSessionNamesForTest();
    expect(await m.readSessionNames()).toEqual({ 'codex:s2': 'kept' });
  });

  it('keeps the same id under two providers apart', async () => {
    const m = await mod();
    await m.setSessionName('claude', 'same', 'A');
    await m.setSessionName('codex', 'same', 'B');
    expect(await m.readSessionNames()).toEqual({ 'claude:same': 'A', 'codex:same': 'B' });
  });

  it('an empty or blank name clears the entry (reverts to the auto title)', async () => {
    const m = await mod();
    await m.setSessionName('claude', 's1', 'named');
    await m.setSessionName('claude', 's2', 'other');
    expect(await m.setSessionName('claude', 's1', '   ')).toBeNull();
    expect(await m.readSessionNames()).toEqual({ 'claude:s2': 'other' });
    // clearing a name that was never set is a harmless no-op
    expect(await m.setSessionName('claude', 'nope', '')).toBeNull();
  });

  it('serializes concurrent writes (no lost update)', async () => {
    const m = await mod();
    await Promise.all(Array.from({ length: 20 }, (_, i) => m.setSessionName('claude', `s${i}`, `n${i}`)));
    expect(Object.keys(await m.readSessionNames())).toHaveLength(20);
  });

  it('ignores non-string values in a hand-edited file', async () => {
    writeFileSync(join(dir, 'session-names.json'), JSON.stringify({ 'claude:a': 'ok', 'claude:b': 5, 'claude:c': '' }));
    const m = await mod();
    expect(await m.readSessionNames()).toEqual({ 'claude:a': 'ok' });
  });

  it('a corrupt file reads as empty and self-heals on the next write', async () => {
    writeFileSync(join(dir, 'session-names.json'), '{not json');
    const m = await mod();
    expect(await m.readSessionNames()).toEqual({});
    await m.setSessionName('claude', 's1', 'fresh');
    expect(await m.readSessionNames()).toEqual({ 'claude:s1': 'fresh' });
  });
});

// Client-side session-name cache (issue #63): display fallback, optimistic rename,
// rollback on failure, and "typing the auto title back" = clear. The REST helpers
// are mocked — this covers the client logic only (route/store have their own tests).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const putSessionName = vi.fn();
const getSessionNames = vi.fn();
vi.mock('../../lib/client/api', () => ({
  putSessionName: (...a: unknown[]) => putSessionName(...a),
  getSessionNames: (...a: unknown[]) => getSessionNames(...a),
}));

async function fresh() {
  vi.resetModules();
  return import('../../lib/client/session-names');
}

beforeEach(() => {
  putSessionName.mockReset();
  getSessionNames.mockReset();
});

describe('displayName / customNameFor', () => {
  it('falls back to the auto title when there is no custom name or no session', async () => {
    const m = await fresh();
    const names = { 'claude:s1': 'Custom' };
    expect(m.displayName(names, 'claude', 's1', 'auto')).toBe('Custom');
    expect(m.displayName(names, 'codex', 's1', 'auto')).toBe('auto');
    expect(m.displayName(names, 'claude', undefined, 'auto')).toBe('auto');
    expect(m.displayName(names, undefined, 's1', 'auto')).toBe('auto');
  });
});

describe('renameSession', () => {
  it('persists the normalized name and applies the server echo', async () => {
    const m = await fresh();
    putSessionName.mockResolvedValue({ provider: 'claude', sessionId: 's1', name: 'Fix login' });
    expect(await m.renameSession('claude', 's1', '  Fix   login ', 'first prompt')).toBe('Fix login');
    expect(putSessionName).toHaveBeenCalledWith('claude', 's1', 'Fix login');
    expect(m.sessionNamesSnapshot()).toEqual({ 'claude:s1': 'Fix login' });
    // A reconnect reload agreeing with the server keeps it.
    getSessionNames.mockResolvedValue({ names: { 'claude:s1': 'Fix login' } });
    await m.loadSessionNames();
    expect(m.customNameFor(m.sessionNamesSnapshot(), 'claude', 's1')).toBe('Fix login');
  });

  it('committing the untouched auto title (or blank) with no custom name is a no-op', async () => {
    const m = await fresh();
    expect(await m.renameSession('claude', 's1', ' first  prompt ', 'first prompt')).toBeNull();
    expect(await m.renameSession('claude', 's1', '   ', 'first prompt')).toBeNull();
    expect(putSessionName).not.toHaveBeenCalled();
  });

  it('typing the auto title back over a custom name clears it', async () => {
    const m = await fresh();
    putSessionName.mockResolvedValueOnce({ provider: 'claude', sessionId: 's1', name: 'X' });
    await m.renameSession('claude', 's1', 'X', 'auto');
    putSessionName.mockResolvedValueOnce({ provider: 'claude', sessionId: 's1', name: null });
    expect(await m.renameSession('claude', 's1', 'auto', 'auto')).toBeNull();
    expect(putSessionName).toHaveBeenLastCalledWith('claude', 's1', '');
  });

  it('rolls back the optimistic value when the PUT fails', async () => {
    const m = await fresh();
    putSessionName.mockResolvedValueOnce({ provider: 'claude', sessionId: 's1', name: 'Old' });
    await m.renameSession('claude', 's1', 'Old', 'auto');
    putSessionName.mockRejectedValueOnce(new Error('boom'));
    await expect(m.renameSession('claude', 's1', 'New', 'auto')).rejects.toThrow('boom');
    // Re-committing "Old" is now a no-op again — proving the map rolled back to it.
    expect(await m.renameSession('claude', 's1', 'Old', 'auto')).toBe('Old');
    expect(putSessionName).toHaveBeenCalledTimes(2);
  });
});

describe('ordering', () => {
  it('a slower earlier PUT cannot overwrite a newer rename', async () => {
    const m = await fresh();
    let resolveA!: (v: unknown) => void;
    putSessionName
      .mockImplementationOnce(() => new Promise((r) => (resolveA = r)))
      .mockResolvedValueOnce({ provider: 'claude', sessionId: 's1', name: 'B' });
    const a = m.renameSession('claude', 's1', 'A', 'auto');
    await m.renameSession('claude', 's1', 'B', 'auto');
    resolveA({ provider: 'claude', sessionId: 's1', name: 'A' });
    await a;
    expect(m.sessionNamesSnapshot()['claude:s1']).toBe('B');
  });

  it('a reconnect GET snapshot does not clobber a change that landed while it was in flight', async () => {
    const m = await fresh();
    let resolveGet!: (v: unknown) => void;
    getSessionNames.mockImplementationOnce(() => new Promise((r) => (resolveGet = r)));
    const load = m.loadSessionNames();
    m.applySessionName('claude', 's1', 'from WS'); // newer than the snapshot
    resolveGet({ names: { 'claude:s1': 'stale', 'claude:s2': 'other' } });
    await load;
    expect(m.sessionNamesSnapshot()).toEqual({ 'claude:s1': 'from WS', 'claude:s2': 'other' });
  });
});

describe('loadSessionNamesWithRetry', () => {
  it('retries a transient failure, then applies the names', async () => {
    const m = await fresh();
    getSessionNames
      .mockRejectedValueOnce(Object.assign(new Error('down'), { status: 503 }))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ names: { 'claude:s1': 'N' } });
    await m.loadSessionNamesWithRetry(5, 1);
    expect(getSessionNames).toHaveBeenCalledTimes(3);
    expect(m.sessionNamesSnapshot()).toEqual({ 'claude:s1': 'N' });
  });

  it('does not retry a permanent 4xx, and gives up (logged, never rejects) after N attempts', async () => {
    const m = await fresh();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    getSessionNames.mockRejectedValue(Object.assign(new Error('bad token'), { status: 401 }));
    await m.loadSessionNamesWithRetry(5, 1);
    expect(getSessionNames).toHaveBeenCalledTimes(1);
    getSessionNames.mockReset();
    getSessionNames.mockRejectedValue(new Error('network'));
    await m.loadSessionNamesWithRetry(3, 1);
    expect(getSessionNames).toHaveBeenCalledTimes(3);
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it('retries 408 and 429 (transient 4xx)', async () => {
    const m = await fresh();
    getSessionNames
      .mockRejectedValueOnce(Object.assign(new Error('slow'), { status: 408 }))
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 429 }))
      .mockResolvedValueOnce({ names: {} });
    await m.loadSessionNamesWithRetry(5, 1);
    expect(getSessionNames).toHaveBeenCalledTimes(3);
  });

  it('resyncSessionNames (WS onOpen) always sends its own GET, even while a chain is in flight', async () => {
    const m = await fresh();
    let resolveBoot!: (v: unknown) => void;
    getSessionNames
      .mockImplementationOnce(() => new Promise((r) => (resolveBoot = r))) // boot chain, pre-subscribe
      .mockResolvedValueOnce({ names: { 'claude:s1': 'post-subscribe' } });
    const boot = m.loadSessionNamesWithRetry(5, 1);
    await m.resyncSessionNames();
    expect(getSessionNames).toHaveBeenCalledTimes(2); // did not just join the boot GET
    expect(m.sessionNamesSnapshot()).toEqual({ 'claude:s1': 'post-subscribe' });
    // The older boot GET resolving late must not overwrite the newer snapshot.
    resolveBoot({ names: {} });
    await boot;
    expect(m.sessionNamesSnapshot()).toEqual({ 'claude:s1': 'post-subscribe' });
  });

  it('concurrent callers share one in-flight chain', async () => {
    const m = await fresh();
    let resolve!: (v: unknown) => void;
    getSessionNames.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const a = m.loadSessionNamesWithRetry(5, 1);
    const b = m.loadSessionNamesWithRetry(5, 1);
    expect(a).toBe(b);
    resolve({ names: {} });
    await Promise.all([a, b]);
    expect(getSessionNames).toHaveBeenCalledTimes(1);
  });
});

describe('applySessionName (events WS)', () => {
  it('sets and clears entries', async () => {
    const m = await fresh();
    m.applySessionName('codex', 's9', 'Named');
    // A rename to the same value is then a no-op (no request)
    expect(await m.renameSession('codex', 's9', 'Named', 'auto')).toBe('Named');
    m.applySessionName('codex', 's9', null);
    expect(await m.renameSession('codex', 's9', '', 'auto')).toBeNull();
    expect(putSessionName).not.toHaveBeenCalled();
  });
});

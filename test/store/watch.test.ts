import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { startWatching, type WatchEvent } from '../../server/lib/store/watch';
import type { Ctx } from '../../server/lib/providers/types';

// Fake chokidar watcher: a plain EventEmitter with a no-op close(), so tests can
// synthesize 'add'/'change' events without touching the real filesystem.
class FakeWatcher extends EventEmitter {
  close = vi.fn(async () => {});
}

function makeFakeChokidar() {
  const watchers: FakeWatcher[] = [];
  const factory = vi.fn((_root: string, _opts: unknown) => {
    const w = new FakeWatcher();
    watchers.push(w);
    return w;
  });
  return { factory, watchers };
}

const FAKE_CTX: Ctx = { tokens: 100, window: 200_000, pct: 0, model: 'test-model' };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startWatching', () => {
  it('emits ctx + session-new on an "add" event', async () => {
    const { factory, watchers } = makeFakeChokidar();
    const emit = vi.fn();
    const readCtx = vi.fn(async () => FAKE_CTX);

    const watcher = startWatching({
      watchTargets: [{ root: '/fake/claude/root', provider: 'claude' }],
      emit,
      readCtx,
      chokidarFactory: factory,
    });

    const [fake] = watchers;
    fake.emit('add', '/fake/claude/root/-Users-demo-myrepo/aaaa-1111.jsonl');

    await vi.advanceTimersByTimeAsync(300);

    expect(readCtx).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'session-new',
        provider: 'claude',
        sessionId: 'aaaa-1111',
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ctx',
        provider: 'claude',
        sessionId: 'aaaa-1111',
        ctx: FAKE_CTX,
      }),
    );

    watcher.close();
  });

  it('emits session-touch on a "change" event', async () => {
    const { factory, watchers } = makeFakeChokidar();
    const emit = vi.fn();
    const readCtx = vi.fn(async () => FAKE_CTX);

    startWatching({
      watchTargets: [{ root: '/fake/claude/root', provider: 'claude' }],
      emit,
      readCtx,
      chokidarFactory: factory,
    });

    const [fake] = watchers;
    fake.emit('change', '/fake/claude/root/-Users-demo-myrepo/aaaa-1111.jsonl');

    await vi.advanceTimersByTimeAsync(300);

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'session-touch', provider: 'claude' }),
    );
  });

  it('debounces rapid repeated changes to the same file into a single handling', async () => {
    const { factory, watchers } = makeFakeChokidar();
    const emit = vi.fn();
    const readCtx = vi.fn(async () => FAKE_CTX);

    startWatching({
      watchTargets: [{ root: '/fake/claude/root', provider: 'claude' }],
      emit,
      readCtx,
      chokidarFactory: factory,
    });

    const [fake] = watchers;
    const filePath = '/fake/claude/root/-Users-demo-myrepo/aaaa-1111.jsonl';
    fake.emit('change', filePath);
    await vi.advanceTimersByTimeAsync(100);
    fake.emit('change', filePath); // coalesced with the first — resets the debounce window
    await vi.advanceTimersByTimeAsync(300);

    expect(readCtx).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(2); // one session-touch + one ctx, not doubled
  });

  it('coalesces an add+change within the debounce window into session-new, not session-touch (S4-9)', async () => {
    const { factory, watchers } = makeFakeChokidar();
    const emit = vi.fn();
    const readCtx = vi.fn(async () => FAKE_CTX);

    startWatching({
      watchTargets: [{ root: '/fake/claude/root', provider: 'claude' }],
      emit,
      readCtx,
      chokidarFactory: factory,
    });

    const [fake] = watchers;
    const filePath = '/fake/claude/root/-Users-demo-myrepo/aaaa-1111.jsonl';
    fake.emit('add', filePath); // new file created
    await vi.advanceTimersByTimeAsync(100);
    fake.emit('change', filePath); // first write lands <300ms later — must NOT downgrade
    await vi.advanceTimersByTimeAsync(300);

    expect(readCtx).toHaveBeenCalledTimes(1); // single coalesced handling
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'session-new', sessionId: 'aaaa-1111' }));
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'session-touch' }));
  });

  it('a watcher "error" event does not throw / crash the process', async () => {
    const { factory, watchers } = makeFakeChokidar();
    const watcher = startWatching({
      watchTargets: [{ root: '/fake/claude/root', provider: 'claude' }],
      emit: vi.fn(),
      readCtx: vi.fn(async () => FAKE_CTX),
      chokidarFactory: factory,
    });
    const [fake] = watchers;
    // An unhandled 'error' on an EventEmitter throws synchronously — the guard listener
    // added by startWatching must absorb it.
    expect(() => fake.emit('error', new Error('EMFILE'))).not.toThrow();
    watcher.close();
  });

  it('derives codex sessionId from the rollout filename uuid', async () => {
    const { factory, watchers } = makeFakeChokidar();
    const emit = vi.fn();
    const readCtx = vi.fn(async () => FAKE_CTX);

    startWatching({
      watchTargets: [{ root: '/fake/codex/root', provider: 'codex' }],
      emit,
      readCtx,
      chokidarFactory: factory,
    });

    const [fake] = watchers;
    fake.emit(
      'add',
      '/fake/codex/root/2026/07/08/rollout-2026-07-08T12-00-00-abcd1234-ef56-7890-abcd-1234567890ab.jsonl',
    );
    await vi.advanceTimersByTimeAsync(300);

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'session-new',
        provider: 'codex',
        sessionId: 'abcd1234-ef56-7890-abcd-1234567890ab',
      }),
    );
  });

  it('close() closes all underlying watchers', async () => {
    const { factory, watchers } = makeFakeChokidar();
    const emit = vi.fn();
    const readCtx = vi.fn(async () => FAKE_CTX);

    const watcher = startWatching({
      watchTargets: [
        { root: '/fake/claude/root', provider: 'claude' },
        { root: '/fake/codex/root', provider: 'codex' },
      ],
      emit,
      readCtx,
      chokidarFactory: factory,
    });

    await watcher.close();
    for (const w of watchers) {
      expect(w.close).toHaveBeenCalledTimes(1);
    }
  });

  it('emit receives a null ctx without throwing when readCtx resolves null', async () => {
    const { factory, watchers } = makeFakeChokidar();
    const emit = vi.fn();
    const readCtx = vi.fn(async () => null);

    startWatching({
      watchTargets: [{ root: '/fake/claude/root', provider: 'claude' }],
      emit,
      readCtx,
      chokidarFactory: factory,
    });

    const [fake] = watchers;
    fake.emit('add', '/fake/claude/root/-Users-demo-myrepo/bbbb-2222.jsonl');
    await vi.advanceTimersByTimeAsync(300);

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'ctx', ctx: null }));
  });
});

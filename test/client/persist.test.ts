import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { persistDebounced } from '../../lib/client/persist';

describe('persistDebounced', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', {
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('coalesces a burst of writes into one trailing setItem with the last value', () => {
    for (let i = 0; i < 60; i++) persistDebounced('k', String(i), 250);
    expect(store.has('k')).toBe(false); // nothing written mid-burst
    vi.advanceTimersByTime(250);
    expect(store.get('k')).toBe('59'); // final value lands after the burst
  });

  it('keys debounce independently', () => {
    persistDebounced('a', '1', 250);
    persistDebounced('b', '2', 250);
    vi.advanceTimersByTime(250);
    expect(store.get('a')).toBe('1');
    expect(store.get('b')).toBe('2');
  });
});

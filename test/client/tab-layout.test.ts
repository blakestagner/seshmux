import { describe, it, expect, beforeEach } from 'vitest';
import {
  readTabLayout,
  writeTabLayout,
  orderByLayout,
  minimizedFromLayout,
} from '../../lib/client/tab-layout';

function installLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

beforeEach(() => installLocalStorage());

const sessions = (...ids: string[]) => ids.map((ptyId) => ({ ptyId }));
const tabIdOf = (s: { ptyId: string }) => 'term-' + s.ptyId;

describe('orderByLayout', () => {
  it('replays the saved strip order over daemon order', () => {
    const layout = [
      { id: 'term-pty-3', minimized: false },
      { id: 'term-pty-1', minimized: false },
      { id: 'term-pty-2', minimized: false },
    ];
    expect(orderByLayout(sessions('pty-1', 'pty-2', 'pty-3'), tabIdOf, layout).map((s) => s.ptyId)).toEqual([
      'pty-3',
      'pty-1',
      'pty-2',
    ]);
  });

  it('appends sessions the layout has never seen, in live order', () => {
    const layout = [{ id: 'term-pty-5', minimized: false }];
    expect(orderByLayout(sessions('pty-1', 'pty-5', 'pty-2'), tabIdOf, layout).map((s) => s.ptyId)).toEqual([
      'pty-5',
      'pty-1',
      'pty-2',
    ]);
  });

  it('ignores layout entries with no live PTY behind them', () => {
    const layout = [
      { id: 'term-pty-9', minimized: false },
      { id: 'term-pty-1', minimized: false },
    ];
    expect(orderByLayout(sessions('pty-1'), tabIdOf, layout).map((s) => s.ptyId)).toEqual(['pty-1']);
  });

  it('with no saved layout, preserves live order exactly (degrades to today)', () => {
    expect(orderByLayout(sessions('pty-2', 'pty-1'), tabIdOf, []).map((s) => s.ptyId)).toEqual(['pty-2', 'pty-1']);
  });
});

describe('minimizedFromLayout', () => {
  it('returns only minimized tabs that actually opened', () => {
    const layout = [
      { id: 'term-pty-1', minimized: true },
      { id: 'term-pty-2', minimized: false },
      { id: 'term-pty-3', minimized: true }, // dismissed / not live → never opened
    ];
    expect(minimizedFromLayout(layout, ['term-pty-1', 'term-pty-2'])).toEqual(['term-pty-1']);
  });

  it('is empty when nothing was minimized', () => {
    expect(minimizedFromLayout([{ id: 'term-pty-1', minimized: false }], ['term-pty-1'])).toEqual([]);
  });
});

describe('read/writeTabLayout', () => {
  it('round-trips', () => {
    writeTabLayout([
      { id: 'term-pty-1', minimized: false },
      { id: 'term-pty-2', minimized: true },
    ]);
    expect(readTabLayout()).toEqual([
      { id: 'term-pty-1', minimized: false },
      { id: 'term-pty-2', minimized: true },
    ]);
  });

  it('reads a corrupt or non-array payload as no saved layout', () => {
    localStorage.setItem('seshmux-tab-layout', 'not json');
    expect(readTabLayout()).toEqual([]);
    localStorage.setItem('seshmux-tab-layout', JSON.stringify({ id: 'x' }));
    expect(readTabLayout()).toEqual([]);
  });

  it('drops malformed entries and defaults a missing minimized flag to false', () => {
    localStorage.setItem(
      'seshmux-tab-layout',
      JSON.stringify([{ id: 'term-pty-1' }, { minimized: true }, null, 'term-pty-2']),
    );
    expect(readTabLayout()).toEqual([{ id: 'term-pty-1', minimized: false }]);
  });
});

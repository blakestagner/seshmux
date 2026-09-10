import { describe, it, expect, beforeEach } from 'vitest';
import {
  readDismissed,
  addDismissed,
  removeDismissed,
  keepLiveDismissals,
  pruneDismissed,
} from '../../lib/client/dismissed';

const KEY = 'seshmux-dismissed-ptys-v2';
const LEGACY_KEY = 'seshmux-dismissed-ptys';

// jsdom is not configured for this suite, so stand up the tiny surface used.
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

describe('keepLiveDismissals', () => {
  it('drops dismissals whose PTY is no longer alive', () => {
    expect(keepLiveDismissals(['pty-1', 'pty-2'], ['pty-2'])).toEqual(['pty-2']);
  });

  it('empties the list when nothing is live', () => {
    expect(keepLiveDismissals(['pty-1', 'pty-7'], [])).toEqual([]);
  });

  it('keeps a dismissal for a PTY that really is still alive (failed kill)', () => {
    expect(keepLiveDismissals(['pty-3'], ['pty-3', 'pty-4'])).toEqual(['pty-3']);
  });

  it('never invents entries for live PTYs that were not dismissed', () => {
    expect(keepLiveDismissals([], ['pty-1'])).toEqual([]);
  });
});

describe('pruneDismissed', () => {
  it('rewrites storage and returns the survivors', () => {
    localStorage.setItem(KEY, JSON.stringify(['pty-1', 'pty-2']));
    expect(pruneDismissed(['pty-2'])).toEqual(['pty-2']);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['pty-2']);
  });

  it('leaves storage untouched when nothing is stale', () => {
    localStorage.setItem(KEY, JSON.stringify(['pty-2']));
    expect(pruneDismissed(['pty-2', 'pty-9'])).toEqual(['pty-2']);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['pty-2']);
  });

  it('survives a corrupt entry', () => {
    localStorage.setItem(KEY, 'not json');
    expect(pruneDismissed(['pty-1'])).toEqual([]);
  });

  // The actual reported bug: a terminal the user never closed vanished on every
  // refresh because a long-dead `pty-1` dismissal was inherited by the new
  // `pty-1` a restarted daemon handed out (_nextId restarts at 1, and with no
  // tmux the dismissal key IS the ptyId).
  it('clears a stale dismissal BEFORE a recycled ptyId can inherit it', () => {
    localStorage.setItem(KEY, JSON.stringify(['pty-1'])); // closed long ago, PTY dead
    // Daemon restarted since; no PTYs alive at the moment of this load.
    expect(pruneDismissed([])).toEqual([]);
    // The next session is handed pty-1 again — and is no longer suppressed.
    expect(pruneDismissed(['pty-1'])).toEqual([]);
    expect(readDismissed()).toEqual([]);
  });
});

describe('addDismissed / removeDismissed', () => {
  it('adds once and removes', () => {
    addDismissed('pty-1');
    addDismissed('pty-1');
    expect(readDismissed()).toEqual(['pty-1']);
    removeDismissed('pty-1');
    expect(readDismissed()).toEqual([]);
  });

  it('ignores empty keys (a tab with neither tmuxName nor ptyId)', () => {
    addDismissed('');
    expect(readDismissed()).toEqual([]);
  });

  it('removing an absent key is a no-op', () => {
    addDismissed('pty-2');
    removeDismissed('pty-9');
    expect(readDismissed()).toEqual(['pty-2']);
  });

  it('reads a non-array payload as empty', () => {
    localStorage.setItem(KEY, JSON.stringify({ pty: 1 }));
    expect(readDismissed()).toEqual([]);
  });
});

// A browser upgrading from the permanent-blacklist build carries entries that
// cannot be told apart from legitimate in-flight ones, so the key bump abandons
// them rather than letting them hide a live terminal for one more load.
describe('legacy key migration', () => {
  it('ignores and deletes the pre-fix list', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(['pty-1']));
    expect(readDismissed()).toEqual([]);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('does not let a legacy entry suppress a live PTY of the same id', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(['pty-1']));
    expect(pruneDismissed(['pty-1'])).toEqual([]);
  });

  it('leaves the new list alone while migrating', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(['pty-1']));
    localStorage.setItem(KEY, JSON.stringify(['pty-4']));
    expect(readDismissed()).toEqual(['pty-4']);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });
});

// Guard for the "daemon unreachable" case: GET /api/sessions/live answers 200
// with an EMPTY list when it could not dial the daemon, so the caller must not
// prune against it. These cover the pure helper's half of that contract — the
// route's half is in test/routes/routes-term.test.ts.
describe('pruning is only safe against a real daemon answer', () => {
  it('an empty live set would drop a dismissal covering a still-running PTY', () => {
    // The failed-kill case api.ts deliberately keeps: pty-3 is alive and must
    // stay suppressed. Pruning against a bogus empty list destroys that.
    expect(keepLiveDismissals(['pty-3'], [])).toEqual([]);
    // ...which is why page.tsx skips the prune entirely unless the live list
    // came back authoritative.
    expect(keepLiveDismissals(['pty-3'], ['pty-3'])).toEqual(['pty-3']);
  });
});

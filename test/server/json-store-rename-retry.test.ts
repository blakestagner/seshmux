// win32 fails rename() with EPERM/EBUSY when the destination is momentarily held
// open by another process (antivirus, an indexer, a backup agent, an editor).
// writeAtomic() used to abandon the write on that: the ledger update was LOST,
// not merely untidy, and the temp file was orphaned forever because nothing ever
// swept them. Fifteen had accumulated in one real config dir, five of them
// within a single morning.
//
// rename is mocked here because the real failure is a race with another process
// that cannot be staged deterministically from inside the test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Transient failures the fake rename should emit before letting one through. */
let failuresLeft = 0;
let renameCalls = 0;
/** Code the fake rename fails with. Only EPERM/EBUSY should be retried. */
let failCode = 'EPERM';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      renameCalls++;
      if (failuresLeft > 0) {
        failuresLeft--;
        const e: NodeJS.ErrnoException = new Error(failCode + ': rename failed');
        e.code = failCode;
        throw e;
      }
      return actual.rename(from, to);
    },
  };
});

const { createJsonStore } = await import('../../server/lib/json-store');

interface Bag {
  items: string[];
}
const empty = (): Bag => ({ items: [] });

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smxjr-'));
  file = join(dir, 'store.json');
  failuresLeft = 0;
  renameCalls = 0;
  failCode = 'EPERM';
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tmpFiles = () => readdirSync(dir).filter((f) => f.endsWith('.tmp'));

describe('writeAtomic survives a transient rename failure', () => {
  it('retries until the write actually lands', async () => {
    failuresLeft = 3;
    const store = createJsonStore<Bag>(file, empty);
    await store.update(() => ({ items: ['landed'] }));

    expect(failuresLeft).toBe(0); // every staged failure was really hit
    expect(renameCalls).toBe(4); // 3 refused + 1 that stuck
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ items: ['landed'] });
    expect(tmpFiles()).toEqual([]);
  });

  it('gives up honestly once the failure is clearly not transient', async () => {
    failuresLeft = Number.MAX_SAFE_INTEGER;
    const store = createJsonStore<Bag>(file, empty);

    await expect(store.update(() => ({ items: ['doomed'] }))).rejects.toThrow(/EPERM/);
    // Bounded, not infinite — and it must not leave its temp file behind.
    expect(renameCalls).toBe(5);
    expect(tmpFiles()).toEqual([]);
  });

  it('does not retry a code that will never clear on its own', async () => {
    // Only EPERM/EBUSY are the open-handle race. ENOSPC is a real condition:
    // fail fast rather than sleeping four times on the way to the same answer.
    failCode = 'ENOSPC';
    failuresLeft = Number.MAX_SAFE_INTEGER;
    const store = createJsonStore<Bag>(file, empty);

    await expect(store.update(() => ({ items: ['x'] }))).rejects.toThrow(/ENOSPC/);
    expect(renameCalls).toBe(1);
    expect(tmpFiles()).toEqual([]);
  });

  it('leaves the queue usable after a failed update', async () => {
    failuresLeft = Number.MAX_SAFE_INTEGER;
    const store = createJsonStore<Bag>(file, empty);
    await expect(store.update(() => ({ items: ['doomed'] }))).rejects.toThrow();

    failuresLeft = 0;
    await store.update((cur) => ({ items: [...cur.items, 'recovered'] }));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ items: ['recovered'] });
    expect(tmpFiles()).toEqual([]);
  });
});

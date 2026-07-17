// json-store: durable JSON store — atomic temp+rename write, serialized async
// update queue, parse-failure-tolerant read. Each case runs against a fresh tmp
// dir so the on-disk atomicity/torn-file mechanics are exercised for real.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore } from '../../server/lib/json-store';

interface Bag {
  items: string[];
}
const empty = (): Bag => ({ items: [] });

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smxj-'));
  file = join(dir, 'store.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createJsonStore', () => {
  it('read() on a missing file returns empty()', async () => {
    const store = createJsonStore<Bag>(file, empty);
    expect(await store.read()).toEqual({ items: [] });
  });

  it('update() round-trips and writes valid JSON to disk', async () => {
    const store = createJsonStore<Bag>(file, empty);
    const persisted = await store.update((cur) => ({ items: [...cur.items, 'a'] }));
    expect(persisted).toEqual({ items: ['a'] });
    expect(await store.read()).toEqual({ items: ['a'] });
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
  });

  it('A1: garbage bytes → read() returns empty() and does not throw; update() recovers', async () => {
    writeFileSync(file, '{not valid json at all');
    const store = createJsonStore<Bag>(file, empty);
    expect(await store.read()).toEqual({ items: [] });
    await store.update((cur) => ({ items: [...cur.items, 'recovered'] }));
    expect(await store.read()).toEqual({ items: ['recovered'] });
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
  });

  it('A2: 50 interleaved un-awaited updates all land (no lost update)', async () => {
    const store = createJsonStore<Bag>(file, empty);
    const calls: Promise<Bag>[] = [];
    for (let i = 0; i < 50; i++) {
      calls.push(store.update((cur) => ({ items: [...cur.items, String(i)] })));
    }
    await Promise.all(calls);
    const final = await store.read();
    expect(final.items).toHaveLength(50);
    expect(new Set(final.items)).toEqual(new Set(Array.from({ length: 50 }, (_, i) => String(i))));
  });

  it('leaves no *.tmp files behind after update()', async () => {
    const store = createJsonStore<Bag>(file, empty);
    await store.update((cur) => ({ items: [...cur.items, 'x'] }));
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a throwing update rejects that call but does not wedge the queue', async () => {
    const store = createJsonStore<Bag>(file, empty);
    await store.update((cur) => ({ items: [...cur.items, 'first'] }));
    await expect(
      store.update(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await store.update((cur) => ({ items: [...cur.items, 'second'] }));
    expect(after).toEqual({ items: ['first', 'second'] });
  });
});

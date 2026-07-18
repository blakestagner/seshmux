// Durable JSON store: atomic temp+rename write, serialized in-process update
// queue, parse-failure-tolerant read. Shared by live-ledger.ts (this plan) and
// scratch-store.ts (scratch-terminal plan). NOT multi-process safe — each file
// must have exactly one owning server process (both consumers qualify).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export interface JsonStore<T> {
  path: string;
  read(): Promise<T>;
  /** Serialized read-modify-write; the returned value is what was persisted. */
  update(fn: (cur: T) => T | Promise<T>): Promise<T>;
}

export function createJsonStore<T>(filePath: string, empty: () => T): JsonStore<T> {
  // Promise-chain mutex: every update() links onto the tail so writes never
  // interleave (A2). A rejected update settles only its own caller — the tail
  // keeps flowing via the .catch below so one bad callback can't wedge the queue.
  let tail: Promise<unknown> = Promise.resolve();

  async function read(): Promise<T> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return empty(); // ENOENT (and any read error): startup path never throws.
    }
    try {
      return JSON.parse(raw) as T;
    } catch (e) {
      // Torn/corrupt file (A1): log and behave as empty so a bad file self-heals
      // on the next update() rather than crashing the startup path.
      console.error('[seshmux] json-store: corrupt file, treating as empty:', filePath, e);
      return empty();
    }
  }

  async function writeAtomic(value: T): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, filePath); // rename replaces atomically (incl. win32).
  }

  function update(fn: (cur: T) => T | Promise<T>): Promise<T> {
    const run = tail.then(async () => {
      const cur = await read();
      const next = await fn(cur);
      await writeAtomic(next);
      return next;
    });
    // The tail must survive a rejected run so the next update still executes.
    tail = run.catch(() => {});
    return run;
  }

  return { path: filePath, read, update };
}

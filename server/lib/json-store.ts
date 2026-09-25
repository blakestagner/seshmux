// Durable JSON store: atomic temp+rename write, serialized in-process update
// queue, parse-failure-tolerant read. Shared by live-ledger.ts (this plan) and
// scratch-store.ts (scratch-terminal plan). NOT multi-process safe — each file
// must have exactly one owning server process (both consumers qualify).

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export interface JsonStore<T> {
  path: string;
  read(): Promise<T>;
  /** Serialized read-modify-write; the returned value is what was persisted. */
  update(fn: (cur: T) => T | Promise<T>): Promise<T>;
  /** Serialized atomic write of a value the caller already computed (no read) —
   *  for a caller that does its own, stricter read (archived-sessions.ts). */
  write(value: T): Promise<T>;
}

// How many times writeAtomic() re-attempts a rename that failed EPERM/EBUSY.
const RENAME_ATTEMPTS = 5;

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

  // win32 fails rename() with EPERM/EBUSY when the destination is momentarily
  // held open by someone else (antivirus, an indexer, a backup agent, an editor).
  // The failure is transient, and giving up on it LOSES the write rather than
  // merely littering: fifteen orphaned temps had piled up in one real config dir,
  // each one a ledger update that silently never landed. Retry briefly, then fail
  // honestly. EPERM/EBUSY here is a win32 phenomenon, but the retry is uniform:
  // posix simply never produces those codes for rename, so nothing is spent.
  async function renameWithRetry(tmp: string): Promise<void> {
    for (let i = 0; ; i++) {
      try {
        await rename(tmp, filePath); // rename replaces atomically (incl. win32).
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (i >= RENAME_ATTEMPTS - 1 || (code !== 'EPERM' && code !== 'EBUSY')) throw e;
        await new Promise((r) => setTimeout(r, 20 * (i + 1)));
      }
    }
  }

  async function writeAtomic(value: T): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(value, null, 2));
      await renameWithRetry(tmp);
    } catch (e) {
      // Never leave the temp behind: an abandoned write used to orphan its file
      // FOREVER, since nothing ever swept them. Best effort, then re-throw so
      // the caller still sees the original failure.
      await unlink(tmp).catch(() => {});
      throw e;
    }
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

  function write(value: T): Promise<T> {
    const run = tail.then(async () => {
      await writeAtomic(value);
      return value;
    });
    tail = run.catch(() => {});
    return run;
  }

  return { path: filePath, read, update, write };
}

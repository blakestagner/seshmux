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
  /**
   * Serialized read-modify-write; the returned value is what is on disk afterwards.
   * A result identical to what is already stored skips the write (no file churn).
   */
  update(fn: (cur: T) => T | Promise<T>): Promise<T>;
}

// How many times writeAtomic() re-attempts a rename that failed EPERM/EBUSY.
const RENAME_ATTEMPTS = 5;

export function createJsonStore<T>(filePath: string, empty: () => T): JsonStore<T> {
  // Promise-chain mutex: every update() links onto the tail so writes never
  // interleave (A2). A rejected update settles only its own caller — the tail
  // keeps flowing via the .catch below so one bad callback can't wedge the queue.
  let tail: Promise<unknown> = Promise.resolve();

  // The parsed value plus the exact file text it came from (null when there is no
  // readable file) — update() compares against the text to skip no-op writes.
  async function readWithRaw(): Promise<{ value: T; raw: string | null }> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return { value: empty(), raw: null }; // ENOENT (and any read error): startup path never throws.
    }
    try {
      return { value: JSON.parse(raw) as T, raw };
    } catch (e) {
      // Torn/corrupt file (A1): log and behave as empty so a bad file self-heals
      // on the next update() rather than crashing the startup path. (Self-heals even
      // on a no-op update: empty() serializes differently from the corrupt text.)
      console.error('[seshmux] json-store: corrupt file, treating as empty:', filePath, e);
      return { value: empty(), raw };
    }
  }

  async function read(): Promise<T> {
    return (await readWithRaw()).value;
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

  function serialize(value: T): string {
    return JSON.stringify(value, null, 2);
  }

  async function writeAtomic(text: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, text);
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
      const { value: cur, raw } = await readWithRaw();
      const next = await fn(cur);
      // Skip the temp+rename (the EPERM/EBUSY-prone path on win32) when the write
      // would reproduce the file byte-for-byte — or, with no file, when the result
      // is just empty(). Decided by CONTENT, not object identity, so a callback
      // that mutates `cur` in place still persists, and a corrupt file still heals.
      // Still inside the serialized queue, so the decision can't race a write.
      const text = serialize(next);
      const unchanged = raw !== null ? text === raw : text === serialize(empty());
      if (!unchanged) await writeAtomic(text);
      return next;
    });
    // The tail must survive a rejected run so the next update still executes.
    tail = run.catch(() => {});
    return run;
  }

  return { path: filePath, read, update };
}

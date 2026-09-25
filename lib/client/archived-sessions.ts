'use client';
// Client mirror of the server's archived-session set (GET/PUT /api/sessions/archived).
// A tiny standalone external store rather than a slice of the app reducer: the
// rail row, the per-project "archived" group and the search dropdown all read it,
// and none of them needs the rest of app state to do so.
//
// The server is the source of truth (it persists to archived-sessions.json and
// filters the rail's session pages); this copy drives counts, labels and
// optimistic updates. Ordering rules, so no reply can roll the set back:
//   - every in-flight PUT's intent is kept in `pending` and overlaid on ANY
//     server list applied while it is in flight;
//   - a GET applies only if no PUT completed since it was sent (it may have been
//     answered before that write landed) and it is the newest GET;
//   - PUTs are SERIALIZED (one in flight at a time), so replies arrive in the
//     order the server applied them and each one is the newest server state.

import { useSyncExternalStore } from 'react';
import { getArchivedSessions, putArchivedSession, type ArchivedSession } from './api';
import type { ProviderId } from './types';

export function archivedKey(provider: string, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

type Snapshot = ReadonlyMap<string, ArchivedSession>;

let snapshot: Snapshot = new Map();
const listeners = new Set<() => void>();
// key -> intended record (null = restore), for PUTs still in flight. `n` counts
// overlapping PUTs on the same key so the entry is cleared by the last one only.
const pending = new Map<string, { rec: ArchivedSession | null; n: number }>();
let putTail: Promise<unknown> = Promise.resolve(); // serializes PUTs
let putsDone = 0; // bumped when a PUT settles — invalidates GETs sent before it
let getSeq = 0;

function emit(next: Snapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

// Server list + every in-flight PUT's intent on top.
function applyServer(list: ArchivedSession[]): void {
  const next = new Map(list.map((a) => [archivedKey(a.provider, a.sessionId), a]));
  for (const [k, { rec }] of pending) {
    if (rec) next.set(k, rec);
    else next.delete(k);
  }
  emit(next);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const EMPTY: Snapshot = new Map();

/** The current archived set, keyed by archivedKey(). Re-renders on every change. */
export function useArchived(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}

/** Re-fetch the set from the server. Best-effort; never overrides a write (see top). */
export async function refreshArchived(): Promise<void> {
  const mine = ++getSeq;
  const doneAtSend = putsDone;
  try {
    const list = await getArchivedSessions();
    if (mine === getSeq && doneAtSend === putsDone) applyServer(list);
  } catch {
    /* keep what we have */
  }
}


let loaded: Promise<void> | null = null;
/** First load, once per page (callers may call freely). Later: refreshArchived(). */
export function loadArchived(): Promise<void> {
  if (!loaded) loaded = refreshArchived();
  return loaded;
}

/** Archive / restore one session. Optimistic; on failure the intent is dropped
 *  and the set resynced from the server (other in-flight toggles keep theirs). */
export async function setSessionArchived(
  s: { provider: ProviderId; sessionId: string; projectId: string },
  archived: boolean,
): Promise<void> {
  const key = archivedKey(s.provider, s.sessionId);
  const before = snapshot.get(key);
  const rec = archived ? (snapshot.get(key) ?? { ...s, archivedAt: Date.now() }) : null;
  const slot = pending.get(key);
  pending.set(key, { rec, n: (slot?.n ?? 0) + 1 });
  const next = new Map(snapshot);
  if (rec) next.set(key, rec);
  else next.delete(key);
  emit(next);

  const settle = () => {
    putsDone++;
    const cur = pending.get(key);
    if (cur && --cur.n <= 0) pending.delete(key);
  };
  let list: ArchivedSession[];
  try {
    const run = putTail.then(() => putArchivedSession(s, archived));
    putTail = run.catch(() => {});
    list = await run;
  } catch (e) {
    settle();
    // Undo this key locally right away (unless another toggle of it is still in
    // flight), then resync from the server.
    if (!pending.has(key)) {
      const undo = new Map(snapshot);
      if (before) undo.set(key, before);
      else undo.delete(key);
      emit(undo);
    }
    void refreshArchived();
    throw e;
  }
  settle();
  applyServer(list);
}

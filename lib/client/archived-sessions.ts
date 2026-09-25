'use client';
// Client mirror of the server's archived-session set (GET/PUT /api/sessions/archived).
// A tiny standalone external store rather than a slice of the app reducer: the
// rail row, the per-project "archived" group and the search dropdown all read it,
// and none of them needs the rest of app state to do so.
//
// The server is the source of truth (it persists to archived-sessions.json and
// filters the rail's session pages); this copy only drives counts, labels and
// optimistic updates, and is replaced by server responses — the LATEST one only,
// so an out-of-order reply can't roll the set back.

import { useSyncExternalStore } from 'react';
import { getArchivedSessions, putArchivedSession, type ArchivedSession } from './api';
import type { ProviderId } from './types';

export function archivedKey(provider: string, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

type Snapshot = ReadonlyMap<string, ArchivedSession>;

let snapshot: Snapshot = new Map();
const listeners = new Set<() => void>();
// Bumped by every request; a response applies only if it is still the newest.
let seq = 0;

function set(next: Snapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

function fromList(list: ArchivedSession[]): Snapshot {
  return new Map(list.map((a) => [archivedKey(a.provider, a.sessionId), a]));
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

/** Synchronous read of the current set (for merges inside state updaters). */
export function isArchived(provider: string, sessionId: string): boolean {
  return snapshot.has(archivedKey(provider, sessionId));
}

/** Re-fetch the set from the server. Best-effort; a newer request wins. */
export async function refreshArchived(): Promise<void> {
  const mine = ++seq;
  try {
    const list = await getArchivedSessions();
    if (mine === seq) set(fromList(list));
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

/** Archive / restore one session. Optimistic; on failure undoes only THIS
 *  session's change (other in-flight toggles keep theirs), resyncs, rethrows. */
export async function setSessionArchived(
  s: { provider: ProviderId; sessionId: string; projectId: string },
  archived: boolean,
): Promise<void> {
  const key = archivedKey(s.provider, s.sessionId);
  const before = snapshot.get(key);
  const apply = (on: boolean, rec?: ArchivedSession) => {
    const next = new Map(snapshot);
    if (on) next.set(key, rec ?? { ...s, archivedAt: Date.now() });
    else next.delete(key);
    set(next);
  };
  apply(archived);
  const mine = ++seq;
  try {
    const list = await putArchivedSession(s, archived);
    if (mine === seq) set(fromList(list));
  } catch (e) {
    apply(!!before, before);
    void refreshArchived();
    throw e;
  }
}

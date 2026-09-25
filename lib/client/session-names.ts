'use client';
// Custom session display names (issue #63) — client cache + hook.
//
// A tiny external store (not AppState) on purpose: names are read by the rail,
// the tab strip, the Agents view and the transcript header, and a module-level
// map with useSyncExternalStore gives every one of them the same value without
// threading a new field through the reducer. The server is the source of truth
// (GET/PUT /api/session-names); the events WS pushes {event:'session-name'} so a
// rename in one browser tab relabels every other one live.
//
// A tab's own `label` is NEVER overwritten with the custom name — the name is
// applied at render via displayName(). That is what makes "clear" revert cleanly
// to the auto-derived title the tab was opened with.

import { useSyncExternalStore } from 'react';
import { getSessionNames, putSessionName } from './api';
import type { ProviderId } from './types';

export type SessionNames = Record<string, string>;

/** Mirror of server/lib/session-names.ts SESSION_NAME_MAX (client never imports server). */
export const SESSION_NAME_MAX = 120;

const EMPTY: SessionNames = Object.freeze({}) as SessionNames;
let names: SessionNames = EMPTY;
const listeners = new Set<() => void>();
// Monotonic change counter + the counter value at each key's last local change.
// loadSessionNames() uses them to keep any change that landed while its GET was
// in flight (a WS event, an optimistic rename) instead of clobbering it with the
// older snapshot.
let gen = 0;
const changedAt = new Map<string, number>();
// Latest renameSession request per key: an older request's response/rollback
// must never overwrite a newer rename's value.
const latestReq = new Map<string, number>();

function setNames(next: SessionNames): void {
  names = next;
  for (const l of listeners) l();
}

/** Current map without subscribing — for event callbacks (notifications) outside render. */
export function sessionNamesSnapshot(): SessionNames {
  return names;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function sessionNameKey(provider: string, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

/** Same canonical form the server persists: whitespace collapsed, trimmed, capped. */
export function normalizeSessionName(raw: string): string {
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > SESSION_NAME_MAX ? chars.slice(0, SESSION_NAME_MAX).join('').trimEnd() : flat;
}

/** The custom name for a session, or undefined when it has none (or isn't a session). */
export function customNameFor(
  all: SessionNames,
  provider: ProviderId | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (!provider || !sessionId) return undefined;
  return all[sessionNameKey(provider, sessionId)] || undefined;
}

/** What to show for a session: its custom name when set, else the auto-derived fallback. */
export function displayName(
  all: SessionNames,
  provider: ProviderId | undefined,
  sessionId: string | undefined,
  fallback: string,
): string {
  return customNameFor(all, provider, sessionId) ?? fallback;
}

/** Subscribe a component to the name map. */
export function useSessionNames(): SessionNames {
  return useSyncExternalStore(subscribe, () => names, () => EMPTY);
}

/** (Re)load every name from the server — on boot and on every events-WS reconnect. */
export async function loadSessionNames(): Promise<void> {
  const startedAt = gen;
  const res = await getSessionNames();
  const snapshot: SessionNames = res && typeof res.names === 'object' && res.names ? { ...res.names } : {};
  // A key changed locally after this GET was sent is newer than the snapshot — keep it.
  for (const [key, at] of changedAt) {
    if (at <= startedAt) continue;
    if (names[key]) snapshot[key] = names[key];
    else delete snapshot[key];
  }
  setNames(snapshot);
}

/** Apply one change locally (from the events WS or our own PUT's response). */
export function applySessionName(provider: string, sessionId: string, name: string | null): void {
  const key = sessionNameKey(provider, sessionId);
  changedAt.set(key, ++gen);
  if ((names[key] ?? null) === (name || null)) return;
  const next = { ...names };
  if (name) next[key] = name;
  else delete next[key];
  setNames(next);
}

/**
 * Persist a rename. An empty (or whitespace-only) name clears the custom name,
 * reverting to the auto title — and so does typing the auto title itself back
 * (`autoTitle`), so an Enter on the untouched prefill never pins a "custom" name
 * that would stop tracking the real one. No change → no request. Applied
 * optimistically; rolled back on failure (the error re-throws for the caller).
 */
export async function renameSession(
  provider: ProviderId,
  sessionId: string,
  raw: string,
  autoTitle?: string,
): Promise<string | null> {
  const key = sessionNameKey(provider, sessionId);
  const prev = names[key] ?? null;
  let clean = normalizeSessionName(raw);
  if (autoTitle != null && clean === normalizeSessionName(autoTitle)) clean = '';
  if ((clean || null) === prev) return prev;
  const reqId = (latestReq.get(key) ?? 0) + 1;
  latestReq.set(key, reqId);
  applySessionName(provider, sessionId, clean || null);
  try {
    const res = await putSessionName(provider, sessionId, clean);
    // A newer rename of this session was issued meanwhile: its value wins.
    if (latestReq.get(key) === reqId) applySessionName(provider, sessionId, res.name);
    return res.name;
  } catch (e) {
    if (latestReq.get(key) === reqId) applySessionName(provider, sessionId, prev);
    throw e;
  }
}

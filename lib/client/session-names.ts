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
// Load ordering: each GET is numbered; a response older than the newest applied
// one is dropped (a slow boot GET must not overwrite a later reconnect resync).
let loadSeq = 0;
let appliedLoadSeq = 0;

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
  const seq = ++loadSeq;
  const res = await getSessionNames();
  // An older GET that resolves after a newer one already applied is stale.
  if (seq < appliedLoadSeq) return;
  appliedLoadSeq = seq;
  const snapshot: SessionNames = res && typeof res.names === 'object' && res.names ? { ...res.names } : {};
  // A key changed locally after this GET was sent is newer than the snapshot — keep it.
  for (const [key, at] of changedAt) {
    if (at <= startedAt) continue;
    if (names[key]) snapshot[key] = names[key];
    else delete snapshot[key];
  }
  setNames(snapshot);
}

// The one retry chain currently running, shared by every concurrent caller (mount
// + WS onOpen fire together at boot; a flapping socket calls onOpen repeatedly).
let inflight: Promise<void> | null = null;

/**
 * loadSessionNames() with retry: a failed load (server mid-restart, a 5xx, a network
 * error) would otherwise leave every custom name missing until the next WS
 * reconnect. Backs off delayMs × 1, 2, 4, 8, then gives up and logs (the next
 * reconnect tries again). A 4xx is permanent — no retry — except 408/429, which
 * are transient. Concurrent calls share one chain. Never rejects.
 *
 * This is the BOOT/fallback loader. The events-WS onOpen must not use it directly:
 * joining an in-flight chain could reuse a GET sent before the socket subscribed
 * and miss a rename broadcast in that gap — see resyncSessionNames().
 */
export function loadSessionNamesWithRetry(attempts = 5, delayMs = 1000): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    for (let i = 0; ; i++) {
      try {
        await loadSessionNames();
        return;
      } catch (e) {
        const status = (e as { status?: number }).status;
        const permanent =
          typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
        if (permanent || i >= attempts - 1) {
          console.error('[seshmux] loading session names failed:', e);
          return;
        }
        await new Promise((r) => setTimeout(r, delayMs * 2 ** i));
      }
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Events-WS (re)connect resync: ALWAYS issues its own fresh GET — sent after the
 * socket subscribed, so no rename can fall in the gap between snapshot and live
 * events — and only on failure falls back to the retry chain. Never rejects.
 */
export async function resyncSessionNames(): Promise<void> {
  try {
    await loadSessionNames();
  } catch {
    await loadSessionNamesWithRetry();
  }
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

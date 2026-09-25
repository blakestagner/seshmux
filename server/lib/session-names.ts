// User-chosen display names for sessions (issue #63). A rename is seshmux's own
// metadata: it lives in `<configDir>/session-names.json` and NEVER touches the
// agent's transcript — the provider stores are read-only to us. Sessions without
// an entry keep their auto-derived title (first prompt / branch); writing an empty
// name deletes the entry, which is how "clear" reverts to the auto name.
//
// Keyed by `${provider}:${sessionId}` so two providers can never collide on an id.
// Typed API over json-store (atomic write + serialized updates), same idiom as
// scratch-store.ts — its own file so it shares no state with any other store.

import path from 'node:path';
import { configDir } from '../daemon-client';
import { createJsonStore, type JsonStore } from './json-store';

export type SessionNames = Record<string, string>; // key: `${provider}:${sessionId}`

/** Longest name we keep. Long enough for a sentence, short enough for a rail row. */
export const SESSION_NAME_MAX = 120;

// The id is only ever a JSON map key here — never joined into a path — so accept
// whatever a provider lists (the transcript's file stem; scan.ts isSafeId is the
// path guard, not this). A stricter shape would make a real, listable session
// silently unrenameable. Only refuse empty, huge, or control-char ids. The key
// stays unambiguous with a ':' in the id because provider ids never contain one.
export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id);
}

export function sessionNameKey(provider: string, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

/**
 * Canonical form of a user-typed name: whitespace runs (incl. newlines and tabs)
 * collapse to one space, the ends are trimmed, and the result is capped at
 * SESSION_NAME_MAX code points (never splitting a surrogate pair). '' = "no name".
 */
export function normalizeSessionName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // Control chars would render as nothing (or garbage) in a single-line row.
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > SESSION_NAME_MAX ? chars.slice(0, SESSION_NAME_MAX).join('').trimEnd() : flat;
}

const empty = (): SessionNames => ({});

export function sessionNamesPath(): string {
  return path.join(configDir(), 'session-names.json');
}

// One memoized store per process; the test hook drops it so a test can repoint
// SESHMUX_CONFIG_DIR (same idiom as scratch-store / live-ledger).
let store: JsonStore<SessionNames> | null = null;
function getStore(): JsonStore<SessionNames> {
  if (!store) store = createJsonStore<SessionNames>(sessionNamesPath(), empty);
  return store;
}

/** Every custom name. A hand-edited file with non-string values is filtered, not trusted. */
export async function readSessionNames(): Promise<SessionNames> {
  const raw = await getStore().read();
  const out: SessionNames = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

/**
 * Set (or, with an empty/blank name, clear) one session's custom name. Returns the
 * name as persisted — normalized — or null when the entry was cleared.
 */
export async function setSessionName(provider: string, sessionId: string, name: unknown): Promise<string | null> {
  const key = sessionNameKey(provider, sessionId);
  const clean = normalizeSessionName(name);
  // Every decision happens INSIDE the serialized update — no read-then-decide
  // fast-path outside it. A clear that checked existence outside the queue could
  // see "absent" while a set of the same key was still queued, return (and so
  // broadcast) null, and then the set would land: the server ends up holding the
  // name while every client was told it was cleared. A no-op (clear of an absent
  // key, same name again) leaves the content unchanged, and json-store skips
  // unchanged writes.
  // ponytail: entries for sessions later deleted from the agent store are never
  // pruned. Each is ~100 bytes; prune against the provider listings if it matters.
  await getStore().update((cur) => {
    const base = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
    if (!clean) {
      if (!(key in base)) return base;
      const next = { ...base };
      delete next[key];
      return next;
    }
    if (base[key] === clean) return base; // unchanged → no write
    return { ...base, [key]: clean };
  });
  return clean || null;
}

export function _resetSessionNamesForTest(): void {
  store = null;
}

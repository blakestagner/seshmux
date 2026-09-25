// Per-session archive ("hide one session") state. The rail's project-level hide
// lives in config.hidden; this is the session-level twin, kept in its OWN data
// file (`archived-sessions.json` under the seshmux config dir) over json-store —
// same helper and memoization as live-ledger.ts / scratch-store.ts.
//
// Archiving is purely seshmux's bookkeeping: the agent's transcript is never
// touched (seshmux is read-only against the provider stores). A record only
// changes what the rail LISTS by default; full-text search still finds the
// session and flags it as archived.
//
// Keyed by `${provider}:${sessionId}` — ids come from two independent stores,
// so the provider is part of a session's identity here.

import path from 'node:path';
import { configDir } from '../daemon-client';
import { createJsonStore, type JsonStore } from './json-store';

export interface ArchivedRecord {
  provider: string;
  sessionId: string;
  projectId: string; // rail project the session was listed under (per-project counts)
  archivedAt: number;
}
export type ArchivedMap = Record<string, ArchivedRecord>;

const empty = (): ArchivedMap => ({});

export function archivedKey(provider: string, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

export function archivedStorePath(): string {
  return path.join(configDir(), 'archived-sessions.json');
}

let store: JsonStore<ArchivedMap> | null = null;
function getStore(): JsonStore<ArchivedMap> {
  if (!store) store = createJsonStore<ArchivedMap>(archivedStorePath(), empty);
  return store;
}

// In-memory copy. This server process is the file's only writer (json-store's
// contract), and every rail page asks — so read disk once, then keep it current
// from each update()'s persisted result.
let cache: ArchivedMap | null = null;

function isRecord(v: unknown): v is ArchivedRecord {
  const r = v as ArchivedRecord;
  return (
    !!r &&
    typeof r === 'object' &&
    typeof r.provider === 'string' &&
    typeof r.sessionId === 'string' &&
    typeof r.projectId === 'string' &&
    typeof r.archivedAt === 'number'
  );
}

// A hand-edited or torn file can parse to anything; never let that crash a
// session listing — drop what isn't a well-formed record (the next write
// self-heals the file).
function clean(m: unknown): ArchivedMap {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
  const out: ArchivedMap = {};
  for (const [k, v] of Object.entries(m)) if (isRecord(v)) out[k] = v;
  return out;
}

export async function readArchived(): Promise<ArchivedMap> {
  if (!cache) cache = clean(await getStore().read());
  return cache;
}

export async function archivedKeys(): Promise<Set<string>> {
  return new Set(Object.keys(await readArchived()));
}

async function update(fn: (cur: ArchivedMap) => ArchivedMap): Promise<ArchivedMap> {
  cache = await getStore().update((raw) => fn(clean(raw)));
  return cache;
}

/** Archive (on=true) or restore (on=false) one session. Idempotent both ways. */
export async function setArchived(
  rec: { provider: string; sessionId: string; projectId: string },
  on: boolean,
): Promise<ArchivedMap> {
  const key = archivedKey(rec.provider, rec.sessionId);
  return update((cur) => {
    if (on) {
      if (cur[key]) return cur;
      return { ...cur, [key]: { ...rec, archivedAt: Date.now() } };
    }
    if (!(key in cur)) return cur;
    const next = { ...cur };
    delete next[key];
    return next;
  });
}

/**
 * Filter a project's merged session listing by archive state ('exclude' = the
 * rail's default list, 'only' = its archived group).
 *
 * The 'only' call also drops records whose transcript is gone — the agent's own
 * cleanup (or the user) deleted it — so the rail's "archived (N)" count cannot
 * drift from the group forever. Guarded so a flaky listing can't wipe records: a
 * provider must be in `completeProviders` (listed, unfiltered, without error)
 * AND must have returned at least one session for this project. Losing a record
 * wrongly only un-hides a session; it never touches a transcript.
 */
export async function filterArchived<S extends { id: string; provider: string }>(
  sessions: S[],
  mode: 'exclude' | 'only',
  opts: { projectId: string; completeProviders: string[] },
): Promise<S[]> {
  const map = await readArchived();
  const has = (s: S) => archivedKey(s.provider, s.id) in map;
  if (mode === 'exclude') return sessions.filter((s) => !has(s));

  const listed = new Set(sessions.map((s) => archivedKey(s.provider, s.id)));
  const provable = new Set(
    opts.completeProviders.filter((p) => sessions.some((s) => s.provider === p)),
  );
  const stale = Object.entries(map)
    .filter(([k, r]) => r.projectId === opts.projectId && provable.has(r.provider) && !listed.has(k))
    .map(([k]) => k);
  if (stale.length) {
    await update((cur) => {
      const next = { ...cur };
      for (const k of stale) delete next[k];
      return next;
    }).catch(() => {}); // best-effort housekeeping; the listing is still right
  }
  return sessions.filter(has);
}

// Test hook: drop the memoized store so a test can repoint SESHMUX_CONFIG_DIR.
export function _resetArchivedStoreForTest(): void {
  store = null;
  cache = null;
}

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
//
// The file is the user's only copy of what they archived, so it is handled more
// carefully than json-store's default "unreadable/corrupt = empty":
//   - corrupt (unparseable / not an object): moved aside to
//     archived-sessions.json.corrupt-<ts> before anything is written over it;
//   - unreadable (any read error but ENOENT): every write REFUSES, rather than
//     replacing a file we could not see with a near-empty one.

import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../daemon-client';
import { createJsonStore, type JsonStore } from './json-store';

export interface ArchivedRecord {
  provider: string;
  sessionId: string;
  projectId: string; // rail project the session is listed under (per-project counts)
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

// Well-formed records only. Malformed ENTRIES in an otherwise valid object are
// dropped (they could never match or render); a malformed FILE is quarantined.
function clean(m: unknown): ArchivedMap {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
  const out: ArchivedMap = {};
  for (const [k, v] of Object.entries(m)) if (isRecord(v)) out[k] = v;
  return out;
}

/**
 * Read the file ourselves (json-store's read hides every failure as "empty").
 * ENOENT → {}; any other read error → throws; corrupt → {} and, when
 * `quarantine` (ONLY inside the serialized write queue, so a concurrent write
 * can never have its fresh file renamed away), moved aside first.
 */
async function loadStrict(quarantine: boolean): Promise<ArchivedMap> {
  const file = archivedStorePath();
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (quarantine) {
      const aside = `${file}.corrupt-${Date.now()}`;
      await rename(file, aside); // throws → no write proceeds over it
      console.error('[seshmux] archived-sessions: corrupt file moved aside to', aside);
    }
    return {};
  }
  return clean(parsed);
}

// In-memory copy. This server process is the file's only writer (json-store's
// contract), and every rail page asks — so read disk once (one shared promise,
// never re-assigned by a slower first read), then keep it current from each
// write's persisted result.
let cache: Promise<ArchivedMap> | null = null;

/** The archive map; THROWS if the file exists but can't be read (not memoized). */
export function readArchivedStrict(): Promise<ArchivedMap> {
  if (!cache) {
    const p = loadStrict(false);
    cache = p;
    p.catch(() => {
      if (cache === p) cache = null; // retry next time, never memoize "empty"
    });
  }
  return cache;
}

/** Tolerant read for listing filters: an unreadable file degrades to "nothing archived". */
export function readArchived(): Promise<ArchivedMap> {
  return readArchivedStrict().catch((e) => {
    console.error('[seshmux] archived-sessions: unreadable, listing as empty:', e);
    return {};
  });
}

export async function archivedKeys(): Promise<Set<string>> {
  return new Set(Object.keys(await readArchived()));
}

// Every write goes through here, one at a time. The strict read IS the base the
// change is applied to (json-store is used only for its atomic temp+rename write,
// its own lenient read never feeds a write), so an unreadable file refuses the
// write and a corrupt one is quarantined first.
let writeTail: Promise<unknown> = Promise.resolve();
function update(fn: (cur: ArchivedMap) => ArchivedMap): Promise<ArchivedMap> {
  const run = writeTail.then(async () => {
    const cur = await loadStrict(true);
    const next = fn(cur);
    await getStore().write(next);
    cache = Promise.resolve(next);
    return next;
  });
  writeTail = run.catch(() => {});
  return run;
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

export interface FilterOpts {
  /** The rail project this listing is for. */
  projectId: string;
  /** When the provider listing started — records archived after it are never judged by it. */
  listedAt: number;
  /** Providers whose listing completed without error and unfiltered (no `q`). */
  completeProviders: string[];
  /** Every session id the provider's store holds (AgentProvider.allSessionIds).
   *  null or a throw = can't tell → keep. Callers should memoize per request. */
  existingIds: (provider: string) => Promise<Set<string> | null>;
  /** The rail project a session currently lists under, or null if not found. */
  locate: (provider: string, sessionId: string) => Promise<string | null>;
}

// Records whose session exists but could not be located anywhere: don't repeat the
// (full-store) locate sweep for them on every group open. key -> retry-after ms.
const LOCATE_RETRY_MS = 10 * 60_000;
const unlocatable = new Map<string, number>();

/**
 * Filter a project's merged session listing by archive state ('exclude' = the
 * rail's default list, 'only' = its archived group). 'exclude' only filters —
 * it never writes (a session can list under two project ids on a case-
 * insensitive FS, and a write-per-listing there would flip-flop the record).
 *
 * 'only' also keeps records filed under the project their session lists under.
 * A record for this project whose session is missing from this listing is a
 * CANDIDATE only — missing-from-this-listing proves nothing (it may have
 * re-grouped, or a dir was unreadable). Guards, all failing closed: the record
 * predates the listing, the provider listed completely, and the provider's
 * whole-store id set is readable. Then: still in the store → RE-HOME it to where
 * it lists now (left as-is if it can't be located); positively absent → drop it.
 * Each write re-checks the record it finds (same project, still predating the
 * listing), so a restore + re-archive that landed meanwhile is never clobbered.
 *
 * Reads strictly: an unreadable archive file THROWS (the route answers 500) rather
 * than presenting an empty archived group.
 */
export async function filterArchived<S extends { id: string; provider: string }>(
  sessions: S[],
  mode: 'exclude' | 'only',
  opts: FilterOpts,
): Promise<S[]> {
  if (mode === 'exclude') {
    const map = await readArchived(); // tolerant: an unreadable file just filters nothing
    return sessions.filter((s) => !(archivedKey(s.provider, s.id) in map));
  }

  const map = await readArchivedStrict();
  const listed = new Set(sessions.map((s) => archivedKey(s.provider, s.id)));
  const complete = new Set(opts.completeProviders);
  const candidates = Object.entries(map).filter(
    ([k, r]) => r.projectId === opts.projectId && !listed.has(k) && r.archivedAt < opts.listedAt && complete.has(r.provider),
  );
  const gone: string[] = [];
  const moves: [string, string][] = [];
  const now = Date.now();
  for (const [k, r] of candidates) {
    const ids = await opts.existingIds(r.provider).catch(() => null);
    if (!ids) continue; // can't tell → keep
    if (!ids.has(r.sessionId)) {
      gone.push(k);
      continue;
    }
    if ((unlocatable.get(k) ?? 0) > now) continue;
    const where = await opts.locate(r.provider, r.sessionId).catch(() => null);
    if (where && where !== opts.projectId) moves.push([k, where]);
    else unlocatable.set(k, now + LOCATE_RETRY_MS);
  }
  // Still the record this listing judged? (not restored/re-archived meanwhile)
  const unchanged = (cur: ArchivedMap, k: string) =>
    !!cur[k] && cur[k].projectId === opts.projectId && cur[k].archivedAt < opts.listedAt;
  if (gone.length || moves.length) {
    await update((cur) => {
      const next = { ...cur };
      for (const k of gone) if (unchanged(cur, k)) delete next[k];
      for (const [k, projectId] of moves) if (unchanged(cur, k)) next[k] = { ...cur[k], projectId };
      return next;
    }).catch(() => {}); // best-effort housekeeping; the listing itself is still right
  }
  return sessions.filter((s) => archivedKey(s.provider, s.id) in map);
}

// Test hook: drop the memoized store so a test can repoint SESHMUX_CONFIG_DIR.
export function _resetArchivedStoreForTest(): void {
  store = null;
  cache = null;
  writeTail = Promise.resolve();
  unlocatable.clear();
}

// The harvester: walks sessions forward through AgentProvider.harvestFrom, extracts records,
// appends them. Server process only.
//
// Follows restore.ts's pure/effectful split — `shouldHarvest` and `pickBackfill` are pure
// and carry all the judgement; `createHarvester` is the effectful shell with a fully
// injectable deps bag. Every failure is caught and logged, never propagated: the harvester
// hangs off the watch fan-out, and ledger-binding.ts already establishes the rule that
// nothing bolted onto that fan-out may disturb it.
//
// COALESCING is the whole difficulty. The `session-touch` event fires on EVERY jsonl write,
// which during an active turn is continuous. Harvesting on each one would re-read, re-parse
// and re-append constantly for no benefit, because a half-written turn has nothing worth
// remembering yet. So a session is harvested at most once per THROTTLE_MS, and only after
// it has been QUIET_MS untouched — i.e. at the natural pauses between turns.

import { join } from 'node:path';
import { createJsonStore, type JsonStore } from '../json-store';
import type { AgentProvider, ProviderId, SessionMeta } from '../providers/types';
import { extract } from './extract';
import { appendRecords, memoryDir, readAllRecords } from './store';
import type { MemoryRecord } from './types';

export const THROTTLE_MS = 60_000;
export const QUIET_MS = 20_000;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/** Slices consumed per harvest call — bounded work per tick, but enough to make progress. */
export const DEFAULT_MAX_SLICES = 8;
/** How many recent sessions the boot backfill will look at. Bounded on purpose. */
export const DEFAULT_BACKFILL_LIMIT = 40;
/**
 * Ceiling on records kept from any one session.
 *
 * extract.ts has per-kind caps too, but those are necessarily per SLICE — extraction is
 * stateless across slices, so it cannot know what earlier slices already produced. Only the
 * harvester can see the stored total, so the genuine per-session bound lives here. Without
 * it, one very long session would contribute records in proportion to its length and crowd
 * every other project out of the global cap.
 */
export const DEFAULT_MAX_PER_SESSION = 120;

export interface Watermark {
  /** Byte offset already consumed. */
  offset: number;
  /** Wall clock of the last harvest attempt — drives the throttle. */
  at: number;
  /** Session mtime as of that attempt — lets us skip a session that has not moved. */
  mtime: number;
  /** The session was finished and fully read; nothing more will ever come from it. */
  complete?: boolean;
}

export interface Watermarks {
  v: 1;
  marks: Record<string, Watermark>;
}

export function watermarksPath(): string {
  return join(memoryDir(), 'watermarks.json');
}

const emptyMarks = (): Watermarks => ({ v: 1, marks: {} });

// Memoized per process, per path — the live-ledger.ts idiom, including the test reset.
let store: JsonStore<Watermarks> | null = null;
function getStore(): JsonStore<Watermarks> {
  if (!store) store = createJsonStore<Watermarks>(watermarksPath(), emptyMarks);
  return store;
}
export function _resetHarvestForTest(): void {
  store = null;
}

export function markKey(provider: ProviderId, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

export interface HarvestTarget {
  provider: ProviderId;
  projectId: string;
  /**
   * Absolute repo path for the citation. Prefer the SESSION's own cwd: a folded worktree
   * session is listed under the parent project but actually lives in the worktree, and a
   * record citing the wrong directory is worse than one citing none.
   */
  repo: string;
  session: SessionMeta;
}

export interface ScheduleOpts {
  throttleMs?: number;
  quietMs?: number;
}

export type SkipReason = 'complete' | 'throttled' | 'still-writing' | 'unchanged' | null;

/**
 * Whether a session is worth harvesting right now. Returns the reason for skipping so both
 * the tests and the logs can say WHY nothing happened, rather than a bare boolean.
 */
export function shouldHarvest(
  mark: Watermark | undefined,
  session: SessionMeta,
  now: number,
  opts: ScheduleOpts = {},
): SkipReason {
  const throttleMs = opts.throttleMs ?? THROTTLE_MS;
  const quietMs = opts.quietMs ?? QUIET_MS;

  // "Complete" is relative to the mtime it was observed at, never permanent. A session that
  // looked finished can be resumed (`claude --resume`, `codex resume`) hours later; treating
  // completeness as final would mean the continuation is never harvested at all.
  if (mark?.complete && session.mtime <= mark.mtime) return 'complete';

  // A live session mid-turn is still being written. Wait for the pause: a half-written turn
  // holds nothing worth remembering, and re-reading it now only to re-read it again in two
  // seconds is pure waste.
  if (session.live && now - session.mtime < quietMs) return 'still-writing';

  if (mark) {
    if (now - mark.at < throttleMs) return 'throttled';
    // Nothing appended since we last looked, and we had already reached the end.
    if (session.mtime <= mark.mtime && mark.offset > 0) return 'unchanged';
  }
  return null;
}

/**
 * Which sessions the boot backfill should read, newest first. Sessions already completely
 * harvested are skipped, so a restart does not re-walk the whole store.
 */
export function pickBackfill(
  targets: HarvestTarget[],
  marks: Record<string, Watermark>,
  limit = DEFAULT_BACKFILL_LIMIT,
): HarvestTarget[] {
  return targets
    .filter((t) => {
      // Same mtime-relative rule as shouldHarvest: a resumed session is no longer complete.
      const mark = marks[markKey(t.provider, t.session.id)];
      return !(mark?.complete && t.session.mtime <= mark.mtime);
    })
    .sort((a, b) => b.session.mtime - a.session.mtime)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Effectful
// ---------------------------------------------------------------------------

export interface HarvestDeps {
  providers: () => Promise<AgentProvider[]>;
  now?: () => number;
  maxBytes?: number;
  maxSlicesPerCall?: number;
  backfillLimit?: number;
  schedule?: ScheduleOpts;
  maxPerSession?: number;
  /** Injectable so tests assert on what would be written without touching disk. */
  append?: (records: MemoryRecord[]) => Promise<MemoryRecord[]>;
  existingRecords?: () => Promise<MemoryRecord[]>;
  log?: (msg: string, err?: unknown) => void;
}

export interface HarvestResult {
  harvested: number;
  slices: number;
  skipped: SkipReason;
}

function defaultLog(msg: string, err?: unknown): void {
  if (err) console.error(`[memory] ${msg}`, err);
}

/**
 * Read one session forward from its watermark and append whatever comes out.
 *
 * Bounded per call: at most `maxBytes` is consumed, so the 46MB transcript in a real store is
 * absorbed over several ticks instead of blocking the event loop once. The watermark makes
 * that resumable across restarts as well as across ticks.
 */
export async function harvestSession(
  target: HarvestTarget,
  provider: AgentProvider,
  deps: HarvestDeps,
): Promise<HarvestResult> {
  const now = deps.now ?? Date.now;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const append = deps.append ?? appendRecords;
  const existing = deps.existingRecords ?? readAllRecords;
  const maxPerSession = deps.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
  const log = deps.log ?? defaultLog;
  const key = markKey(target.provider, target.session.id);

  if (!provider.harvestFrom) return { harvested: 0, slices: 0, skipped: null };

  const marks = await getStore().read();
  const mark = marks.marks[key];
  const skip = shouldHarvest(mark, target.session, now(), deps.schedule);
  if (skip) return { harvested: 0, slices: 0, skipped: skip };

  let offset = mark?.offset ?? 0;
  let harvested = 0;
  let slices = 0;
  let done = false;

  try {
    // Several slices per call, not one: at one 4MB slice per 60s throttle tick, the 46MB
    // transcript that actually exists in a real store would take twelve minutes to absorb.
    // Bounded all the same — this is awaited I/O between slices, so the loop yields.
    const maxSlices = deps.maxSlicesPerCall ?? DEFAULT_MAX_SLICES;
    const stored = await existing();
    const known = new Set(stored.map((r) => r.id));
    let kept = stored.filter((r) => r.origin.sessionId === target.session.id).length;

    for (; slices < maxSlices; slices++) {
      const slice = await provider.harvestFrom(target.projectId, target.session.id, offset, maxBytes);
      done = slice.done;

      if (slice.msgs.length) {
        const records = extract(slice.msgs, {
          provider: target.provider,
          sessionId: target.session.id,
          projectId: target.session.projectId,
          repo: target.repo,
          branch: target.session.branch,
          // Only a finished session gets an `outcome`. A live one has concluded nothing.
          final: slice.done && !target.session.live,
          now: now(),
        });
        const room = Math.max(0, maxPerSession - kept);
        const fresh = records.filter((r) => !known.has(r.id)).slice(0, room);
        if (fresh.length) {
          harvested += (await append(fresh)).length;
          for (const r of fresh) known.add(r.id);
          kept += fresh.length;
        }
      }

      // No forward progress (a line still being written) — stop and let the next tick retry.
      if (slice.nextOffset === offset) {
        slices++;
        break;
      }
      offset = slice.nextOffset;
      if (done) {
        slices++;
        break;
      }
    }
  } catch (err) {
    // A harvest failure must never disturb the caller — same contract as ledger-binding.
    log(`harvest failed for ${key}`, err);
    return { harvested, slices, skipped: null };
  }

  await getStore().update((cur) => ({
    ...cur,
    marks: {
      ...cur.marks,
      [key]: {
        offset,
        at: now(),
        mtime: target.session.mtime,
        // "Complete" is only true for a session that is both finished and fully read —
        // otherwise a restart would never pick the rest of it up.
        complete: done && !target.session.live,
      },
    },
  }));

  return { harvested, slices, skipped: null };
}

/** Every session both providers can see, flattened into harvest targets. */
export async function listTargets(deps: HarvestDeps): Promise<{ target: HarvestTarget; provider: AgentProvider }[]> {
  const out: { target: HarvestTarget; provider: AgentProvider }[] = [];
  for (const provider of await deps.providers()) {
    if (!provider.harvestFrom) continue; // a provider without the seam is simply skipped
    let projects;
    try {
      projects = await provider.scanProjects();
    } catch {
      continue;
    }
    for (const project of projects) {
      let sessions: SessionMeta[];
      try {
        sessions = await provider.listSessions(project.id);
      } catch {
        continue;
      }
      for (const session of sessions) {
        out.push({
          target: {
            provider: provider.id,
            projectId: project.id,
            repo: session.cwd ?? project.path,
            session,
          },
          provider,
        });
      }
    }
  }
  return out;
}

export interface Harvester {
  /** Called from the watch fan-out. Coalesces; returns immediately. */
  onSessionTouched(provider: ProviderId, projectId: string, sessionId: string): void;
  /** Bounded pass over recent sessions so memory is not empty on first run. */
  backfill(): Promise<number>;
  /** Await whatever is currently queued — tests and shutdown. */
  drain(): Promise<void>;
  stop(): void;
}

export function createHarvester(deps: HarvestDeps): Harvester {
  const log = deps.log ?? defaultLog;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  // One queue for the whole harvester: appends, watermark writes and (later) compaction must
  // not interleave, and a serial chain is the cheapest way to guarantee that.
  let queue: Promise<unknown> = Promise.resolve();
  let stopped = false;

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  async function harvestOne(providerId: ProviderId, projectId: string, sessionId: string): Promise<void> {
    const provider = (await deps.providers()).find((p) => p.id === providerId);
    if (!provider?.harvestFrom) return;
    let sessions: SessionMeta[];
    try {
      sessions = await provider.listSessions(projectId);
    } catch (err) {
      log(`listSessions failed for ${providerId}:${projectId}`, err);
      return;
    }
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    // Fall back to the project's path only when the session did not record its own cwd;
    // scanProjects is TTL-memoized, so this lookup is nearly free.
    let repo = session.cwd ?? '';
    if (!repo) {
      const projects = await provider.scanProjects().catch(() => []);
      repo = projects.find((pr) => pr.id === projectId)?.path ?? '';
    }
    await harvestSession({ provider: providerId, projectId, repo, session }, provider, deps);
  }

  return {
    onSessionTouched(providerId, projectId, sessionId) {
      if (stopped) return;
      const key = `${providerId}:${projectId}:${sessionId}`;
      const existing = pending.get(key);
      if (existing) clearTimeout(existing);
      // Debounce to the quiet window: a burst of writes during one turn collapses to a
      // single harvest after the turn settles.
      const quiet = deps.schedule?.quietMs ?? QUIET_MS;
      pending.set(
        key,
        setTimeout(() => {
          pending.delete(key);
          void enqueue(() => harvestOne(providerId, projectId, sessionId)).catch((err) =>
            log(`harvest tick failed for ${key}`, err),
          );
        }, quiet),
      );
    },

    async backfill() {
      if (stopped) return 0;
      return enqueue(async () => {
        const all = await listTargets(deps);
        const marks = (await getStore().read()).marks;
        const picked = pickBackfill(
          all.map((a) => a.target),
          marks,
          deps.backfillLimit ?? DEFAULT_BACKFILL_LIMIT,
        );
        const byKey = new Map(all.map((a) => [markKey(a.target.provider, a.target.session.id), a.provider]));
        let total = 0;
        for (const target of picked) {
          if (stopped) break;
          const provider = byKey.get(markKey(target.provider, target.session.id));
          if (!provider) continue;
          const res = await harvestSession(target, provider, {
            ...deps,
            // Backfill reads history, not a live session, so the throttle and quiet windows
            // (which exist to avoid re-reading a session mid-turn) would only slow it down.
            schedule: { throttleMs: 0, quietMs: 0 },
          });
          total += res.harvested;
        }
        return total;
      });
    },

    async drain() {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      await queue;
    },

    stop() {
      stopped = true;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}

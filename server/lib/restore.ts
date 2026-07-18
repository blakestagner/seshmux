// Startup auto-restore brain. Pure planning (planReconcile) is split from the
// effectful executor (reconcile) so the whole diff/filter/cap logic is unit-
// tested against fakes. reconcile runs ONCE per server process (B2 in-process
// idempotence) and re-spawns interrupted sessions the daemon no longer knows
// about. Every drop/skip is logged, never silently swallowed.
//
// Hard rule 3: all agent-specific knowledge (which session ids are resumable,
// where projects live) comes ONLY through the generic provider surfaces
// (scanProjects/listSessions); no store paths or binary names appear here.

import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { configDir, dial } from '../daemon-client';
import { startSession } from '../session-start';
import { getProviders } from './providers/types';
import { derivedWorkspaceParent } from './store/scan';
import { readEntries, removeByPtyId, updateEntry, type LedgerEntry } from './live-ledger';

export interface LivePty {
  ptyId: string;
  cwd: string;
  tmuxName: string | null;
  alive: boolean;
}

export interface ReconcilePlan {
  keepLive: { entry: LedgerEntry; live: LivePty }[]; // matched alive:true (tmux keeps carry the FRESH ptyId)
  removeDead: LedgerEntry[]; // matched alive:false -> drop, never restore (three-state D)
  candidates: LedgerEntry[]; // unknown to the daemon in BOTH lists -> restore candidates
}

// Identity model: holder-tier (tmuxName===null) matches by ptyId; tmux-tier
// matches by tmuxName (ptyId is NOT stable across daemon restarts — rehydrateTmux
// mints a fresh one). cwd/provider is NEVER an identity key.
function matchIn(entry: LedgerEntry, list: LivePty[]): LivePty | undefined {
  return entry.tmuxName === null
    ? list.find((p) => p.ptyId === entry.ptyId)
    : list.find((p) => p.tmuxName === entry.tmuxName);
}

/** PURE. An entry is a candidate only if unmatched in BOTH lists (settle-recheck,
 *  decision 3). A match that is alive:true anywhere -> keepLive (preferring the
 *  freshest/list2 live so tmux keeps carry the current ptyId); matched but dead
 *  everywhere -> removeDead. */
export function planReconcile(entries: LedgerEntry[], list1: LivePty[], list2: LivePty[]): ReconcilePlan {
  const keepLive: ReconcilePlan['keepLive'] = [];
  const removeDead: LedgerEntry[] = [];
  const candidates: LedgerEntry[] = [];

  for (const entry of entries) {
    const m1 = matchIn(entry, list1);
    const m2 = matchIn(entry, list2);
    if (!m1 && !m2) {
      candidates.push(entry);
      continue;
    }
    // Prefer an alive match, and prefer list2 (the freshest picture) so a tmux
    // keep carries the current ptyId for the refresh step.
    const aliveMatch = [m2, m1].find((m) => m && m.alive);
    if (aliveMatch) keepLive.push({ entry, live: aliveMatch });
    else removeDead.push(entry);
  }
  return { keepLive, removeDead, candidates };
}

export interface RestoreDeps {
  dialFn?: typeof dial;
  startSessionFn?: typeof startSession;
  providersFn?: typeof getProviders;
  holdersDir?: string; // default join(configDir(), 'holders')
  pidAlive?: (pid: number) => boolean; // default process.kill(pid, 0)
  statFn?: typeof stat; // injectable: OS errno mapping differs (win32 has no ENOTDIR here)
  now?: () => number;
  settleMs?: number; // default 750; 0 in tests
  maxRestores?: number; // default 10
  recencyMs?: number; // default 48h
}

const DEFAULT_SETTLE_MS = 750;
const DEFAULT_MAX_RESTORES = 10;
const DEFAULT_RECENCY_MS = 48 * 3600_000;

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const log = (msg: string) => console.error(`[seshmux] restore: ${msg}`);
const canon = (cwd: string) => derivedWorkspaceParent(cwd) ?? cwd;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Once-per-process guard (B2). Reset only after a failed run so a later retry is
// allowed; a clean run latches so a second call no-ops.
let didReconcile = false;
export function _resetReconcileForTest(): void {
  didReconcile = false;
}

/** Runs once per server process. Returns the number of sessions restored. */
export async function reconcile(deps: RestoreDeps = {}): Promise<number> {
  if (didReconcile) return 0;
  didReconcile = true;
  try {
    return await runReconcile(deps);
  } catch (e) {
    didReconcile = false; // safe to call again after failure
    throw e;
  }
}

async function runReconcile(deps: RestoreDeps): Promise<number> {
  const dialFn = deps.dialFn ?? dial;
  const startSessionFn = deps.startSessionFn ?? startSession;
  const providersFn = deps.providersFn ?? getProviders;
  const holdersDir = deps.holdersDir ?? path.join(configDir(), 'holders');
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const statFn = deps.statFn ?? stat;
  const now = deps.now ?? (() => Date.now());
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
  const maxRestores = deps.maxRestores ?? DEFAULT_MAX_RESTORES;
  const recencyMs = deps.recencyMs ?? DEFAULT_RECENCY_MS;

  const entries = await readEntries();
  if (entries.length === 0) return 0;

  // 1. Settle-recheck: two lists ~settleMs apart absorb the daemon's holder/tmux
  //    re-adoption window (decision 3).
  const conn = await dialFn();
  let list1: LivePty[];
  let list2: LivePty[];
  try {
    list1 = toLive(await conn.list());
    await sleep(settleMs);
    list2 = toLive(await conn.list());
  } finally {
    conn.close();
  }

  const plan = planReconcile(entries, list1, list2);

  // 2. tmux keepLive refresh: rebind the ledger ptyId to the live one so the
  //    Stage 3 exit-removal (keyed by ptyId) keeps working after a daemon restart.
  for (const { entry, live } of plan.keepLive) {
    if (entry.tmuxName !== null && live.ptyId !== entry.ptyId) {
      await updateEntry(entry.ptyId, { ptyId: live.ptyId });
    }
  }

  // 3. removeDead: matched-but-dead entries are gone for good (edge D).
  for (const entry of plan.removeDead) {
    await removeByPtyId(entry.ptyId);
    log(`dropping dead entry ${entry.ptyId} (${entry.cwd})`);
  }

  // 4. Filter candidates, in order, logging every drop/skip.
  const seenSessionIds = new Set<string>(); // B2: accepted ids this run
  const survivors: LedgerEntry[] = [];
  for (const entry of plan.candidates) {
    // a. B3 — nothing durable to resume.
    if (!entry.sessionId) {
      await removeByPtyId(entry.ptyId);
      log(`dropping ${entry.ptyId}: no sessionId (unbound session)`);
      continue;
    }
    // b. B2 — a sessionId already accepted this run (kept in the ledger; the
    //    winning entry already covers it).
    if (seenSessionIds.has(entry.sessionId)) {
      log(`skipping ${entry.ptyId}: duplicate sessionId ${entry.sessionId} already restored this run`);
      continue;
    }
    // c. C2 cwd check — rule 7 fail-closed. ENOENT deletes; any other error
    //    skips-and-keeps (a transient failure must not delete the record).
    let cwdOk = false;
    try {
      cwdOk = (await statFn(entry.cwd)).isDirectory();
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        await removeByPtyId(entry.ptyId);
        log(`dropping ${entry.ptyId}: cwd gone (${entry.cwd})`);
      } else {
        log(`skipping ${entry.ptyId}: cwd stat failed (${e?.code ?? e}) — keeping (${entry.cwd})`);
      }
      continue;
    }
    if (!cwdOk) {
      log(`skipping ${entry.ptyId}: cwd is not a directory — keeping (${entry.cwd})`);
      continue;
    }
    // d. Edge E — a wedged holder still owns this PTY; don't double-spawn, keep
    //    the entry so a later re-adoption can recover it.
    if (entry.tmuxName === null && (await holderAlive(holdersDir, entry.ptyId, pidAlive))) {
      log(`skipping ${entry.ptyId}: holder json reports a live pid — keeping`);
      continue;
    }
    // e. Resumable + recency (48h) via generic provider surfaces only (rule 3).
    const verdict = await resumability(providersFn, entry, now(), recencyMs);
    if (verdict !== 'ok') {
      await removeByPtyId(entry.ptyId);
      log(`dropping ${entry.ptyId}: ${verdict} (${entry.sessionId})`);
      continue;
    }
    seenSessionIds.add(entry.sessionId);
    survivors.push(entry);
  }

  // f. Volume cap — newest startedAt first; excess kept in the ledger for a
  //    later boot (still within recency).
  survivors.sort((a, b) => b.startedAt - a.startedAt);
  const toRestore = survivors.slice(0, maxRestores);
  for (const entry of survivors.slice(maxRestores)) {
    log(`skipping ${entry.ptyId}: over the ${maxRestores}-restore cap — keeping for next boot`);
  }

  // 5. Execute sequentially (F1 stagger). One writer creates entries
  //    (startSession's own addEntry), so on success we just drop the OLD entry.
  let restored = 0;
  for (const entry of toRestore) {
    try {
      await startSessionFn({ projectPath: entry.cwd, provider: entry.provider, resumeId: entry.sessionId });
      await removeByPtyId(entry.ptyId); // the spawn's addEntry stands under the new ptyId
      restored++;
    } catch (e) {
      await removeByPtyId(entry.ptyId); // never loop-retry a failing spawn every boot
      log(`spawn failed for ${entry.ptyId} (${entry.sessionId}): ${e instanceof Error ? e.message : e}`);
    }
  }

  return restored;
}

function toLive(r: { ptys: { ptyId: string; cwd: string; tmuxName: string | null; alive: boolean }[] }): LivePty[] {
  return r.ptys.map((p) => ({ ptyId: p.ptyId, cwd: p.cwd, tmuxName: p.tmuxName, alive: p.alive }));
}

// Edge E: read seshmux's OWN holder json (rule 3 untouched — these are our files,
// not agent files). Unreadable/garbage json = no evidence of a live holder.
async function holderAlive(
  holdersDir: string,
  ptyId: string,
  pidAlive: (pid: number) => boolean,
): Promise<boolean> {
  try {
    const raw = await readFile(path.join(holdersDir, `${ptyId}.json`), 'utf8');
    const j = JSON.parse(raw);
    return typeof j?.pid === 'number' && pidAlive(j.pid);
  } catch {
    return false;
  }
}

// 'ok' | reason string. Resumable = provider has a non-missing project at the
// entry's canonical cwd AND a session with the entry's id whose mtime is recent.
async function resumability(
  providersFn: typeof getProviders,
  entry: LedgerEntry,
  nowMs: number,
  recencyMs: number,
): Promise<'ok' | string> {
  const providers = await providersFn();
  const provider = providers.find((p) => p.id === entry.provider);
  if (!provider) return 'no such provider';
  const wantPath = canon(entry.cwd);
  const projects = await provider.scanProjects();
  const project = projects.find((p) => p.path === wantPath && !p.missing);
  if (!project) return 'project missing/unscannable';
  const sessions = await provider.listSessions(project.id);
  const session = sessions.find((s) => s.id === entry.sessionId);
  if (!session) return 'session not resumable';
  if (nowMs - session.mtime > recencyMs) return 'session stale (>48h)';
  return 'ok';
}

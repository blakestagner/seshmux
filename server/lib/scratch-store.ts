// Scratch-terminal association map: which daemon PTYs are scratch shells, and
// which agent session each belongs to. Keyed by the SCRATCH pty id; the record
// carries its owner (ptyId + tmux name) and the cwd it was spawned in. Typed API
// over json-store (atomicity + serialized writes come from there), exactly like
// live-ledger.ts — separate data file (`scratch-terminals.json`), same helper.
//
// The map is the single source of truth for "is this pty a scratch": the events
// hub reads scratchPtyIds() to exclude shells from status classification, and
// getLive() reads it to skip session-enrichment for a rehydrated shell.

import path from 'node:path';
import { configDir } from '../daemon-client';
import { createJsonStore, type JsonStore } from './json-store';

export interface ScratchRecord {
  ownerPtyId: string; // agent PTY this shell belongs to (refreshed on tmux rematch)
  ownerTmuxName: string | null; // owner's tmux name (list() form incl. seshmux- prefix), or null
  cwd: string; // worktree-correct cwd the shell was spawned in
  createdAt: number;
}
export type ScratchMap = Record<string, ScratchRecord>; // key: scratchPtyId

const empty = (): ScratchMap => ({});

export function scratchStorePath(): string {
  return path.join(configDir(), 'scratch-terminals.json');
}

// One memoized store per process, keyed by path so a test that repoints
// SESHMUX_CONFIG_DIR (via _resetScratchStoreForTest) rebuilds against the new dir.
let store: JsonStore<ScratchMap> | null = null;
function getStore(): JsonStore<ScratchMap> {
  if (!store) store = createJsonStore<ScratchMap>(scratchStorePath(), empty);
  return store;
}

export async function readScratchMap(): Promise<ScratchMap> {
  return getStore().read();
}

export async function addScratch(scratchPtyId: string, rec: ScratchRecord): Promise<void> {
  await getStore().update((cur) => ({ ...cur, [scratchPtyId]: rec }));
}

export async function removeScratch(scratchPtyId: string): Promise<void> {
  await getStore().update((cur) => {
    if (!(scratchPtyId in cur)) return cur;
    const next = { ...cur };
    delete next[scratchPtyId];
    return next;
  });
}

/** Patch one record in place, matched by its scratch ptyId. No-op if absent.
 *  Used by the orphan sweep to refresh a tmux owner's ptyId after a daemon restart. */
export async function updateScratch(scratchPtyId: string, patch: Partial<ScratchRecord>): Promise<void> {
  await getStore().update((cur) => {
    const rec = cur[scratchPtyId];
    if (!rec) return cur;
    return { ...cur, [scratchPtyId]: { ...rec, ...patch } };
  });
}

/** The set of scratch pty ids — the events-hub classifier skip-set source. */
export async function scratchPtyIds(): Promise<Set<string>> {
  return new Set(Object.keys(await getStore().read()));
}

/** The existing scratch for an owner, matched by ptyId first, then tmux name (a
 *  tmux owner gets a fresh ptyId from rehydrateTmux across a daemon restart, so
 *  ptyId alone would miss it). Null if the owner has no scratch. */
export async function findByOwner(
  ownerPtyId: string,
  ownerTmuxName: string | null,
): Promise<string | null> {
  const map = await getStore().read();
  for (const [scratchPtyId, rec] of Object.entries(map)) {
    if (rec.ownerPtyId === ownerPtyId) return scratchPtyId;
    if (ownerTmuxName && rec.ownerTmuxName === ownerTmuxName) return scratchPtyId;
  }
  return null;
}

// Test hook: drop the memoized store so a test can repoint SESHMUX_CONFIG_DIR
// (same idiom as _resetLedgerForTest()).
export function _resetScratchStoreForTest(): void {
  store = null;
}

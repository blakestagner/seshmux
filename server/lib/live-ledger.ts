// Live-session ledger: the durable record of which agent PTYs seshmux believes
// are alive, used at startup to reconcile survivors vs. losses and auto-restore
// the interrupted ones. Typed API over json-store (atomicity + serialized writes
// come from there). Versioned envelope so a future shape change can migrate.

import path from 'node:path';
import { configDir } from '../daemon-client';
import { createJsonStore, type JsonStore } from './json-store';
import type { ProviderId } from './providers/types';

export interface LedgerEntry {
  ptyId: string; // holder-tier identity key; refreshed on restore/tmux-rematch
  tmuxName: string | null; // tmux-tier identity key (bare daemon value incl. seshmux- prefix as list() reports it)
  provider: ProviderId;
  cwd: string;
  label?: string; // display only (basename(cwd)); never identity
  startedAt: number;
  sessionId?: string; // absent at spawn for new/plan/continue; filled by §1a binding
}

interface Ledger {
  v: 1;
  entries: LedgerEntry[];
}

const empty = (): Ledger => ({ v: 1, entries: [] });

export function ledgerPath(): string {
  return path.join(configDir(), 'live-sessions.json');
}

// One memoized store per process. Keyed by path so a test that repoints
// SESHMUX_CONFIG_DIR (via _resetLedgerForTest) rebuilds against the new dir.
let store: JsonStore<Ledger> | null = null;
function getStore(): JsonStore<Ledger> {
  if (!store) store = createJsonStore<Ledger>(ledgerPath(), empty);
  return store;
}

export async function addEntry(e: LedgerEntry): Promise<void> {
  await getStore().update((cur) => ({ ...cur, entries: [...cur.entries, e] }));
}

export async function removeByPtyId(ptyId: string): Promise<void> {
  await getStore().update((cur) => ({ ...cur, entries: cur.entries.filter((e) => e.ptyId !== ptyId) }));
}

export async function readEntries(): Promise<LedgerEntry[]> {
  return (await getStore().read()).entries;
}

/** Rewrite one entry in place, matched by its CURRENT ptyId (restore rewrite +
 *  tmux ptyId refresh). No-op if absent. */
export async function updateEntry(ptyId: string, patch: Partial<LedgerEntry>): Promise<void> {
  await getStore().update((cur) => ({
    ...cur,
    entries: cur.entries.map((e) => (e.ptyId === ptyId ? { ...e, ...patch } : e)),
  }));
}

/** §1a PURE bind rule, exported for unit tests: newest (max startedAt) entry
 *  with matching provider + canonical cwd and NO sessionId, or null. */
export function pickBindTarget(
  entries: LedgerEntry[],
  provider: ProviderId,
  canonicalCwd: string,
  canon: (cwd: string) => string,
): LedgerEntry | null {
  let best: LedgerEntry | null = null;
  for (const e of entries) {
    if (e.sessionId) continue;
    if (e.provider !== provider) continue;
    if (canon(e.cwd) !== canonicalCwd) continue;
    if (!best || e.startedAt > best.startedAt) best = e;
  }
  return best;
}

/** §1a effectful bind: writes sessionId into the picked entry. Skips (no-op)
 *  when nothing matches or the id is already bound to some entry (idempotent
 *  across session-touch storms). Returns whether a bind happened. */
export async function bindSessionId(
  provider: ProviderId,
  canonicalCwd: string,
  sessionId: string,
  canon: (cwd: string) => string,
): Promise<boolean> {
  let bound = false;
  await getStore().update((cur) => {
    bound = false;
    // Already bound to this id (a session-touch after session-new): no-op.
    if (cur.entries.some((e) => e.sessionId === sessionId)) return cur;
    const target = pickBindTarget(cur.entries, provider, canonicalCwd, canon);
    if (!target) return cur;
    bound = true;
    return {
      ...cur,
      entries: cur.entries.map((e) => (e === target ? { ...e, sessionId } : e)),
    };
  });
  return bound;
}

// Test hook: drop the memoized store so a test can repoint SESHMUX_CONFIG_DIR
// (same idiom as _resetProviders()).
export function _resetLedgerForTest(): void {
  store = null;
}

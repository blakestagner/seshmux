// Codex plan rate limits.
//
// SCHEMA DISCOVERY (real ~/.codex/sessions files on this machine, 2026-08-21; 1476 bucket
// samples across 11 rollouts spanning CLI versions — hard rule 6, nothing here is guessed):
//
//   {"type":"event_msg","payload":{"type":"token_count","rate_limits":{
//      "primary":   {"used_percent":8.0,"window_minutes":10080,"resets_at":1786466734},
//      "secondary": null,
//      "credits":{...}, "plan_type":"plus", ...}}}
//
// Two facts that drive the whole design:
//
//  1. SLOT NAMES ARE NOT STABLE. 579 samples had primary=300min (5h) + secondary=10080min
//     (weekly); 318 samples had primary=10080min + secondary=null. Reading "primary" as
//     "the 5-hour window" would report the weekly number as the session number on newer
//     CLIs. Buckets are therefore classified by `window_minutes`, never by slot name.
//     Sibling keys vary too (older events lack limit_id/individual_limit/
//     spend_control_reached), so only the three bucket fields are relied on — those were
//     present in 1476/1476 samples: used_percent, window_minutes, resets_at (unix seconds).
//
//  2. THIS IS A SNAPSHOT, NOT A LIVE READING. Unlike Claude — which we query live — Codex
//     only writes these numbers while it is running. The newest sample on this machine was
//     two weeks old and its window had long since reset, so rendering it would have shown
//     "8% used" for a window that no longer exists. An expired bucket is therefore dropped
//     rather than shown or zeroed: we know the old number is wrong, and we do not know the
//     new one. `capturedAt` carries the snapshot age so the UI can caveat what it shows.

import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageMeter } from './limits-types';

// token_count events fire every turn and cluster at the end of a rollout; the last 512KB
// has covered the final event in every file sampled. Bounded so a giant rollout can't be
// buffered whole (same discipline as store/transcript's tail reads).
const TAIL_BYTES = 512 * 1024;
// How many rollouts back to look before giving up. A rollout written by an old CLI can
// carry no rate_limits at all, so "newest file" alone is not enough — but scanning deep is
// pointless, since anything older is even likelier to have expired.
const MAX_FILES = 5;

export type CodexLimits = {
  meters: UsageMeter[];
  /** ISO timestamp of the rollout event these numbers came from. */
  capturedAt: string;
};

function codexSessionsRoot(homeDir: string): string {
  return join(homeDir, '.codex', 'sessions');
}

// Store layout is sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl. Descending numeric dirs
// find the newest rollouts without walking the whole tree — a heavy user has thousands of
// files and only the last handful can possibly hold a live window.
async function newestRollouts(root: string, limit: number): Promise<string[]> {
  async function descend(dir: string, depth: number): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    if (depth === 0) {
      return entries
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => e.name)
        .sort()
        .reverse() // filenames lead with the ISO timestamp, so lexicographic desc = newest
        .map((n) => join(dir, n));
    }
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
    const out: string[] = [];
    for (const d of dirs) {
      out.push(...(await descend(join(dir, d), depth - 1)));
      if (out.length >= limit) break;
    }
    return out;
  }
  return (await descend(root, 3)).slice(0, limit);
}

async function tail(filePath: string): Promise<string> {
  const { size } = await stat(filePath);
  const start = Math.max(0, size - TAIL_BYTES);
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // A non-zero offset almost certainly lands mid-line; that fragment isn't parseable.
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } finally {
    await fh.close();
  }
}

// used_percent / window_minutes / resets_at were present in every sampled bucket, but a
// null bucket is normal (secondary is null on newer CLIs) and a partial one is cheap to
// tolerate. `nowMs` decides expiry: resets_at is unix SECONDS.
function toMeter(raw: unknown, nowMs: number): UsageMeter | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown };
  if (typeof b.used_percent !== 'number' || !Number.isFinite(b.used_percent)) return null;
  if (typeof b.window_minutes !== 'number' || b.window_minutes <= 0) return null;
  // Expired window: the snapshot describes a period that has already rolled over. See the
  // header — dropping is the only honest option.
  const resetsMs = typeof b.resets_at === 'number' ? b.resets_at * 1000 : null;
  if (resetsMs !== null && resetsMs <= nowMs) return null;
  return {
    windowMinutes: b.window_minutes,
    pct: Math.max(0, Math.min(100, b.used_percent)),
    resetsAt: resetsMs === null ? null : new Date(resetsMs).toISOString(),
  };
}

// Scans backwards for the newest token_count carrying rate_limits.
function limitsFromTail(text: string, nowMs: number): CodexLimits | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('rate_limits') === -1) continue;
    let obj: { timestamp?: unknown; payload?: { rate_limits?: Record<string, unknown> } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // torn line — keep walking back
    }
    const rl = obj.payload?.rate_limits;
    if (!rl) continue;
    // Both slots, classified by window rather than by name (see header fact 1).
    const meters = [toMeter(rl.primary, nowMs), toMeter(rl.secondary, nowMs)].filter(
      (m): m is UsageMeter => m !== null,
    );
    // All windows expired. Stop scanning THIS file: earlier events in it are strictly
    // staler, so they can only be more expired. The caller still tries the next rollout —
    // a slightly older file can carry a weekly window that is genuinely still open.
    if (meters.length === 0) return null;
    meters.sort((a, b2) => a.windowMinutes - b2.windowMinutes); // short window first
    const ts = typeof obj.timestamp === 'string' ? obj.timestamp : new Date(nowMs).toISOString();
    return { meters, capturedAt: ts };
  }
  return null;
}

// Memoised for the same reason the Claude reader is: every open tab polls this, and a cold
// read is a directory walk plus a 512KB tail per rollout examined. Codex only rewrites
// these numbers when it takes a turn, so a minute of staleness costs nothing.
const TTL_MS = 60_000;
type Cached = { at: number; homeDir: string; value: CodexLimits | null };
let cache: Cached | null = null;
let inFlight: { homeDir: string; p: Promise<CodexLimits | null> } | null = null;

/** Test seam — drops the memo so a test can control what the next call sees. */
export function resetCodexLimitCache(): void {
  cache = null;
  inFlight = null;
}

/**
 * Latest known Codex plan utilization, or null when there is nothing current to show
 * (no rollouts, a CLI too old to record rate_limits, or every window already reset).
 */
export async function readCodexRateLimits(
  opts: { homeDir?: string; now?: number } = {},
): Promise<CodexLimits | null> {
  const nowMs = opts.now ?? Date.now();
  const homeDir = opts.homeDir ?? homedir();
  // homeDir is part of the key: a different home is a different account, and serving one
  // account's percentages for another would be silently wrong rather than just stale.
  if (cache && cache.homeDir === homeDir && nowMs - cache.at < TTL_MS) return cache.value;
  if (inFlight?.homeDir === homeDir) return inFlight.p;

  const p = scan(homeDir, nowMs)
    .then((value) => {
      cache = { at: nowMs, homeDir, value };
      return value;
    })
    .finally(() => {
      if (inFlight?.p === p) inFlight = null;
    });
  inFlight = { homeDir, p };
  return p;
}

async function scan(homeDir: string, nowMs: number): Promise<CodexLimits | null> {
  const files = await newestRollouts(codexSessionsRoot(homeDir), MAX_FILES);
  for (const f of files) {
    try {
      const found = limitsFromTail(await tail(f), nowMs);
      if (found) return found;
    } catch {
      // Unreadable/racing rollout — try the next newest.
    }
  }
  return null;
}

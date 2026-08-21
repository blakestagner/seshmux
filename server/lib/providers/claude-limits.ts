// Claude Code subscription rate limits — the same numbers the TUI's `/usage` screen shows.
//
// Lives under providers/ because it touches the `~/.claude` credential file and the
// `claude` OAuth token (hard rule 3). Nothing else in the tree may read either.
//
// Source: Claude Code authenticates with an OAuth token and reads utilization from
// GET https://api.anthropic.com/api/oauth/usage. There is no local cache of these
// numbers on disk — the percentages are computed server-side against a per-plan
// allowance we cannot see — so this is the only way to report them.
//
// Credential storage differs by platform: macOS keeps the JSON blob in the login
// keychain under the "Claude Code-credentials" service; every other platform writes
// ~/.claude/.credentials.json. Both hold the same shape:
//   { claudeAiOauth: { accessToken, expiresAt, ... } }

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { UsageMeter } from './limits-types';

const exec = promisify(execFile);

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const OAUTH_BETA = 'oauth-2025-04-20';

// The bar is polled by every open tab; the underlying numbers move on the order of
// minutes. One upstream call per minute per server is plenty.
const TTL_MS = 60_000;
// A missing/expired credential is not going to fix itself in a minute, and shelling out
// to `security` pops a keychain prompt on a locked keychain — back off harder on failure.
const FAIL_TTL_MS = 5 * 60_000;

// Upstream names its buckets rather than reporting a window length, so the mapping to
// window minutes lives here — this module is the only thing that knows what Anthropic
// means by "five_hour". Order is the render order: shortest window first.
const BUCKETS: { key: string; windowMinutes: number; scope?: 'opus' }[] = [
  { key: 'five_hour', windowMinutes: 300 },
  { key: 'seven_day', windowMinutes: 10_080 },
  { key: 'seven_day_opus', windowMinutes: 10_080, scope: 'opus' },
];

export type ClaudeRateLimits = { meters: UsageMeter[] };

type Cached = { at: number; homeDir: string; value: ClaudeRateLimits | null };
let cache: Cached | null = null;
// Single-flight. Every open tab polls this endpoint, so a cold cache would otherwise fan
// one page load out into N upstream calls — and N `security` subprocesses with it.
// Keyed by homeDir for the same reason the cache is — sharing one flight across two homes
// would hand an account's numbers to the other.
let inFlight: { homeDir: string; p: Promise<ClaudeRateLimits | null> } | null = null;

/** Test seam — drops the memo so a test can control what the next call sees. */
export function resetRateLimitCache(): void {
  cache = null;
  inFlight = null;
}

async function readAccessToken(homeDir: string): Promise<string | null> {
  // File first even on macOS. It is the canonical store everywhere except macOS, where it
  // simply doesn't exist and we fall through to the keychain — so the order costs one
  // failed stat there, and in exchange tests can point homeDir at a fixture without ever
  // shelling out to `security` (which can block on a locked keychain).
  try {
    const tok = tokenFromBlob(await readFile(join(homeDir, '.claude', '.credentials.json'), 'utf8'));
    if (tok) return tok;
  } catch {
    // No file — expected on macOS.
  }
  if (process.platform !== 'darwin') return null;
  try {
    // Hard timeout: on a locked keychain `security -w` puts up an unlock prompt and blocks
    // until someone answers it. Without this the request never settles, the cache never
    // fills, and every 90s poll from every tab stacks another blocked subprocess.
    const { stdout } = await exec('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      timeout: 5000,
    });
    return tokenFromBlob(stdout);
  } catch {
    // Not in the keychain, or the keychain is locked — no meter.
    return null;
  }
}

/** Exported for tests — the same blob shape comes back from the file and the keychain. */
export function tokenFromBlob(raw: string): string | null {
  try {
    const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    return typeof tok === 'string' && tok.length > 0 ? tok : null;
  } catch {
    return null;
  }
}

// Upstream buckets are `{ utilization: number, resets_at: string }`. Tolerate a missing
// bucket (plan-dependent — seven_day_opus is null on Pro) and a missing resets_at rather
// than throwing the whole read away.
function toMeter(raw: unknown, windowMinutes: number, scope?: 'opus'): UsageMeter | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = (raw as { utilization?: unknown }).utilization;
  if (typeof u !== 'number' || !Number.isFinite(u)) return null;
  const r = (raw as { resets_at?: unknown }).resets_at;
  return {
    windowMinutes,
    pct: Math.max(0, Math.min(100, u)),
    resetsAt: typeof r === 'string' ? r : null,
    ...(scope ? { scope } : {}),
  };
}

/**
 * Current subscription utilization, or null when it can't be determined (not logged in,
 * API-key auth rather than a subscription, offline, upstream shape changed). Callers treat
 * null as "hide the meter" — this is decoration, never an error the user has to dismiss.
 */
export async function readClaudeRateLimits(
  opts: { homeDir?: string; now?: number } = {},
): Promise<ClaudeRateLimits | null> {
  const now = opts.now ?? Date.now();
  const homeDir = opts.homeDir ?? homedir();
  // homeDir is part of the key: a different home is a different account, and serving a
  // cached percentage from the wrong one would be silently wrong rather than just stale.
  if (cache && cache.homeDir === homeDir && now - cache.at < (cache.value ? TTL_MS : FAIL_TTL_MS)) {
    return cache.value;
  }
  if (inFlight?.homeDir === homeDir) return inFlight.p;

  const p = fetchLimits(homeDir)
    .then((value) => {
      cache = { at: now, homeDir, value };
      return value;
    })
    .finally(() => {
      if (inFlight?.p === p) inFlight = null;
    });
  inFlight = { homeDir, p };
  return p;
}

async function fetchLimits(homeDir: string): Promise<ClaudeRateLimits | null> {
  const token = await readAccessToken(homeDir);
  if (!token) return null;
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const meters = BUCKETS.map((b) => toMeter(body[b.key], b.windowMinutes, b.scope)).filter(
      (m): m is UsageMeter => m !== null,
    );
    // Nothing recognised means a 200 with a shape we don't understand — report nothing
    // rather than painting empty bars.
    return meters.length > 0 ? { meters } : null;
  } catch {
    return null;
  }
}

// The two operations every surface performs: recall (query -> budgeted pack) and remember
// (agent- or user-authored fact -> record).
//
// Deliberately disk-only and dependency-free of the web server, because the mcp-bridge runs
// as a SEPARATE process with no web auth token. This is the peek.ts precedent — "self
// contained, no server process needed" — and it means an agent's recall keeps working while
// the server is restarting, which for an update-safety-obsessed app is the right default.
//
// Both surfaces call through here so the MCP tool and the statusbar dropdown cannot drift:
// same filters, same ranking, same envelope, same hit accounting.

import { effectiveScope, rankWithTotal } from './rank';
import { pack, type PackOpts } from './pack';
import { appendOverlay, appendRecords, contentId, readAllRecords, sanitizeText } from './store';
import {
  MEMORY_SCHEMA,
  type MemoryKind,
  type MemoryOverlayOp,
  type MemoryPack,
  type MemoryQuery,
  type MemoryRecord,
  type RankedRecord,
} from './types';
import type { ProviderId } from '../store/scan';

export interface RecallOpts extends PackOpts {
  now?: number;
  /**
   * Record that these results were returned, which feeds the usage boost in ranking.
   * Off for UI browsing: idly scrolling a list is not evidence that a record was useful.
   */
  countHits?: boolean;
}

export interface RecallResult extends MemoryPack {
  ranked: RankedRecord[];
}

// Derived from the SAME helper the filter uses, so the envelope can never claim a scope
// the query did not actually run under.
function scopeLabel(q: MemoryQuery): string {
  return effectiveScope(q) === 'all' ? 'all repos' : 'this repo';
}

export async function recall(q: MemoryQuery, opts: RecallOpts = {}): Promise<RecallResult> {
  const now = opts.now ?? Date.now();
  const records = await readAllRecords();
  const { ranked, total } = rankWithTotal(records, q, { now });
  const packed = pack(ranked, {
    budgetTokens: opts.budgetTokens,
    totalMatches: total,
    scopeLabel: opts.scopeLabel ?? scopeLabel(q),
  });

  if (opts.countHits && packed.records.length) {
    await appendOverlay(packed.records.map((r): MemoryOverlayOp => ({ op: 'hit', id: r.id, at: now })));
  }

  return { ...packed, ranked };
}

export interface RememberInput {
  text: string;
  kind: MemoryKind;
  key?: string;
  files?: string[];
  pin?: boolean;
  scope: { projectId: string; repo: string; branch?: string | null };
  origin: { provider: ProviderId; sessionId: string };
}

export interface RememberResult {
  record: MemoryRecord | null;
  superseded: string[];
  /** Set when the write was rejected or was a no-op, for the caller to report honestly. */
  note?: string;
}

/**
 * Write one fact.
 *
 * Restricted to `decision` and `lesson`: the deterministic kinds are the harvester's output
 * and describe observed events. Letting a caller mint a synthetic "error" or "tool-call"
 * would put fabricated history alongside the real record of what happened, which is exactly
 * the kind of thing a later agent would have no way to tell apart.
 */
export async function remember(input: RememberInput, opts: { now?: number } = {}): Promise<RememberResult> {
  const now = opts.now ?? Date.now();
  if (input.kind !== 'decision' && input.kind !== 'lesson') {
    return { record: null, superseded: [], note: 'only decision and lesson may be written directly' };
  }

  const text = sanitizeText(input.text);
  if (text.length < 3) return { record: null, superseded: [], note: 'text is empty' };

  const key =
    (input.key ?? text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'note';

  // Project-scoped, so writing the same fact twice — from two sessions, or from an agent
  // and then from the UI — is one record rather than a chain of self-supersessions.
  const id = contentId({ kind: input.kind, text, scope: input.scope.projectId, target: key });
  const all = await readAllRecords();

  const prior = all.filter(
    (r) => r.key === key && r.scope.projectId === input.scope.projectId && !r.supersededBy && r.id !== id,
  );
  if (all.some((r) => r.id === id)) {
    return { record: null, superseded: [], note: 'already remembered' };
  }

  const record: MemoryRecord = {
    v: MEMORY_SCHEMA,
    id,
    kind: input.kind,
    text,
    key,
    scope: {
      projectId: input.scope.projectId,
      repo: input.scope.repo,
      branch: input.scope.branch ?? null,
    },
    origin: { provider: input.origin.provider, sessionId: input.origin.sessionId, ts: now },
    entities: { files: (input.files ?? []).map((f) => f.replace(/\\/g, '/')).slice(0, 20), commands: [], symbols: [] },
    validFrom: now,
    pinned: input.pin || undefined,
    hits: 0,
    lastHit: 0,
  };

  await appendRecords([record]);
  const overlay = prior.map((r): MemoryOverlayOp => ({ op: 'supersede', id: r.id, at: now, by: id }));
  await appendOverlay(overlay);

  return { record, superseded: prior.map((r) => r.id) };
}

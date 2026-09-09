// Multi-strategy retrieval over the memory corpus. PURE — records in, ranked records out.
//
// Three independent strategies run over the same filtered candidate set and are fused with
// reciprocal-rank fusion. Each exists because it catches something the others miss:
//
//   BM25       general relevance, and the only one that handles a natural-language question.
//   exact      literal substrings BM25 tokenizes away — `--permission-mode`, `.next/standalone`,
//              a quoted error string. This is the terminology-mismatch case that makes any
//              single-strategy retriever brittle.
//   entity     a query naming a file or command pulls that file's records even when the
//              wording shares no vocabulary with them at all.
//
// RRF rather than a weighted score sum: the three strategies produce scores on
// incomparable scales (a BM25 score and "contains the substring" have no common unit), and
// rank fusion needs no calibration and no tuning constant per strategy. The one constant it
// does have, K, only controls how much a top-1 in one strategy outweighs a top-3 in another.

import { bm25, fileKeys, getIndex, tokenize } from './index';
import type { MemoryQuery, MemoryRecord, MemoryScopeMode, RankedRecord } from './types';

const RRF_K = 60; // the conventional value; larger flattens the fusion, smaller sharpens it

/** Half-life for the recency tilt. Old memory stays reachable, it just stops leading. */
const HALF_LIFE_DAYS = 45;

export interface RankOpts {
  now?: number;
  /** How many ranked records to return before the pack budget cuts further. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * The scope a query actually runs under.
 *
 * Repo-first when there is a repo to be first about. The distinction matters because
 * "scope defaults to project" plus "projectId is optional" used to combine into: an
 * un-scoped query silently searched EVERY repo while `pack` stamped the envelope
 * "this repo". Two different callers then disagreed about what one query meant.
 *
 * - explicit scope wins;
 * - no scope + a projectId → 'project' (the repo-first default);
 * - no scope + no projectId → 'all', because there is nothing to scope BY and searching
 *   everything is the honest reading;
 * - explicit 'project' + no projectId → 'project', which matches nothing. That is a caller
 *   error, and matching nothing is far safer than silently widening. (`GET /api/memory`
 *   rejects it before it gets here.)
 *
 * Exported so the label and the filter can never be computed differently.
 */
export function effectiveScope(q: MemoryQuery): MemoryScopeMode {
  if (q.scope) return q.scope;
  return q.projectId ? 'project' : 'all';
}

/**
 * Candidate docs after the hard filters. Always a set — every query has at least the
 * supersession rule to apply, so there is no "everything" fast path worth branching for.
 */
export function candidates(records: MemoryRecord[], q: MemoryQuery): Set<number> {
  const scope = effectiveScope(q);
  const wantFile = q.file ? q.file.replace(/\\/g, '/').toLowerCase() : null;
  const out = new Set<number>();

  if (scope === 'project' && !q.projectId) return out;

  records.forEach((r, i) => {
    if (scope === 'project' && r.scope.projectId !== q.projectId) return;
    if (q.kind?.length && !q.kind.includes(r.kind)) return;
    if (q.provider && r.origin.provider !== q.provider) return;
    if (q.since && r.origin.ts < q.since) return;
    if (wantFile && !r.entities.files.some((f) => f.replace(/\\/g, '/').toLowerCase().includes(wantFile))) return;

    // Superseded records are history, not current belief. They stay reachable only through
    // an explicit asOf, which is what makes "what did I think in July" answerable at all.
    if (r.supersededBy) {
      if (!q.asOf) return;
      if (r.validFrom > q.asOf) return;
    } else if (q.asOf && r.validFrom > q.asOf) {
      return;
    }

    out.add(i);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/** Quoted phrases are treated as literals; the rest of the query contributes its words. */
export function exactNeedles(query: string): string[] {
  const needles: string[] = [];
  let rest = query;
  for (const m of query.matchAll(/"([^"]{2,})"/g)) {
    needles.push(m[1].toLowerCase());
    rest = rest.replace(m[0], ' ');
  }
  for (const word of rest.split(/\s+/)) {
    const w = word.trim().toLowerCase();
    // Only words a tokenizer would mangle are worth an exact pass: flags, paths, dotted
    // names. A plain word is BM25's job and would only add noise here.
    if (w.length >= 3 && /[-/\\._]/.test(w)) needles.push(w);
  }
  return [...new Set(needles)];
}

function rankOf(scores: Map<number, number>): Map<number, number> {
  const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const ranks = new Map<number, number>();
  ordered.forEach(([doc], i) => ranks.set(doc, i + 1));
  return ranks;
}

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

/**
 * Post-fusion tilt. Multiplicative on the fused score, so it reorders within the relevant
 * set without ever promoting an irrelevant record above a relevant one.
 */
export function modifier(r: MemoryRecord, now: number): number {
  const ageDays = Math.max(0, (now - r.origin.ts) / 86_400_000);
  const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  const pinned = r.pinned ? 2 : 1;
  // Usage is evidence: a record that keeps getting recalled keeps earning its place. Damped
  // so a handful of hits cannot bury a better, newer match.
  const used = 1 + Math.log1p(r.hits ?? 0) / 4;
  const kind = r.kind === 'lesson' || r.kind === 'decision' ? 1.5 : r.kind === 'error' ? 1.2 : 1;
  return 0.4 + 0.6 * recency * pinned * used * kind;
}

// ---------------------------------------------------------------------------
// rank
// ---------------------------------------------------------------------------

/**
 * Ranked results PLUS how many candidates there were before the limit cut.
 *
 * The count has to come from here: computing it from rank()'s return value can never exceed
 * the limit, and both the pack footer ("N more matches not shown; narrow your query") and
 * the dropdown's match count are read as the size of the whole result set. The MCP tool
 * description tells the agent to trust that number, so it must be true.
 */
export function rankWithTotal(
  records: MemoryRecord[],
  q: MemoryQuery,
  opts: RankOpts = {},
): { ranked: RankedRecord[]; total: number } {
  const all = rankAll(records, q, opts);
  const limit = q.limit ?? opts.limit ?? 50;
  return { ranked: all.slice(0, limit), total: all.length };
}

export function rank(records: MemoryRecord[], q: MemoryQuery, opts: RankOpts = {}): RankedRecord[] {
  return rankWithTotal(records, q, opts).ranked;
}

/** Every candidate, ordered. The limit is applied by the callers above. */
function rankAll(records: MemoryRecord[], q: MemoryQuery, opts: RankOpts = {}): RankedRecord[] {
  const now = opts.now ?? Date.now();
  const allowed = candidates(records, q);
  if (allowed.size === 0) return [];

  const index = getIndex(records);
  const query = (q.query ?? '').trim();

  // An empty query is the dropdown's opening state, not an error: rank by standing value
  // alone so it opens on something useful rather than a blank list.
  //
  // Pinned records lead ABSOLUTELY here, not merely with a boost. Pinning is the user
  // saying "always keep this to hand", and a merely-weighted pin loses to anything recent
  // enough — which is exactly when the pin was supposed to help.
  if (!query) {
    return [...allowed]
      .map((doc) => ({
        record: records[doc],
        score: modifier(records[doc], now),
        matched: { bm25: false, exact: false, entity: false },
      }))
      .sort((a, b) => {
        const pinDiff = Number(!!b.record.pinned) - Number(!!a.record.pinned);
        return pinDiff !== 0 ? pinDiff : b.score - a.score;
      });
  }

  const tokens = tokenize(query);

  // Strategy 1 — BM25.
  const bm = bm25(index, tokens, allowed);

  // Strategy 2 — literal substring.
  const needles = exactNeedles(query);
  const exact = new Map<number, number>();
  if (needles.length) {
    index.haystack.forEach((hay, doc) => {
      if (!allowed.has(doc)) return;
      let hits = 0;
      for (const needle of needles) if (hay.includes(needle)) hits++;
      if (hits) exact.set(doc, hits);
    });
  }

  // Strategy 3 — entity expansion.
  const entity = new Map<number, number>();
  const bump = (doc: number) => {
    if (!allowed.has(doc)) return;
    entity.set(doc, (entity.get(doc) ?? 0) + 1);
  };
  for (const word of query.split(/\s+/)) {
    const w = word.trim().toLowerCase().replace(/^["'`]|["'`]$/g, '');
    if (!w) continue;
    for (const key of fileKeys(w)) for (const doc of index.byFile.get(key) ?? []) bump(doc);
    for (const doc of index.byCommand.get(w) ?? []) bump(doc);
    for (const doc of index.bySymbol.get(w) ?? []) bump(doc);
  }

  // Fuse.
  const ranks = [rankOf(bm), rankOf(exact), rankOf(entity)];
  const fused = new Map<number, number>();
  for (const table of ranks) {
    for (const [doc, r] of table) fused.set(doc, (fused.get(doc) ?? 0) + 1 / (RRF_K + r));
  }

  return [...fused.entries()]
    .map(([doc, score]) => ({
      record: records[doc],
      score: score * modifier(records[doc], now),
      matched: { bm25: bm.has(doc), exact: exact.has(doc), entity: entity.has(doc) },
    }))
    .sort((a, b) => b.score - a.score);
}

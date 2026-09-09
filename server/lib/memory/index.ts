// Lexical index over memory records: tokenizer, BM25, and entity postings.
//
// PURE, and deliberately dependency-free. The survey this design follows argues for
// multi-strategy retrieval over single-strategy vector search; a local-first app that ships
// as `npx seshmux` cannot take a native vector store or an ONNX runtime without breaking the
// daemon's zero-build rule and the standalone bundle's install closure. BM25 over a good
// tokenizer, fused with exact and entity matching (rank.ts), covers the same ground for a
// corpus of this size without any of that.
//
// No persisted index either — see store.ts. The index is rebuilt from records in memory and
// memoized on the record array's identity, which the store's own mtime-keyed cache already
// invalidates for us. A stale index is therefore not expressible.

import type { MemoryRecord } from './types';

// Only the words that carry no retrieval signal at all. A long stoplist would start
// discarding real query terms — "for" matters in "for await", "in" in "not in scope".
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'is', 'it', 'be', 'as', 'at', 'by', 'that',
  'this', 'was', 'are', 'were', 'been', 'with', 'from', 'into', 'then', 'than',
]);

/**
 * Split text the way code is actually written.
 *
 * Three things matter and each fixes a real miss:
 *  - camelCase boundaries, so a query for "parse transcript" finds `parseTranscriptFile`;
 *  - path/punctuation splitting, so `server/lib/memory/store.ts` is reachable by "store";
 *  - compound retention, so `--permission-mode` survives whole AND yields "permission" and
 *    "mode". Dropping the whole form is exactly the terminology-mismatch failure that makes
 *    single-strategy retrieval brittle.
 */
export function tokenize(text: string): string[] {
  const camel = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const out: string[] = [];
  for (const rough of camel.toLowerCase().split(/[^a-z0-9_$+-]+/)) {
    if (!rough) continue;
    const clean = rough.replace(/^[-_+.]+/, '').replace(/[-_+.]+$/, '');
    if (clean.length < 2 || STOP.has(clean)) continue;
    out.push(clean);
    if (/[-_]/.test(clean)) {
      for (const part of clean.split(/[-_]+/)) {
        if (part.length >= 2 && !STOP.has(part)) out.push(part);
      }
    }
  }
  return out;
}

/** Every searchable surface of a record, as one string. */
export function documentText(r: MemoryRecord): string {
  return [r.text, ...r.entities.files, ...r.entities.commands, ...r.entities.symbols].join(' ');
}

/** `server/lib/memory/store.ts` -> itself plus `store.ts`, so a bare filename query hits. */
export function fileKeys(path: string): string[] {
  const norm = path.replace(/\\/g, '/').toLowerCase();
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return base && base !== norm ? [norm, base] : [norm];
}

export interface MemoryIndex {
  records: MemoryRecord[];
  /** doc count */
  n: number;
  /** mean document length in tokens */
  avgdl: number;
  /** term -> document frequency */
  df: Map<string, number>;
  /** term -> (docIndex -> term frequency) */
  postings: Map<string, Map<number, number>>;
  /** per-doc token count */
  dl: number[];
  /** lowercased haystack per doc, for the exact-substring strategy */
  haystack: string[];
  byFile: Map<string, Set<number>>;
  byCommand: Map<string, Set<number>>;
  bySymbol: Map<string, Set<number>>;
}

function addTo(map: Map<string, Set<number>>, key: string, doc: number): void {
  if (!key) return;
  const set = map.get(key);
  if (set) set.add(doc);
  else map.set(key, new Set([doc]));
}

export function buildIndex(records: MemoryRecord[]): MemoryIndex {
  const df = new Map<string, number>();
  const postings = new Map<string, Map<number, number>>();
  const dl: number[] = [];
  const haystack: string[] = [];
  const byFile = new Map<string, Set<number>>();
  const byCommand = new Map<string, Set<number>>();
  const bySymbol = new Map<string, Set<number>>();

  records.forEach((r, doc) => {
    const text = documentText(r);
    haystack.push(text.toLowerCase());

    const tokens = tokenize(text);
    dl.push(tokens.length);

    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, count] of tf) {
      df.set(term, (df.get(term) ?? 0) + 1);
      const row = postings.get(term);
      if (row) row.set(doc, count);
      else postings.set(term, new Map([[doc, count]]));
    }

    for (const f of r.entities.files) for (const key of fileKeys(f)) addTo(byFile, key, doc);
    for (const c of r.entities.commands) addTo(byCommand, c.toLowerCase(), doc);
    for (const s of r.entities.symbols) addTo(bySymbol, s.toLowerCase(), doc);
  });

  const total = dl.reduce((a, b) => a + b, 0);
  return {
    records,
    n: records.length,
    avgdl: records.length ? total / records.length : 0,
    df,
    postings,
    dl,
    haystack,
    byFile,
    byCommand,
    bySymbol,
  };
}

// Memoized on the record ARRAY's identity. store.readAllRecords returns the same array
// object until something is appended, so this inherits its invalidation exactly — and a
// WeakMap means a superseded corpus is collected rather than retained.
const indexCache = new WeakMap<MemoryRecord[], MemoryIndex>();

export function getIndex(records: MemoryRecord[]): MemoryIndex {
  const hit = indexCache.get(records);
  if (hit) return hit;
  const built = buildIndex(records);
  indexCache.set(records, built);
  return built;
}

const K1 = 1.2;
const B = 0.75;

/**
 * BM25 over the index, restricted to `allowed` docs when given.
 *
 * The filter is applied as a candidate restriction rather than by re-indexing a subset:
 * scoring a repo-scoped query against corpus-wide IDF is the right thing — a term that is
 * rare across all of memory is a strong signal even if it happens to be common in this repo.
 */
export function bm25(index: MemoryIndex, queryTokens: string[], allowed?: Set<number>): Map<number, number> {
  const scores = new Map<number, number>();
  if (index.n === 0) return scores;

  for (const term of new Set(queryTokens)) {
    const row = index.postings.get(term);
    if (!row) continue;
    const df = index.df.get(term) ?? 0;
    // Standard BM25 IDF, the +1 form so a term present in every document scores ~0 rather
    // than going negative and actively penalising a match.
    const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
    for (const [doc, tf] of row) {
      if (allowed && !allowed.has(doc)) continue;
      const norm = tf * (K1 + 1);
      const denom = tf + K1 * (1 - B + (B * index.dl[doc]) / (index.avgdl || 1));
      scores.set(doc, (scores.get(doc) ?? 0) + idf * (norm / denom));
    }
  }
  return scores;
}

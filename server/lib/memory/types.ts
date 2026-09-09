// Agent-memory record schema (v1). PROVIDER-AGNOSTIC: a record never carries a store path
// or a binary name (hard rule 3) — only the ProviderId that produced it, so the UI can
// render a citation and recall can filter by agent.
//
// Two record families, deliberately distinguished because they age differently:
//   DETERMINISTIC (prompt/tool-call/error/artifact/outcome) — harvested for free from the
//     transcript. High volume, individually low value, safe to expire on a retention clock.
//   DISTILLED (decision/lesson) — produced by an opt-in headless agent pass. Low volume,
//     high value, never auto-expired; superseded rather than deleted when they go stale.

import type { ProviderId } from '../store/scan';

export const MEMORY_SCHEMA = 1 as const;

export type MemoryKind =
  // deterministic (Task 3)
  | 'prompt'
  | 'tool-call'
  | 'error'
  | 'artifact'
  | 'outcome'
  // distilled (Task 6)
  | 'decision'
  | 'lesson';

export const DETERMINISTIC_KINDS: MemoryKind[] = ['prompt', 'tool-call', 'error', 'artifact', 'outcome'];
export const DISTILLED_KINDS: MemoryKind[] = ['decision', 'lesson'];

export function isDistilled(kind: MemoryKind): boolean {
  return kind === 'decision' || kind === 'lesson';
}

// Entities are the "graph" half of retrieval (rank.ts strategy 3): a query naming a file or
// a command pulls that entity's records even when BM25 tokenizes the name away.
export interface MemoryEntities {
  files: string[];
  commands: string[];
  symbols: string[];
}

export interface MemoryOrigin {
  provider: ProviderId;
  sessionId: string;
  ts: number; // when the remembered thing HAPPENED, not when it was written
}

export interface MemoryScope {
  projectId: string; // encodeProjectId(repo) — the cross-provider join key
  repo: string; // absolute repo path, for display + cwd resolution
  branch: string | null;
}

export interface MemoryRecord {
  v: typeof MEMORY_SCHEMA;
  id: string; // contentId(): stable hash — re-harvesting a growing session can't double-write
  kind: MemoryKind;
  text: string; // the searchable + injectable body (clamped, control chars stripped)
  key?: string; // stable slug; a new record with the same key SUPERSEDES the old one
  scope: MemoryScope;
  origin: MemoryOrigin;
  entities: MemoryEntities;
  validFrom: number;
  // Zep-style validity window without a graph database: a superseded record stays on disk
  // (so "what did I believe in July?" still answers) but is hidden from normal recall.
  supersededBy?: string;
  pinned?: boolean;
  hits: number;
  lastHit: number;
}

// Every post-hoc mutation of a record is an append to overlay.ndjson, never an in-place edit
// of a shard: shards are append-only and written by TWO processes (server + mcp-bridge), so
// a rewrite would race an append. readAllRecords() replays the overlay in order; compact()
// folds it into rewritten shards at rest and truncates it.
//
// One file for delete/supersede/pin/hit/edit rather than a tombstone file plus separate pin
// and hit stores: the same cross-process guarantee, and the replay order that resolves
// "pinned then unpinned" is simply file order.
export type MemoryOverlayOp =
  | { op: 'delete'; id: string; at: number }
  | { op: 'expire'; id: string; at: number }
  | { op: 'supersede'; id: string; at: number; by: string }
  | { op: 'pin'; id: string; at: number }
  | { op: 'unpin'; id: string; at: number }
  | { op: 'hit'; id: string; at: number }
  | { op: 'edit'; id: string; at: number; text: string };

export type MemoryScopeMode = 'project' | 'all';

export interface MemoryQuery {
  query?: string;
  projectId?: string; // required when scope === 'project'
  scope?: MemoryScopeMode; // default 'project' — repo-first
  kind?: MemoryKind[];
  provider?: ProviderId;
  file?: string;
  since?: number;
  asOf?: number; // when set, superseded records valid at that time ARE returned
  limit?: number;
}

// What rank.ts returns: the record plus why it scored, so the UI can explain a hit and
// tests can assert on strategy contribution rather than a single opaque number.
export interface RankedRecord {
  record: MemoryRecord;
  score: number;
  matched: { bm25: boolean; exact: boolean; entity: boolean };
}

export interface MemoryPack {
  text: string; // the envelope, ready to paste or return from the MCP tool
  records: MemoryRecord[]; // what actually fit
  used: number; // estimated tokens used
  budget: number;
  totalMatches: number; // before the budget cut — drives "N more, narrow your query"
}

export interface MemorySettings {
  enabled: boolean;
  distillMode: 'off' | 'on-session-end' | 'manual';
  retentionDays: number;
  maxRecords: number;
  recallBudgetTokens: number;
  approveWrites: boolean;
  submitOnLoad: boolean;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: true,
  distillMode: 'off',
  retentionDays: 90,
  maxRecords: 50_000,
  recallBudgetTokens: 1500,
  approveWrites: false,
  submitOnLoad: false,
};

// Optional LLM distillation: deterministic records -> `decision` / `lesson` facts.
//
// This is the only part of memory that spends anything, so it is off by default and every
// piece of it is additive: a failed, rate-limited or nonsense distillation leaves the
// deterministic records exactly as they were. Memory degrades to "what happened" rather
// than breaking.
//
// It reuses the EXISTING headless seam — provider.commands.headlessAsk plus execCapture,
// the same pair bridge/mcp.ts's defaultRunAgent uses. No new spawn path, and no binary name
// or store path enters this file (hard rule 3).
//
// MAP-REDUCE because a session can be enormous: chunk the harvested records, distil each
// chunk to a handful of facts, then a single consolidation pass merges duplicates. Feeding
// a whole session to one call is exactly the context blow-up this feature is supposed to be
// careful about.

import { execCapture } from '../exec-capture';
import type { AgentProvider, ProviderId } from '../providers/types';
import { appendOverlay, appendRecords, contentId, readAllRecords, sanitizeText } from './store';
import { MEMORY_SCHEMA, type MemoryOverlayOp, type MemoryRecord } from './types';

/** Characters of record text per distillation call. Keeps each prompt small and cheap. */
export const CHUNK_CHARS = 6000;
/** Facts a single chunk may contribute. A chunk that "finds" thirty lessons found none. */
export const FACTS_PER_CHUNK = 6;
export const DISTILL_TIMEOUT_MS = 180_000;

export interface DistilledFact {
  kind: 'decision' | 'lesson';
  /** Stable slug; a later fact with the same key SUPERSEDES the earlier one. */
  key: string;
  text: string;
  files?: string[];
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/** Group records into prompt-sized chunks, preserving order. */
export function chunkRecords(records: MemoryRecord[], maxChars = CHUNK_CHARS): MemoryRecord[][] {
  const out: MemoryRecord[][] = [];
  let current: MemoryRecord[] = [];
  let size = 0;
  for (const r of records) {
    const cost = r.text.length + 40;
    if (current.length && size + cost > maxChars) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(r);
    size += cost;
  }
  if (current.length) out.push(current);
  return out;
}

export function buildPrompt(chunk: MemoryRecord[], repoLabel: string): string {
  const body = chunk.map((r) => `- [${r.kind}] ${r.text}`).join('\n');
  return [
    `You are summarising what an AI coding agent did in the repository "${repoLabel}", so that`,
    `a DIFFERENT agent working here later can avoid repeating the same discovery.`,
    ``,
    `From the activity log below, extract at most ${FACTS_PER_CHUNK} durable facts. Only include`,
    `something if it would still be true and useful next week. Prefer:`,
    `  - decision: a choice that was made and the reason for it`,
    `  - lesson:   a non-obvious constraint, gotcha, or thing that failed and why`,
    `Skip anything routine, anything specific to one moment, and anything you are guessing at.`,
    `It is correct to return an empty list.`,
    ``,
    `Reply with ONLY a JSON array, no prose and no code fence. Each element:`,
    `  {"kind":"decision"|"lesson","key":"short-kebab-slug","text":"one or two sentences","files":["path"]}`,
    `The key must describe the SUBJECT so a later revision of the same fact reuses it`,
    `(e.g. "windows-build-requires-stopping-app").`,
    ``,
    `ACTIVITY LOG:`,
    body,
  ].join('\n');
}

/**
 * Tolerant parse of the model's reply.
 *
 * Models wrap JSON in prose or a code fence often enough that a strict JSON.parse would
 * throw away good answers, so the array is located inside whatever came back. Anything
 * malformed yields [] rather than an exception — distillation is best-effort by design.
 */
export function parseDistilled(raw: string): DistilledFact[] {
  if (!raw) return [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: DistilledFact[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const kind = (item as any).kind;
    const text = (item as any).text;
    if (kind !== 'decision' && kind !== 'lesson') continue;
    if (typeof text !== 'string' || text.trim().length < 8) continue;
    const rawKey = typeof (item as any).key === 'string' ? (item as any).key : text;
    const key = rawKey
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    if (!key) continue;
    const files = Array.isArray((item as any).files)
      ? (item as any).files.filter((f: unknown): f is string => typeof f === 'string').slice(0, 10)
      : [];
    out.push({ kind, key, text: text.trim(), files });
  }
  return out.slice(0, FACTS_PER_CHUNK);
}

/** Later facts win over earlier ones for the same key, within a single run. */
export function mergeFacts(batches: DistilledFact[][]): DistilledFact[] {
  const byKey = new Map<string, DistilledFact>();
  for (const batch of batches) for (const fact of batch) byKey.set(fact.key, fact);
  return [...byKey.values()];
}

/**
 * Turn facts into records, and work out what they supersede.
 *
 * A fact whose key already exists in this project is a REVISION, not a duplicate: the new
 * record is appended and the old one marked superseded rather than deleted, so the old
 * belief stays answerable through an asOf query. This is the conflict resolution the whole
 * validity-window design exists for.
 */
export function planDistillWrite(
  facts: DistilledFact[],
  existing: MemoryRecord[],
  ctx: { provider: ProviderId; sessionId: string; projectId: string; repo: string; branch: string | null; now: number },
): { records: MemoryRecord[]; overlay: MemoryOverlayOp[] } {
  const records: MemoryRecord[] = [];
  const overlay: MemoryOverlayOp[] = [];

  for (const fact of facts) {
    const text = sanitizeText(fact.text);
    // Project-scoped: a distilled fact belongs to the repo, not to the run that noticed it.
    const id = contentId({ kind: fact.kind, text, scope: ctx.projectId, target: fact.key });

    // Same key, same project, still current. Identical text is a no-op — re-distilling a
    // session must not append a fresh copy of a fact it already produced.
    const prior = existing.filter(
      (r) => r.key === fact.key && r.scope.projectId === ctx.projectId && !r.supersededBy,
    );
    if (prior.some((r) => r.text === text)) continue;

    records.push({
      v: MEMORY_SCHEMA,
      id,
      kind: fact.kind,
      text,
      key: fact.key,
      scope: { projectId: ctx.projectId, repo: ctx.repo, branch: ctx.branch },
      origin: { provider: ctx.provider, sessionId: ctx.sessionId, ts: ctx.now },
      entities: { files: (fact.files ?? []).map((f) => f.replace(/\\/g, '/')), commands: [], symbols: [] },
      validFrom: ctx.now,
      hits: 0,
      lastHit: 0,
    });

    for (const old of prior) {
      if (old.id !== id) overlay.push({ op: 'supersede', id: old.id, at: ctx.now, by: id });
    }
  }

  return { records, overlay };
}

// ---------------------------------------------------------------------------
// Effectful
// ---------------------------------------------------------------------------

export interface DistillDeps {
  /** Runs one prompt headlessly. Injected so tests never spawn an agent. */
  ask?: (provider: AgentProvider, cwd: string, prompt: string) => Promise<{ text: string; ok: boolean }>;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
  chunkChars?: number;
  /** Ceiling on calls per distillation, so one huge session cannot spend without bound. */
  maxChunks?: number;
}

export const DEFAULT_MAX_CHUNKS = 8;

/**
 * Default runner: exactly the invocation bridge/mcp.ts verified and uses. The `--`
 * end-of-options separator lives in the provider's argv builder, and the leading-dash guard
 * here is the same defence-in-depth defaultRunAgent applies.
 */
export async function defaultAsk(
  provider: AgentProvider,
  cwd: string,
  prompt: string,
): Promise<{ text: string; ok: boolean }> {
  if (/^-/.test(prompt)) return { text: '', ok: false };
  if (/^-/.test(cwd)) return { text: '', ok: false };
  const [bin, ...args] = provider.commands.headlessAsk(cwd, prompt);
  const res = await execCapture(bin, args, {
    cwd,
    timeoutMs: DISTILL_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { text: res.text, ok: res.ok };
}

export interface DistillTarget {
  provider: AgentProvider;
  sessionId: string;
  projectId: string;
  repo: string;
  branch: string | null;
}

export interface DistillResult {
  facts: number;
  superseded: number;
  chunks: number;
  error?: string;
}

/**
 * Distil one session's already-harvested records into decisions and lessons.
 *
 * Reads from the memory store rather than the transcript: the deterministic records are
 * already the interesting parts with the noise removed, so distilling them is both cheaper
 * and better-focused than re-reading raw jsonl.
 */
export async function distillSession(target: DistillTarget, deps: DistillDeps = {}): Promise<DistillResult> {
  const ask = deps.ask ?? defaultAsk;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg: string, err?: unknown) => err && console.error(`[memory] ${msg}`, err));

  const all = await readAllRecords();
  const source = all.filter(
    (r) => r.origin.sessionId === target.sessionId && r.kind !== 'decision' && r.kind !== 'lesson',
  );
  if (source.length === 0) return { facts: 0, superseded: 0, chunks: 0 };

  const chunks = chunkRecords(source, deps.chunkChars ?? CHUNK_CHARS).slice(0, deps.maxChunks ?? DEFAULT_MAX_CHUNKS);
  const repoLabel = target.repo.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? target.repo;

  const batches: DistilledFact[][] = [];
  for (const chunk of chunks) {
    let reply: { text: string; ok: boolean };
    try {
      reply = await ask(target.provider, target.repo, buildPrompt(chunk, repoLabel));
    } catch (err) {
      log(`distill call failed for ${target.sessionId}`, err);
      return { facts: 0, superseded: 0, chunks: chunks.length, error: 'agent call failed' };
    }
    if (!reply.ok) {
      // Rate limit, auth, anything — stop and keep whatever earlier chunks produced. A
      // partial distillation is still strictly additive.
      log(`distill call returned an error for ${target.sessionId}`);
      break;
    }
    batches.push(parseDistilled(reply.text));
  }

  const facts = mergeFacts(batches);
  if (facts.length === 0) return { facts: 0, superseded: 0, chunks: chunks.length };

  const { records, overlay } = planDistillWrite(facts, all, {
    provider: target.provider.id,
    sessionId: target.sessionId,
    projectId: target.projectId,
    repo: target.repo,
    branch: target.branch,
    now: now(),
  });

  const written = await appendRecords(records);
  await appendOverlay(overlay);
  return { facts: written.length, superseded: overlay.length, chunks: chunks.length };
}

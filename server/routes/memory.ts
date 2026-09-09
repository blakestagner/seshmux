// Agent-memory REST surface. Backs both UI surfaces: the statusbar dropdown (MemoryMenu)
// and the right-pane browser (MemoryPanel).
//
// Every read goes through the SAME server/lib/memory/recall.ts the MCP tools use, so what an
// agent pulls and what you push are byte-identical packs. Two query paths would have drifted
// within a release.
//
// House pattern: default plugin export + injected deps with real defaults, so route tests
// register this module on a bare Fastify and never touch the real providers or store.

import type { FastifyInstance } from 'fastify';
import { getProviders } from '../lib/providers/types';
import { distillSession } from '../lib/memory/distill';
import { pack } from '../lib/memory/pack';
import { recall, remember } from '../lib/memory/recall';
import { appendOverlay, compact, readAllRecords } from '../lib/memory/store';
import type { MemoryKind, MemoryRecord, MemoryScopeMode } from '../lib/memory/types';
import { DEFAULT_MEMORY_SETTINGS } from '../lib/memory/types';

export interface MemoryDeps {
  /** projectId → { repo, provider } for writes and distillation. */
  resolveProject?: (projectId: string) => Promise<{ repo: string } | null>;
  /** Called after any mutation so the hub can push a {event:'memory'} refresh. */
  onChanged?: (projectId?: string) => void;
  now?: () => number;
}

async function defaultResolveProject(projectId: string): Promise<{ repo: string } | null> {
  for (const provider of await getProviders()) {
    const projects = await provider.scanProjects().catch(() => []);
    const hit = projects.find((p) => p.id === projectId);
    if (hit) return { repo: hit.path };
  }
  return null;
}

function asArray(v: unknown): string[] | undefined {
  if (typeof v === 'string' && v) return v.split(',').filter(Boolean);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return undefined;
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** The shape the UI renders. `text` is the full body; the pack is built separately. */
export interface MemoryRow {
  id: string;
  kind: MemoryKind;
  text: string;
  key?: string;
  provider: string;
  sessionId: string;
  ts: number;
  repo: string;
  projectId: string;
  branch: string | null;
  files: string[];
  commands: string[];
  pinned: boolean;
  hits: number;
  superseded: boolean;
  score: number;
  /** Estimated tokens this row costs if loaded — drives the live budget counter. */
  tokens: number;
}

function toRow(r: MemoryRecord, score: number): MemoryRow {
  return {
    id: r.id,
    kind: r.kind,
    text: r.text,
    key: r.key,
    provider: r.origin.provider,
    sessionId: r.origin.sessionId,
    ts: r.origin.ts,
    repo: r.scope.repo,
    projectId: r.scope.projectId,
    branch: r.scope.branch,
    files: r.entities.files,
    commands: r.entities.commands,
    pinned: !!r.pinned,
    hits: r.hits ?? 0,
    superseded: !!r.supersededBy,
    score,
    // Cheap and consistent with pack.ts's estimator; the exact number matters less than
    // that the UI's running total and the server's budget agree on the unit.
    tokens: Math.ceil((r.text.length + 80) / 4),
  };
}

export default async function memoryRoutes(f: FastifyInstance, deps: MemoryDeps = {}): Promise<void> {
  const resolveProject = deps.resolveProject ?? defaultResolveProject;
  const changed = (projectId?: string) => deps.onChanged?.(projectId);

  // Ranked rows for the UI. Deliberately NOT the packed text: the dropdown lets you pick
  // which rows to load, so it needs them individually with their token costs.
  f.get('/api/memory', async (req) => {
    const q = req.query as Record<string, unknown>;
    const scope = (q.scope === 'all' ? 'all' : 'project') as MemoryScopeMode;
    const result = await recall(
      {
        query: typeof q.q === 'string' ? q.q : undefined,
        projectId: typeof q.project === 'string' ? q.project : undefined,
        scope,
        kind: asArray(q.kind) as MemoryKind[] | undefined,
        provider: q.provider === 'codex' || q.provider === 'claude' ? q.provider : undefined,
        file: typeof q.file === 'string' ? q.file : undefined,
        since: num(q.since),
        limit: num(q.limit) ?? 60,
      },
      // Browsing a list is not evidence a record was useful; only an actual load counts.
      { countHits: false, now: deps.now?.() },
    );
    return { rows: result.ranked.map((r) => toRow(r.record, r.score)), total: result.totalMatches };
  });

  // Build the pack for a chosen set of rows — the "Load into session" path. Shares
  // pack.ts with the MCP tool, so the block an agent pulls and the one you push are the same.
  f.post('/api/memory/pack', async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown; budgetTokens?: unknown; scope?: unknown };
    const ids = asArray(body.ids) ?? [];
    if (ids.length === 0) return reply.code(400).send({ error: 'ids required' });

    const all = await readAllRecords();
    const byId = new Map(all.map((r) => [r.id, r]));
    // Preserve the caller's order: the list they picked from was already ranked.
    const chosen = ids.map((id) => byId.get(id)).filter((r): r is MemoryRecord => !!r);
    if (chosen.length === 0) return reply.code(404).send({ error: 'no such records' });

    const packed = pack(
      chosen.map((record) => ({ record, score: 0, matched: { bm25: false, exact: false, entity: false } })),
      {
        budgetTokens: num(body.budgetTokens) ?? DEFAULT_MEMORY_SETTINGS.recallBudgetTokens,
        totalMatches: chosen.length,
        scopeLabel: body.scope === 'all' ? 'all repos' : 'this repo',
      },
    );

    // A deliberate load IS evidence the record was worth keeping.
    const now = deps.now?.() ?? Date.now();
    await appendOverlay(packed.records.map((r) => ({ op: 'hit' as const, id: r.id, at: now })));
    changed();
    return { text: packed.text, used: packed.used, budget: packed.budget, count: packed.records.length };
  });

  f.post('/api/memory', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    const text = typeof body.text === 'string' ? body.text : '';
    if (!projectId || !text.trim()) return reply.code(400).send({ error: 'projectId and text required' });

    const project = await resolveProject(projectId);
    if (!project) return reply.code(404).send({ error: 'unknown project' });

    const res = await remember(
      {
        text,
        kind: body.kind === 'decision' ? 'decision' : 'lesson',
        key: typeof body.key === 'string' ? body.key : undefined,
        files: asArray(body.files),
        pin: body.pin === true,
        scope: { projectId, repo: project.repo },
        // Authored in the UI rather than by an agent. Attributed to claude only because
        // ProviderId has no "human" arm; the session id says where it came from.
        origin: { provider: 'claude', sessionId: 'seshmux-ui' },
      },
      { now: deps.now?.() },
    );
    changed(projectId);
    if (!res.record) return reply.code(200).send({ written: false, note: res.note });
    return { written: true, id: res.record.id, superseded: res.superseded };
  });

  // Pin / unpin / edit. Every mutation is an overlay append, never an in-place rewrite —
  // the shards are append-only and have a second writer (the mcp-bridge).
  f.patch('/api/memory/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { pinned?: unknown; text?: unknown };
    const now = deps.now?.() ?? Date.now();

    const all = await readAllRecords();
    if (!all.some((r) => r.id === id)) return reply.code(404).send({ error: 'no such record' });

    const ops = [];
    if (typeof body.pinned === 'boolean') ops.push({ op: body.pinned ? ('pin' as const) : ('unpin' as const), id, at: now });
    if (typeof body.text === 'string' && body.text.trim()) ops.push({ op: 'edit' as const, id, at: now, text: body.text });
    if (ops.length === 0) return reply.code(400).send({ error: 'nothing to change' });

    await appendOverlay(ops);
    changed();
    return { ok: true };
  });

  f.delete('/api/memory/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const all = await readAllRecords();
    if (!all.some((r) => r.id === id)) return reply.code(404).send({ error: 'no such record' });
    await appendOverlay([{ op: 'delete', id, at: deps.now?.() ?? Date.now() }]);
    changed();
    return { ok: true };
  });

  // Manual distillation. Blocking, like /api/bridge/planoff — it runs headless agent calls
  // and the caller wants the result, not a job id.
  f.post('/api/memory/distill', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (!projectId || !sessionId) return reply.code(400).send({ error: 'projectId and sessionId required' });

    const project = await resolveProject(projectId);
    if (!project) return reply.code(404).send({ error: 'unknown project' });

    const providerId = body.provider === 'codex' ? 'codex' : 'claude';
    const provider = (await getProviders()).find((p) => p.id === providerId);
    if (!provider) return reply.code(400).send({ error: `provider ${providerId} not available` });

    const res = await distillSession({
      provider,
      sessionId,
      projectId,
      repo: project.repo,
      branch: typeof body.branch === 'string' ? body.branch : null,
    });
    changed(projectId);
    return res;
  });

  f.get('/api/memory/stats', async () => {
    const all = await readAllRecords();
    const byKind: Record<string, number> = {};
    const byProject: Record<string, number> = {};
    let bytes = 0;
    for (const r of all) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      byProject[r.scope.projectId] = (byProject[r.scope.projectId] ?? 0) + 1;
      bytes += r.text.length;
    }
    return {
      total: all.length,
      pinned: all.filter((r) => r.pinned).length,
      superseded: all.filter((r) => r.supersededBy).length,
      byKind,
      projects: Object.keys(byProject).length,
      bytes,
    };
  });

  // Retention sweep, on demand. compact() is the only single-writer operation in the store,
  // so it is exposed as an explicit action rather than run on a timer alongside harvesting.
  f.post('/api/memory/compact', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const res = await compact(
      {
        ...DEFAULT_MEMORY_SETTINGS,
        retentionDays: num(body.retentionDays) ?? DEFAULT_MEMORY_SETTINGS.retentionDays,
        maxRecords: num(body.maxRecords) ?? DEFAULT_MEMORY_SETTINGS.maxRecords,
      },
      deps.now?.(),
    );
    changed();
    return res;
  });
}

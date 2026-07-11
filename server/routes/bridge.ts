// Agent-bridge routes (Task 16.5 handoff/review, 16.8 plan-off — server half).
// Every agent-spawning + transcript + git action is an INJECTED seam so this file has no
// provider/store knowledge and tests stay hermetic. The daemon lead binds `startSession`
// to term.ts's session-start machinery (agreed signature below).

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { composeBrief as realBrief, composeDiffReview as realReview } from '../lib/bridge/brief';
import {
  pickWinner,
  runPlanoff as realPlanoff,
  winnerMarkdown,
  type PlanoffProvider,
  type PlanoffResult,
} from '../lib/bridge/planoff';
import { decodeProjectDir } from '../lib/store/scan';
import { getProviders, type ProviderId } from '../lib/providers/types';
import { bridgeStatus as realBridgeStatus, registerBridge as realRegister } from '../lib/bridge/registry';
import { peekTerminal as realPeekTerminal } from '../lib/bridge/peek';
import { dial as realDial } from '../daemon-client';
import type { NIStatus } from '../lib/needs-input';

// Agreed with the daemon lead: bridge spawns a fresh opposite-provider (or winner) session,
// seeded with a first prompt. tabMeta carries the linked/pair metadata for the UI.
export interface StartSessionOpts {
  projectPath: string;
  provider: ProviderId;
  firstPrompt: string;
  linkSrc?: { sessionId: string; kind: 'handoff' | 'review' };
}
export type StartSession = (opts: StartSessionOpts) => Promise<{ ptyId: string; tabMeta: unknown }>;

export interface BridgeRouteDeps {
  startSession: StartSession;
  // default: look the project up in the providers' stores (real cwd); decode
  // is only the last-ditch fallback — it mangles hyphenated repo names.
  resolveRepo?: (projectId: string) => string | null | Promise<string | null>;
  resolveSessionProvider?: (projectId: string, sessionId: string) => Promise<ProviderId>;
  resolveLatestSession?: (projectId: string) => Promise<string | null>; // 'latest' sentinel

  composeBrief?: (projectId: string, sessionId: string) => Promise<string>;
  composeDiffReview?: (projectId: string, sessionId: string) => Promise<string>;
  runPlanoff?: (projectPath: string, task: string) => Promise<PlanoffResult>;
  now?: () => number; // clock for scratchpad entry timestamps (injectable for tests)
  // MCP bridge registration (explicit Register button). Default writes the real agent
  // configs; injectable for tests so no real ~/.claude.json / ~/.codex/config.toml is touched.
  registerBridge?: () => Promise<void>;
  bridgeStatus?: () => Promise<{ claude: boolean; codex: boolean }>;

  // Spec 5: wait_for_status / read_terminal. Both need to resolve a project+session
  // down to a LIVE ptyId (cwd match against the daemon's list()) before acting.
  // listLivePtys is injected so tests fake the daemon instead of dialing a real one.
  listLivePtys?: () => Promise<{ ptyId: string; cwd: string }[]>;
  waitForStatus?: (ptyId: string, status: NIStatus, timeoutSec?: number) => Promise<{ status: NIStatus | 'timeout' }>;
  peekTerminal?: (ptyId: string, lines?: number) => Promise<{ ptyId: string; lines: string[] }>;
}

const OTHER: Record<ProviderId, ProviderId> = { claude: 'codex', codex: 'claude' };

function providerName(p: ProviderId): string {
  return p === 'codex' ? 'Codex' : 'Claude';
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const dir = join(path, '..');
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

async function appendScratchpad(repo: string, text: string): Promise<void> {
  const path = join(repo, '.seshmux', 'handoff.md');
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    /* first write */
  }
  await atomicWrite(path, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + text + '\n');
}

// Default: resolve the source session's provider via the providers registry.
async function defaultResolveProvider(projectId: string, sessionId: string): Promise<ProviderId> {
  const providers = await getProviders();
  for (const p of providers) {
    const sessions = await p.listSessions(projectId).catch(() => []);
    if (sessions.some((s) => s.id === sessionId)) return p.id;
  }
  return 'claude'; // fallback
}

// Resolve the project's most-recently-touched session. Lets a live terminal tab
// that doesn't know its own sessionId (rehydrated PTY, fresh spawn) bridge from
// "whatever this project was just doing" — the live session keeps appending to
// its jsonl, so newest-mtime is it in the common case.
// ponytail: ambiguous with two concurrent live sessions in one repo; good enough
// until a real ptyId→sessionId feed exists in the events hub.
async function defaultResolveLatest(projectId: string): Promise<string | null> {
  const providers = await getProviders();
  let best: { id: string; mtime: number } | null = null;
  for (const p of providers) {
    const sessions = await p.listSessions(projectId).catch(() => []);
    for (const s of sessions) {
      if (!best || s.mtime > best.mtime) best = { id: s.id, mtime: s.mtime };
    }
  }
  return best?.id ?? null;
}

// Default repo resolver: providers know each project's REAL cwd (read from the
// session files) — `decodeProjectDir` alone turns every "-" into "/", so
// hyphenated repos (wp-sleepfoundation-org) decode to paths that don't exist.
// Module-level (not a route-function closure) so index.ts's Spec 5 wait-socket
// wiring can reuse the SAME resolution logic instead of a second copy.
export async function defaultResolveRepo(id: string): Promise<string | null> {
  const providers = await getProviders();
  for (const p of providers) {
    const projects = await p.scanProjects().catch(() => []);
    const hit = projects.find((pr) => pr.id === id);
    if (hit) return hit.path;
  }
  return decodeProjectDir(id).path;
}

// Default live-ptys source for Spec 5 wait/peek target resolution — same
// dial+list()+cwd pattern as GET /api/sessions/live in term.ts. Exported for
// index.ts's wait-socket wiring (same reuse rationale as defaultResolveRepo).
export async function defaultListLivePtys(): Promise<{ ptyId: string; cwd: string }[]> {
  let conn = null as Awaited<ReturnType<typeof realDial>> | null;
  try {
    conn = await realDial();
    const { ptys } = await conn.list();
    return ptys.filter((p) => p.alive).map((p) => ({ ptyId: p.ptyId, cwd: p.cwd }));
  } catch {
    return []; // daemon not up yet — no live sessions, not an error
  } finally {
    if (conn) conn.close();
  }
}

export default async function bridgeRoutes(f: FastifyInstance, deps: BridgeRouteDeps) {
  const resolveRepo = deps.resolveRepo ?? defaultResolveRepo;
  const resolveProvider = deps.resolveSessionProvider ?? defaultResolveProvider;
  // Both composers accept the route's resolved repo as a 3rd arg; only the real review
  // composer uses it (to run git diff against the true cwd — R2-1). Injected test composers
  // keep their (projectId, sessionId) shape; the repo arg is simply not forwarded to them.
  const brief: (p: string, s: string, repo: string) => Promise<string> = deps.composeBrief
    ? (p, s) => deps.composeBrief!(p, s)
    : (p, s) => realBrief(p, s);
  const review: (p: string, s: string, repo: string) => Promise<string> = deps.composeDiffReview
    ? (p, s) => deps.composeDiffReview!(p, s)
    : (p, s, repo) => realReview(p, s, {}, repo);
  const planoff = deps.runPlanoff ?? ((path: string, task: string) => realPlanoff(path, task));
  const registerBridge = deps.registerBridge ?? (() => realRegister());
  const bridgeStatus = deps.bridgeStatus ?? (() => realBridgeStatus());
  const listLivePtys = deps.listLivePtys ?? defaultListLivePtys;
  const waitForStatus = deps.waitForStatus;
  const peekTerminal = deps.peekTerminal ?? ((ptyId: string, lines?: number) => realPeekTerminal(ptyId, lines));

  async function repoOrNull(projectId: string): Promise<string | null> {
    // A missing/non-string projectId (empty request body) must land on the routes'
    // existing null → 404 branch, not throw inside resolveRepo → 500 (round-3 residual).
    if (typeof projectId !== 'string' || !projectId) return null;
    const repo = await resolveRepo(projectId);
    return repo && (await isDir(repo)) ? repo : null;
  }

  // Resolve {projectId, sessionId?} down to a LIVE ptyId for wait/peek. wait/peek
  // act on the LIVE terminal, not the jsonl transcript, so sessionId (a specific
  // id or the 'latest' sentinel) is accepted for API parity with handoff/review
  // but resolution is always "the live daemon PTY whose cwd matches this repo" —
  // there's no ptyId->sessionId map to be more precise than that yet. Same
  // ambiguity ceiling as defaultResolveLatest: two concurrent live sessions in
  // one repo → picks one, good enough until a real ptyId->sessionId feed exists.
  async function resolvePtyForSession(projectId: string, _sessionId?: string): Promise<string | null> {
    const repo = await repoOrNull(projectId);
    if (!repo) return null;
    const live = await listLivePtys();
    const hit = live.find((p) => p.cwd === repo);
    return hit?.ptyId ?? null;
  }

  // Shared handler for handoff + review: compose → write file → spawn opposite provider.
  async function bridgeStart(
    reply: import('fastify').FastifyReply,
    projectId: string,
    sessionId: string,
    kind: 'handoff' | 'review',
    compose: (p: string, s: string, repo: string) => Promise<string>,
    filename: string,
  ) {
    const repo = await repoOrNull(projectId);
    if (!repo) {
      reply.code(404);
      return { error: 'project not found' };
    }
    // 'latest' sentinel: bridge from the project's newest session (live tabs
    // that don't know their own sessionId send this).
    if (sessionId === 'latest') {
      const resolved = await (deps.resolveLatestSession ?? defaultResolveLatest)(projectId);
      if (!resolved) {
        reply.code(404);
        return { error: 'no sessions found in this project' };
      }
      sessionId = resolved;
    }
    // Missing/non-string sessionId is a client error, and an unknown one surfaces as
    // compose's 'session not found' throw — both are 404s, not 500s echoing internals
    // (R4-1, sibling of 2c13d70's projectId guard).
    if (typeof sessionId !== 'string' || !sessionId) {
      reply.code(404);
      return { error: 'session not found' };
    }
    const source = await resolveProvider(projectId, sessionId);
    const target = OTHER[source];
    let md: string;
    try {
      md = await compose(projectId, sessionId, repo);
    } catch {
      reply.code(404);
      return { error: 'session not found' };
    }
    await atomicWrite(join(repo, '.seshmux', filename), md);
    // Post a scratchpad entry so cross-review is visible in the shared handoff log from the
    // moment it's requested (the reviewing agent fills in its verdict below, per its prompt).
    if (kind === 'review') {
      const ts = new Date(deps.now ? deps.now() : Date.now()).toISOString();
      await appendScratchpad(
        repo,
        `## Review requested — ${providerName(target)} reviewing ${providerName(source)}'s work · ${ts}\n\n(Verdict to follow — ${providerName(target)} writes it here.)`,
      );
    }
    const { ptyId, tabMeta } = await deps.startSession({
      projectPath: repo,
      provider: target,
      firstPrompt: md,
      linkSrc: { sessionId, kind },
    });
    return { ptyId, tabMeta, provider: target };
  }

  f.post<{ Body: { projectId: string; sessionId: string } }>(
    '/api/bridge/handoff',
    async (req, reply) =>
      bridgeStart(reply, req.body.projectId, req.body.sessionId, 'handoff', brief, 'handoff-brief.md'),
  );

  f.post<{ Body: { projectId: string; sessionId: string } }>(
    '/api/bridge/review',
    async (req, reply) =>
      bridgeStart(reply, req.body.projectId, req.body.sessionId, 'review', review, 'review.md'),
  );

  f.post<{ Body: { projectId: string; task: string } }>(
    '/api/bridge/planoff',
    async (req, reply) => {
      const repo = await repoOrNull(req.body.projectId);
      if (!repo) {
        reply.code(404);
        return { error: 'project not found' };
      }
      // Injection guard: task is fed to the CLIs; a leading `-` could smuggle a flag.
      if (/^-/.test(req.body.task ?? '')) {
        reply.code(400);
        return { error: 'task may not start with "-"' };
      }
      return planoff(repo, req.body.task);
    },
  );

  f.post<{
    Body: { projectId: string; provider: PlanoffProvider; task: string; planoff: PlanoffResult };
  }>('/api/bridge/planoff/pick', async (req, reply) => {
    const repo = await repoOrNull(req.body.projectId);
    if (!repo) {
      reply.code(404);
      return { error: 'project not found' };
    }
    // Validate provider + planoff shape BEFORE indexing (an invalid provider or a
    // malformed planoff body used to index to undefined → 500 TypeError; R2-3).
    const provider = req.body.provider;
    if (provider !== 'claude' && provider !== 'codex') {
      reply.code(400);
      return { error: 'provider must be claude or codex' };
    }
    const po = req.body.planoff;
    const isPlan = (v: unknown): v is { ok: boolean; plan: string } =>
      !!v && typeof v === 'object' && typeof (v as any).plan === 'string';
    if (!po || typeof po !== 'object' || !isPlan(po.claude) || !isPlan(po.codex)) {
      reply.code(400);
      return { error: 'planoff result is missing or malformed' };
    }
    const winner = pickWinner(po, provider);
    const loser = pickWinner(po, OTHER[provider]);
    // Never seed an execution session with a failed/timed-out or empty plan (R2-3).
    if (!winner.ok || !winner.plan.trim()) {
      reply.code(400);
      return { error: 'winning plan is empty or the planner failed — nothing to execute' };
    }

    await atomicWrite(join(repo, '.seshmux', 'planoff-winner.md'), winnerMarkdown(winner, req.body.task));
    if (loser?.plan) {
      await appendScratchpad(repo, `## Plan-off runner-up (${loser.provider})\n\n${loser.plan}`);
    }

    const { ptyId, tabMeta } = await deps.startSession({
      projectPath: repo,
      provider,
      firstPrompt: `Execute the approved plan:\n\n${winner.plan}`,
    });
    return { ptyId, tabMeta, provider };
  });

  // Explicit MCP-bridge registration (Settings "Agent bridge" card Register button).
  // Writes seshmux-bridge into both agents' configs, then reports the resulting status.
  f.post('/api/bridge/register', async (_req, reply) => {
    try {
      await registerBridge();
    } catch (e) {
      // e.g. an existing but unparseable ~/.claude.json — abort with the reason, never
      // clobber the user's config (R2-2). 409: the on-disk config blocks a safe write.
      reply.code(409);
      return { error: (e as Error).message };
    }
    return bridgeStatus();
  });

  // Spec 5 — POST /api/bridge/wait (REST parity with the MCP wait_for_status tool,
  // same process as the hub so this calls it directly — no socket transport needed
  // here, unlike the MCP tool which lives in a separate process).
  // Spec 5 design (line 281) scopes wait_for_status to 'waiting'|'idle' — the
  // states an agent actually blocks on. Matches the MCP tool's zod enum.
  const VALID_STATUS: NIStatus[] = ['waiting', 'idle'];
  f.post<{ Body: { projectId: string; sessionId?: string; status: string; timeoutSec?: number } }>(
    '/api/bridge/wait',
    async (req, reply) => {
      if (!waitForStatus) {
        reply.code(501);
        return { error: 'wait_for_status not wired (no events hub injected)' };
      }
      const status = req.body.status as NIStatus;
      if (!VALID_STATUS.includes(status)) {
        reply.code(400);
        return { error: `status must be one of ${VALID_STATUS.join(', ')}` };
      }
      const ptyId = await resolvePtyForSession(req.body.projectId, req.body.sessionId);
      if (!ptyId) {
        reply.code(404);
        return { error: 'no live session found for this project' };
      }
      return waitForStatus(ptyId, status, req.body.timeoutSec);
    },
  );

  // Spec 5 — GET /api/bridge/peek (REST parity with the MCP read_terminal tool).
  // Refuses peeking the CALLER's own session: the only signal available here is
  // cwd, so "own session" means "the only/most-recent live PTY in the SAME repo
  // as the request's callerProjectId" — same ambiguity ceiling documented on
  // resolvePtyForSession (two concurrent sessions in one repo can't be told
  // apart further without a real ptyId->sessionId map).
  f.get<{ Querystring: { projectId: string; sessionId?: string; lines?: string; callerProjectId?: string } }>(
    '/api/bridge/peek',
    async (req, reply) => {
      if (req.query.callerProjectId && req.query.callerProjectId === req.query.projectId) {
        reply.code(400);
        return { error: 'read_terminal refuses to peek the caller\'s own session' };
      }
      const ptyId = await resolvePtyForSession(req.query.projectId, req.query.sessionId);
      if (!ptyId) {
        reply.code(404);
        return { error: 'no live session found for this project' };
      }
      const lines = req.query.lines ? Number(req.query.lines) : undefined;
      return peekTerminal(ptyId, lines);
    },
  );
}

// POST   /api/workspaces          -> create a worktree + spawn a session in it
// GET    /api/workspaces?project=  -> WorkspaceRecord[] (+ dirty file count) for a project
// DELETE /api/workspaces           -> finish a workspace (merge | keep | discard)
//
// Spawning reuses the SHARED startSession() (hard rule: one spawn path) — this
// file only creates the worktree, then hands its dir to startSession as cwd.

import type { FastifyInstance } from 'fastify';
import { getProviders } from '../lib/providers/types';
import type { ProviderId } from '../lib/providers/types';
import { decodeProjectDir } from '../lib/store/scan';
import * as workspaces from '../lib/workspaces';
import type { RemoveMode } from '../lib/workspaces';
import { startSession, type StartSessionResult } from '../session-start';
import type { SessionMode } from '../session-start';

export interface WorkspaceRouteDeps {
  // projectId -> absolute repo path (mirrors routes/bridge.ts defaultResolveRepo —
  // resolves through the provider stores, never dash-decodes a hyphenated repo
  // name). Injectable for tests.
  resolveRepo?: (projectId: string) => string | null | Promise<string | null>;
  // Provider to spawn with on the one-click rail path (project's dominant
  // provider). Injectable for tests; default picks the provider with the most
  // sessions in the project, falling back to 'claude'.
  resolveDominantProvider?: (projectId: string) => Promise<ProviderId>;
  startSession?: (input: Parameters<typeof startSession>[0]) => Promise<StartSessionResult>;
  create?: typeof workspaces.create;
  list?: typeof workspaces.list;
  remove?: typeof workspaces.remove;
  dirtyCount?: typeof workspaces.dirtyCount;
}

async function isDir(path: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export default async function workspaceRoutes(f: FastifyInstance, deps: WorkspaceRouteDeps = {}) {
  const defaultResolveRepo = async (id: string): Promise<string | null> => {
    const providers = await getProviders();
    for (const p of providers) {
      const projects = await p.scanProjects().catch(() => []);
      const hit = projects.find((pr) => pr.id === id);
      if (hit) return hit.path;
    }
    return decodeProjectDir(id).path;
  };
  const defaultResolveDominant = async (id: string): Promise<ProviderId> => {
    const providers = await getProviders();
    let best: ProviderId = 'claude';
    let bestCount = -1;
    for (const p of providers) {
      const sessions = await p.listSessions(id).catch(() => []);
      if (sessions.length > bestCount) {
        bestCount = sessions.length;
        best = p.id;
      }
    }
    return best;
  };

  const resolveRepo = deps.resolveRepo ?? defaultResolveRepo;
  const resolveDominantProvider = deps.resolveDominantProvider ?? defaultResolveDominant;
  const doStart = deps.startSession ?? startSession;
  const doCreate = deps.create ?? workspaces.create;
  const doList = deps.list ?? workspaces.list;
  const doRemove = deps.remove ?? workspaces.remove;
  const doDirtyCount = deps.dirtyCount ?? workspaces.dirtyCount;

  async function repoOrNull(projectId: string): Promise<string | null> {
    const repo = await resolveRepo(projectId);
    return repo && (await isDir(repo)) ? repo : null;
  }

  // POST /api/workspaces { projectId, provider?, mode? } -> create worktree + spawn.
  // provider omitted -> project's dominant provider (one-click rail path).
  // mode omitted -> 'new' (one-click rail path); the modal's power path may
  // pick 'continue' or 'plan' same as an ordinary session start.
  // Never passes firstPrompt — a fresh worktree is untrusted by codex, and an
  // auto-typed prompt races its folder-trust dialog (inherited gotcha).
  f.post<{ Body: { projectId?: string; provider?: ProviderId; mode?: SessionMode } }>(
    '/api/workspaces',
    async (req, reply) => {
      const { projectId, provider, mode } = req.body ?? {};
      if (typeof projectId !== 'string' || !projectId) {
        reply.code(400);
        return { error: 'projectId is required' };
      }
      const repo = await repoOrNull(projectId);
      if (!repo) {
        reply.code(404);
        return { error: 'project not found' };
      }
      let dir: string;
      let branch: string;
      try {
        ({ dir, branch } = await doCreate(repo));
      } catch (e) {
        reply.code(500);
        return { error: (e as Error).message };
      }
      const spawnProvider = provider ?? (await resolveDominantProvider(projectId));
      const result = await doStart({ projectPath: dir, provider: spawnProvider, mode: mode ?? 'new' });
      return { ...result, workspace: { dir, branch, project: repo } };
    },
  );

  // GET /api/workspaces?project=<projectId> -> workspace records + dirty count.
  f.get<{ Querystring: { project?: string } }>('/api/workspaces', async (req, reply) => {
    const projectId = req.query.project;
    if (!projectId) {
      reply.code(400);
      return { error: 'project is required' };
    }
    const repo = await repoOrNull(projectId);
    if (!repo) {
      reply.code(404);
      return { error: 'project not found' };
    }
    const records = await doList(repo);
    const withDirty = await Promise.all(
      records.map(async (r) => ({ ...r, filesChanged: await doDirtyCount(r.dir) })),
    );
    return withDirty;
  });

  // DELETE /api/workspaces { dir, mode, force? } -> finish flow (merge | keep | discard).
  // force is discard-only: the client sets it after its typed "discard" confirm;
  // the server independently refuses a dirty discard without it (never
  // silent-discard uncommitted work, even from a stale client-side dirty count).
  f.delete<{ Body: { dir?: string; mode?: RemoveMode; force?: boolean } }>('/api/workspaces', async (req, reply) => {
    const { dir, mode, force } = req.body ?? {};
    if (typeof dir !== 'string' || !dir) {
      reply.code(400);
      return { error: 'dir is required' };
    }
    if (mode !== 'merge' && mode !== 'keep' && mode !== 'discard') {
      reply.code(400);
      return { error: 'mode must be merge | keep | discard' };
    }
    try {
      await doRemove(dir, { mode, force: !!force });
      return { ok: true };
    } catch (e) {
      // Distinguish by remove()'s own (stable, locally-thrown) messages so the client gets
      // the right status (R2-7): unknown dir → 404, dirty-discard-without-force → 400,
      // everything else (merge conflict, git failure) → 409, worktree/branch/record intact.
      // ponytail: message-match on our own strings; upgrade to typed errors if they multiply.
      const msg = (e as Error).message;
      if (/unknown workspace/i.test(msg)) reply.code(404);
      else if (/requires force/i.test(msg)) reply.code(400);
      else reply.code(409);
      return { error: msg };
    }
  });
}

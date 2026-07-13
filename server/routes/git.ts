// GET /api/git/changes?project=<id>&branch=<b>&tree=1 -> GitChanges
//
// Read-only line stats for the terminal statusbar chip and the changes panel.
// branch=agent/* diffs inside that workspace's worktree dir; anything else
// diffs the project repo itself (the branch param is advisory there — we
// diff whatever HEAD the repo is on). Base = the repo's default branch, so
// the numbers mean "everything not merged to main yet", uncommitted included.

import type { FastifyInstance } from 'fastify';
import { getProviders } from '../lib/providers/types';
import { decodeProjectDir } from '../lib/store/scan';
import { changes } from '../lib/git-stats';
import { defaultBranch, list as listWorkspacesDefault, type WorkspaceRecord } from '../lib/workspaces';

export interface GitRouteDeps {
  // projectId -> absolute repo path (mirrors routes/workspaces.ts). Injectable for tests.
  resolveRepo?: (projectId: string) => string | null | Promise<string | null>;
  listWorkspaces?: (repo: string) => Promise<WorkspaceRecord[]>;
}

export default async function gitRoutes(f: FastifyInstance, deps: GitRouteDeps = {}) {
  const defaultResolveRepo = async (id: string): Promise<string | null> => {
    const providers = await getProviders();
    for (const p of providers) {
      const projects = await p.scanProjects().catch(() => []);
      const hit = projects.find((pr) => pr.id === id);
      if (hit) return hit.path;
    }
    return decodeProjectDir(id).path;
  };
  const resolveRepo = deps.resolveRepo ?? defaultResolveRepo;
  const listWorkspaces = deps.listWorkspaces ?? listWorkspacesDefault;

  f.get<{ Querystring: { project?: string; branch?: string; tree?: string } }>(
    '/api/git/changes',
    async (req, reply) => {
      const { project, branch, tree } = req.query;
      if (!project) {
        reply.code(400);
        return { error: 'project is required' };
      }
      const repo = await resolveRepo(project);
      if (!repo) {
        reply.code(404);
        return { error: 'project not found' };
      }
      let dir = repo;
      if (branch?.startsWith('agent/')) {
        const rec = (await listWorkspaces(repo).catch(() => [])).find((r) => r.branch === branch);
        if (rec) dir = rec.dir;
      }
      const base = await defaultBranch(repo).catch(() => null);
      return changes(dir, base, tree === '1');
    },
  );
}

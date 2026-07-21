// GET /api/git/changes?project=<id>&branch=<b>&tree=1 -> GitChanges
// GET /api/git/changes/file?project=<id>&branch=<b>&path=<p> -> { diff, truncated }
//
// Line stats + file reads for the terminal statusbar chip and the changes
// panel, plus the panel's search/replace.
// A branch that names one of the project's WORKTREES resolves inside that
// worktree's dir; anything else uses the project repo itself (the branch param
// is advisory there — we use whatever HEAD the repo is on). Base = the repo's
// default branch, so the numbers mean "everything not merged to main yet",
// uncommitted included.

import type { FastifyInstance } from 'fastify';
import { changes, fileDiff, readWorkingFile } from '../lib/git-stats';
import { search, replace, type ReplaceEdit, type SearchOpts } from '../lib/git-search';
import { defaultBranch, list as listWorkspacesDefault, type WorkspaceRecord } from '../lib/workspaces';
import { defaultResolveRepo } from './bridge';

export interface GitRouteDeps {
  // projectId -> absolute repo path. Defaults to the resolver bridge.ts
  // exports (providers know each project's REAL cwd; decodeProjectDir alone
  // mis-decodes hyphenated repo names). Injectable for tests.
  resolveRepo?: (projectId: string) => string | null | Promise<string | null>;
  listWorkspaces?: (repo: string) => Promise<WorkspaceRecord[]>;
}

export default async function gitRoutes(f: FastifyInstance, deps: GitRouteDeps = {}) {
  const resolveRepo = deps.resolveRepo ?? defaultResolveRepo;
  const listWorkspaces = deps.listWorkspaces ?? listWorkspacesDefault;

  // The resolver runs provider store scans — far too heavy per 10s poll, and
  // the id→path mapping essentially never changes. Memoize per registration.
  const repoMemo = new Map<string, { at: number; path: string | null }>();
  const REPO_TTL_MS = 60_000;
  async function repoFor(projectId: string): Promise<string | null> {
    const hit = repoMemo.get(projectId);
    if (hit && Date.now() - hit.at < REPO_TTL_MS) return hit.path;
    const path = await resolveRepo(projectId);
    if (repoMemo.size > 500) repoMemo.clear(); // ponytail: crude bound
    // Never cache a miss: a brand-new project resolves on the NEXT poll, not
    // a minute later (caching null 404'd fresh sessions for the full TTL).
    if (path) repoMemo.set(projectId, { at: Date.now(), path });
    return path;
  }

  // workspaces.list() shells out to `git worktree list`, and resolveTarget runs
  // on every 10s chip poll and every keystroke-debounced search. Short TTL so
  // a worktree created mid-session still shows up promptly. Display path only —
  // the trust-boundary lookup in routes/workspaces.ts stays uncached.
  const wtMemo = new Map<string, { at: number; records: WorkspaceRecord[] }>();
  const WT_TTL_MS = 5000;
  async function worktreesFor(repo: string): Promise<WorkspaceRecord[]> {
    const hit = wtMemo.get(repo);
    if (hit && Date.now() - hit.at < WT_TTL_MS) return hit.records;
    const records = await listWorkspaces(repo).catch(() => []);
    if (wtMemo.size > 200) wtMemo.clear(); // ponytail: crude bound
    wtMemo.set(repo, { at: Date.now(), records });
    return records;
  }

  // Shared by every handler here: repo → (the worktree dir when `branch` names
  // one) + base ref. One implementation so the chip totals, the click-through
  // diff, and search/replace can never disagree about what they're looking at.
  //
  // The gate used to be `branch.startsWith('agent/')` — seshmux's own naming
  // convention. Since worktrees are now discovered from git, a worktree branch
  // can be named anything, and that gate silently resolved those sessions to
  // the MAIN checkout: the diff chip, file browser and search showed the wrong
  // tree, and /api/git/replace WROTE to it. Match on the worktree list instead.
  async function resolveTarget(
    projectId: string,
    branch: string | undefined,
  ): Promise<{ dir: string; base: string | null } | null> {
    const repo = await repoFor(projectId);
    if (!repo) return null;
    let dir = repo;
    if (branch) {
      const rec = (await worktreesFor(repo)).find((r) => r.branch === branch);
      if (rec) dir = rec.dir;
    }
    // Same function worktree CREATION uses (workspaces.createOne), so a
    // workspace is always diffed against what it was branched from.
    const base = await defaultBranch(repo).catch(() => null);
    return { dir, base };
  }

  f.get<{ Querystring: { project?: string; branch?: string; tree?: string } }>(
    '/api/git/changes',
    async (req, reply) => {
      const { project, branch, tree } = req.query;
      if (!project) {
        reply.code(400);
        return { error: 'project is required' };
      }
      const target = await resolveTarget(project, branch);
      if (!target) {
        reply.code(404);
        return { error: 'project not found' };
      }
      return changes(target.dir, target.base, tree === '1');
    },
  );

  // Unified diff for one changed file (the panel's click-through view).
  f.get<{ Querystring: { project?: string; branch?: string; path?: string } }>(
    '/api/git/changes/file',
    async (req, reply) => {
      const { project, branch, path: relPath } = req.query;
      if (!project || !relPath) {
        reply.code(400);
        return { error: 'project and path are required' };
      }
      const target = await resolveTarget(project, branch);
      if (!target) {
        reply.code(404);
        return { error: 'project not found' };
      }
      return fileDiff(target.dir, target.base, relPath);
    },
  );

  // Whole working-tree file for the panel's Full view. Read-only, contained.
  f.get<{ Querystring: { project?: string; branch?: string; path?: string } }>(
    '/api/git/file',
    async (req, reply) => {
      const { project, branch, path: relPath } = req.query;
      if (!project || !relPath) {
        reply.code(400);
        return { error: 'project and path are required' };
      }
      const target = await resolveTarget(project, branch);
      if (!target) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const file = await readWorkingFile(target.dir, relPath);
      if (!file) {
        reply.code(404);
        return { error: 'file not found' };
      }
      return file;
    },
  );

  // Repo-wide search (git grep) for the changes panel's search mode. Same
  // resolveTarget as the diff routes, so a worktree session searches inside
  // its own worktree rather than the main checkout.
  f.get<{ Querystring: Record<string, string | undefined> }>('/api/git/search', async (req, reply) => {
    const q = req.query;
    if (!q.project || !q.q) {
      reply.code(400);
      return { error: 'project and q are required' };
    }
    const target = await resolveTarget(q.project, q.branch);
    if (!target) {
      reply.code(404);
      return { error: 'project not found' };
    }
    return search(target.dir, {
      query: q.q,
      caseSensitive: q.case === '1',
      wholeWord: q.word === '1',
      regex: q.regex === '1',
      include: q.include ?? '',
      exclude: q.exclude ?? '',
      includeIgnored: q.ignored === '1',
    });
  });

  // The one write path in this file. Every edit carries the line text the user
  // saw; git-search skips anything that no longer matches (see replace()).
  f.post<{ Body: { project?: string; branch?: string; edits?: ReplaceEdit[]; replacement?: string } & Partial<SearchOpts> }>(
    '/api/git/replace',
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.project || !b.query || !Array.isArray(b.edits) || b.edits.length === 0) {
        reply.code(400);
        return { error: 'project, query and edits are required' };
      }
      const target = await resolveTarget(b.project, b.branch);
      if (!target) {
        reply.code(404);
        return { error: 'project not found' };
      }
      return replace(target.dir, b.edits, {
        query: b.query,
        caseSensitive: !!b.caseSensitive,
        wholeWord: !!b.wholeWord,
        regex: !!b.regex,
        include: '',
        exclude: '',
        includeIgnored: false,
        replacement: b.replacement ?? '',
      });
    },
  );
}

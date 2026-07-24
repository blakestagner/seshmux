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
import {
  changes,
  fileDiff,
  listDir,
  readWorkingFile,
  resolveContained,
  saveUpload,
  writeWorkingFile,
} from '../lib/git-stats';
import { killPort, listeningPorts } from '../lib/ports';
import { readEntries } from '../lib/live-ledger';
import { reveal } from '../lib/reveal';
import { syntaxCheck } from '../lib/syntax-check';
import { search, replace, type ReplaceEdit, type SearchOpts } from '../lib/git-search';
import { defaultBranch, list as listWorkspacesDefault, type WorkspaceRecord } from '../lib/workspaces';
import { defaultResolveRepo } from './bridge';

// Dropped-file ceiling. Generous (video/zip drops are real) but bounded — the
// body is buffered in memory. ponytail: streaming upload if anyone hits this.
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

export interface GitRouteDeps {
  // projectId -> absolute repo path. Defaults to the resolver bridge.ts
  // exports (providers know each project's REAL cwd; decodeProjectDir alone
  // mis-decodes hyphenated repo names). Injectable for tests.
  resolveRepo?: (projectId: string) => string | null | Promise<string | null>;
  listWorkspaces?: (repo: string) => Promise<WorkspaceRecord[]>;
  // Injected so tests can exercise the route without a real Finder/Explorer
  // window opening on whoever is running the suite.
  revealFn?: (target: string, select?: boolean) => Promise<boolean>;
  // Injected so tests can assert WHICH dir gets scanned without a real listener.
  listPortsFn?: typeof listeningPorts;
}

export default async function gitRoutes(f: FastifyInstance, deps: GitRouteDeps = {}) {
  const resolveRepo = deps.resolveRepo ?? defaultResolveRepo;
  const listWorkspaces = deps.listWorkspaces ?? listWorkspacesDefault;
  const revealFn = deps.revealFn ?? reveal;
  const listPorts = deps.listPortsFn ?? listeningPorts;

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

  // Lazy expand of a collapsed ignored directory in the file tree. Read-only,
  // contained to the target dir (listDir resolves symlinks and refuses escapes).
  f.get<{ Querystring: { project?: string; branch?: string; path?: string } }>(
    '/api/git/dir',
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
      const entries = await listDir(target.dir, relPath);
      if (!entries) {
        reply.code(404);
        return { error: 'directory not found' };
      }
      return { entries };
    },
  );

  // Listening TCP ports owned by processes running inside this dir (or any
  // subdir — monorepo apps report the subdir that owns the port).
  // Which dir to scan for ports. Prefer the PTY's REAL spawn cwd from the live
  // ledger (server-authoritative, ptyId → cwd): a worktree session's terminal
  // lives in the worktree, and the ledger knows that exactly. Branch-based
  // resolveTarget is the fallback — it silently maps to the main checkout when
  // the tab's branch is null or doesn't match a worktree record (fresh session,
  // restored tab), which made an external worktree's ports vanish.
  async function portsDir(project: string, branch: string | undefined, ptyId: string | undefined) {
    if (ptyId) {
      const entry = (await readEntries().catch(() => [])).find((e) => e.ptyId === ptyId);
      if (entry?.cwd) return { dir: entry.cwd };
    }
    return resolveTarget(project, branch);
  }

  f.get<{ Querystring: { project?: string; branch?: string; pty?: string } }>('/api/git/ports', async (req, reply) => {
    const { project, branch, pty } = req.query;
    if (!project) {
      reply.code(400);
      return { error: 'project is required' };
    }
    const target = await portsDir(project, branch, pty);
    if (!target) {
      reply.code(404);
      return { error: 'project not found' };
    }
    return { ports: await listPorts(target.dir), supported: process.platform !== 'win32' };
  });

  // Drag-and-drop upload: raw body (one file per request, the browser hands us
  // File objects one at a time anyway) so no multipart dependency is needed.
  // Encapsulated to this plugin — it does not change body parsing elsewhere.
  f.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) =>
    done(null, body),
  );
  f.post<{ Querystring: { project?: string; branch?: string; dir?: string; name?: string } }>(
    '/api/git/upload',
    { bodyLimit: MAX_UPLOAD_BYTES },
    async (req, reply) => {
      const { project, branch, dir: relDir, name } = req.query;
      if (!project || !name) {
        reply.code(400);
        return { error: 'project and name are required' };
      }
      const target = await resolveTarget(project, branch);
      if (!target) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const body = req.body;
      if (!Buffer.isBuffer(body)) {
        reply.code(400);
        return { error: 'body must be the raw file bytes' };
      }
      const saved = await saveUpload(target.dir, relDir ?? '', name, body);
      if (!saved) {
        reply.code(400);
        return { error: 'destination is outside the project or not a directory' };
      }
      return saved;
    },
  );

  // Save an edited file from the Full view. Overwrite only — see writeWorkingFile.
  f.put<{ Body: { project?: string; branch?: string; path?: string; content?: string; mtimeMs?: number } }>(
    '/api/git/file',
    { bodyLimit: MAX_UPLOAD_BYTES },
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.project || !b.path || typeof b.content !== 'string' || typeof b.mtimeMs !== 'number') {
        reply.code(400);
        return { error: 'project, path, content and mtimeMs are required' };
      }
      const target = await resolveTarget(b.project, b.branch);
      if (!target) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const res = await writeWorkingFile(target.dir, b.path, b.content, b.mtimeMs);
      if ('error' in res) {
        reply.code(res.error === 'stale' ? 409 : 404);
        return {
          error:
            res.error === 'stale'
              ? 'file changed on disk since it was opened — reopen it and redo the edit'
              : 'file not found',
        };
      }
      return res;
    },
  );

  // Syntax check for the editor's squiggles. Read-only: the draft is checked
  // in memory, nothing touches disk.
  f.post<{ Body: { project?: string; branch?: string; path?: string; content?: string } }>(
    '/api/git/check',
    { bodyLimit: MAX_UPLOAD_BYTES },
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.project || !b.path || typeof b.content !== 'string') {
        reply.code(400);
        return { error: 'project, path and content are required' };
      }
      const target = await resolveTarget(b.project, b.branch);
      if (!target) {
        reply.code(404);
        return { error: 'project not found' };
      }
      return syntaxCheck(target.dir, b.path, b.content);
    },
  );

  // Open this project (or one file inside it) in the OS file manager. `path`
  // is optional and goes through the SAME containment resolve as every other
  // path here, so this can only ever reveal something inside the repo.
  f.post<{ Body: { project?: string; branch?: string; path?: string } }>(
    '/api/git/reveal',
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.project) {
        reply.code(400);
        return { error: 'project is required' };
      }
      const target = await resolveTarget(b.project, b.branch);
      if (!target) {
        reply.code(404);
        return { error: 'project not found' };
      }
      // No path -> the repo root itself. A path must resolve inside it; a
      // miss is a 404 rather than a silent fallback to the root, so a stale
      // row can never quietly open the wrong thing.
      const abs = await resolveContained(target.dir, b.path || '.');
      if (!abs) {
        reply.code(404);
        return { error: 'path not found' };
      }
      // Always reveal (select=true): a file shows highlighted in its folder,
      // and the repo root itself shows highlighted in its PARENT — so clicking
      // with no file open lands you where the project lives, not inside it.
      const ok = await revealFn(abs, true);
      if (!ok) {
        reply.code(501);
        return { error: 'no file manager available on the seshmux host' };
      }
      return { ok: true };
    },
  );

  // Kill whatever is listening on a port inside this project (SIGTERM).
  f.post<{ Body: { project?: string; branch?: string; port?: number; pid?: number; ptyId?: string } }>(
    '/api/git/ports/kill',
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.project || typeof b.port !== 'number' || typeof b.pid !== 'number') {
        reply.code(400);
        return { error: 'project, port and pid are required' };
      }
      // Same dir the ports list was scanned from, so killPort's pid+port
      // re-verification matches what the user actually saw.
      const target = await portsDir(b.project, b.branch, b.ptyId);
      if (!target) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const res = await killPort(target.dir, b.port, b.pid);
      if (res === 'not-found') {
        reply.code(404);
        return { error: 'nothing listening on that port in this project' };
      }
      if (res === 'failed') {
        reply.code(500);
        return { error: 'kill failed (permission denied or already gone)' };
      }
      return { ok: true };
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

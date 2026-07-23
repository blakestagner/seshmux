// GET /api/projects            -> Project[] merged across ALL providers (same repo path in
//                                 two stores = ONE entry, sessionCount summed).
// GET /api/projects/:id/sessions?before&limit&q -> SessionMeta[] merged then sorted+sliced.
//
// No provider specifics here: everything flows through getProviders() (hard rule 3).

import type { FastifyInstance } from 'fastify';
import { mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pickFolder, pickerAvailable } from '../lib/folder-picker';
import { getProviders } from '../lib/providers/types';
import type { Project, SessionMeta } from '../lib/providers/types';

// Sessions run inside temp dirs (test daemons, scratch runs, throwaway clones)
// pollute the rail with cwd-projects that aren't real projects. Filter them out
// of the LIST only — their sessions stay on disk and remain searchable.
// Compare on forward-slash-normalized paths: store cwds and os.tmpdir() can mix
// separators on win32, so normalize both sides before the prefix test.
function norm(p: string): string {
  const s = p.replace(/\\/g, '/');
  return s.endsWith('/') ? s : s + '/';
}
const TMP_ROOTS = ['/tmp/', '/private/tmp/', '/private/var/folders/', '/var/folders/', norm(os.tmpdir())];
function isTmpProject(path: string): boolean {
  const p = norm(path);
  return TMP_ROOTS.some((root) => p.startsWith(root));
}

// Expand a leading ~ and make absolute. The user types this path, so there is
// no traversal boundary to defend — but it MUST end up absolute, or mkdir would
// land relative to wherever the server happens to be running.
function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  const expanded = trimmed === '~' || trimmed.startsWith('~/') ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
  return path.resolve(expanded);
}

export default async function projectsRoutes(f: FastifyInstance) {
  // Default location offered by the "new project" dialog, plus whether a
  // native folder chooser can be opened on this machine at all.
  f.get('/api/projects/home', async () => ({ home: os.homedir(), picker: await pickerAvailable() }));

  // Open the OS folder chooser (on the SERVER's screen — see lib/folder-picker).
  // A cancel is a normal outcome, not an error: { path: null }.
  f.post<{ Body: { startIn?: string } }>('/api/projects/pick', async (req) => {
    // A second request dismisses a stale dialog and opens a new one, so this
    // never refuses — see lib/folder-picker.
    return pickFolder(req.body?.startIn);
  });

  // POST /api/projects/create { parent, name } -> { path }
  // Creates <parent>/<name> and hands the path back; the client then starts a
  // session in it (which is what actually makes it a project — a project is a
  // cwd an agent has run in, so seshmux never "registers" one).
  // An existing directory is ADOPTED rather than rejected: pointing the dialog
  // at a repo you already have is the obvious second use of this button.
  f.post<{ Body: { parent?: string; name?: string } }>('/api/projects/create', async (req, reply) => {
    const { parent, name } = req.body ?? {};
    if (!parent || !name || !name.trim()) {
      reply.code(400);
      return { error: 'parent and name are required' };
    }
    // Basename only: a name with slashes silently creating nested dirs (or
    // climbing out with ..) is never what the field means.
    const base = path.basename(name.trim());
    if (!base || base === '.' || base === '..') {
      reply.code(400);
      return { error: 'invalid folder name' };
    }
    const parentPath = resolveUserPath(parent);
    const parentStat = await stat(parentPath).catch(() => null);
    if (!parentStat?.isDirectory()) {
      reply.code(400);
      return { error: `no such directory: ${parentPath}` };
    }
    const target = path.join(parentPath, base);
    const existing = await stat(target).catch(() => null);
    if (existing && !existing.isDirectory()) {
      reply.code(400);
      return { error: `a file already exists at ${target}` };
    }
    if (!existing) await mkdir(target).catch(() => null);
    const made = await stat(target).catch(() => null);
    if (!made?.isDirectory()) {
      reply.code(500);
      return { error: `could not create ${target}` };
    }
    return { path: target, existed: !!existing };
  });

  f.get('/api/projects', async () => {
    const providers = await getProviders();
    const lists = await Promise.all(providers.map((p) => p.scanProjects().catch(() => [])));

    // Merge by project id (dash-encoded cwd — already shared across providers).
    // Keep the per-provider split alongside the summed total — the rail's
    // provider filter shows the filtered count, not the grand total.
    const merged = new Map<string, Project>();
    for (const list of lists) {
      for (const proj of list) {
        if (isTmpProject(proj.path)) continue; // temp-dir cwd ≠ a project
        const prev = merged.get(proj.id);
        if (prev) {
          prev.sessionCount += proj.sessionCount;
          prev.sessionCountByProvider = {
            ...prev.sessionCountByProvider,
            [proj.provider]: (prev.sessionCountByProvider?.[proj.provider] ?? 0) + proj.sessionCount,
          };
        } else {
          merged.set(proj.id, { ...proj, sessionCountByProvider: { [proj.provider]: proj.sessionCount } });
        }
      }
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  f.get<{
    Params: { id: string };
    Querystring: { before?: string; limit?: string; q?: string };
  }>('/api/projects/:id/sessions', async (req) => {
    const providers = await getProviders();
    const q = req.query.q;
    const lists = await Promise.all(
      providers.map((p) => p.listSessions(req.params.id, { q }).catch(() => [] as SessionMeta[])),
    );

    // Merge, then sort by mtime desc, THEN apply before/limit on the merged list.
    let sessions = lists.flat().sort((a, b) => b.mtime - a.mtime);
    const before = req.query.before != null ? Number(req.query.before) : undefined;
    if (before != null && !Number.isNaN(before)) sessions = sessions.filter((s) => s.mtime < before);
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    if (limit != null && !Number.isNaN(limit)) sessions = sessions.slice(0, limit);
    return sessions;
  });
}

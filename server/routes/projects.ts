// GET /api/projects            -> Project[] merged across ALL providers (same repo path in
//                                 two stores = ONE entry, sessionCount summed).
// GET /api/projects/:id/sessions?before&limit&q -> SessionMeta[] merged then sorted+sliced.
//
// No provider specifics here: everything flows through getProviders() (hard rule 3).

import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import { getProviders } from '../lib/providers/types';
import type { Project, SessionMeta } from '../lib/providers/types';

// Sessions run inside temp dirs (test daemons, scratch runs, throwaway clones)
// pollute the rail with cwd-projects that aren't real projects. Filter them out
// of the LIST only — their sessions stay on disk and remain searchable.
const TMP_ROOTS = ['/tmp/', '/private/tmp/', '/private/var/folders/', '/var/folders/', os.tmpdir() + '/'];
function isTmpProject(path: string): boolean {
  const p = path.endsWith('/') ? path : path + '/';
  return TMP_ROOTS.some((root) => p.startsWith(root));
}

export default async function projectsRoutes(f: FastifyInstance) {
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

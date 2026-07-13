// GET /api/customizations — read-only merge of every provider's customization
// scanners (agents/skills/instructions/hooks/mcp) for one scope. v1 has NO
// write endpoints; v2 editing PUTs against item.filePath (see roadmap doc).

import type { FastifyInstance } from 'fastify';
import type { AgentProvider } from '../lib/providers/types';
import type { CustomizationItem, CustomizationScope, CustomizationScanners } from '../lib/providers/customizations';
import { getProviders } from '../lib/providers/types';

export interface CustomizationsRouteOpts {
  listProviders?: () => Promise<AgentProvider[]>;
  resolveRepo?: (projectId: string) => Promise<string | null>;
}

const SECTIONS = ['agents', 'skills', 'instructions', 'hooks', 'mcpServers'] as const;

// Resolve a projectId to a repo path ONLY when it's a real scanned project (SEC-3/4 gate,
// same as scratchpad/subagents). Never falls back to dash-decoding an arbitrary id into a
// path: the project scope reads CLAUDE.md/.mcp.json/settings.json, so a crafted id could
// otherwise pull config (possible secrets) from any directory. A hyphenated repo that
// actually scans is still matched here by its exact scanned id.
async function scannedResolveRepo(id: string): Promise<string | null> {
  const providers = await getProviders();
  for (const p of providers) {
    const projects = await p.scanProjects().catch(() => []);
    const hit = projects.find((pr) => pr.id === id);
    if (hit) return hit.path;
  }
  return null;
}

export default async function customizationsRoutes(f: FastifyInstance, opts: CustomizationsRouteOpts = {}) {
  const listProviders = opts.listProviders ?? getProviders;
  const resolveRepo = opts.resolveRepo ?? scannedResolveRepo;

  f.get<{ Querystring: { scope?: string; project?: string } }>('/api/customizations', async (req, reply) => {
    let scope: CustomizationScope;
    if (req.query.scope === 'project') {
      const repoPath = req.query.project ? await resolveRepo(req.query.project) : null;
      if (!repoPath) return reply.code(404).send({ error: 'unknown project' });
      scope = { kind: 'project', repoPath };
    } else {
      scope = { kind: 'global' };
    }

    const providers = await listProviders();
    const out: Record<string, CustomizationItem[]> = { agents: [], skills: [], instructions: [], hooks: [], mcp: [] };
    await Promise.all(
      providers.flatMap((p) =>
        SECTIONS.map(async (section) => {
          const scan = p.customizations?.[section as keyof CustomizationScanners];
          if (!scan) return;
          try {
            const items = await scan(scope);
            out[section === 'mcpServers' ? 'mcp' : section].push(...items);
          } catch {
            /* one provider's scan failure never breaks the section */
          }
        }),
      ),
    );
    for (const k of Object.keys(out)) out[k].sort((a, b) => a.title.localeCompare(b.title));
    return out;
  });
}

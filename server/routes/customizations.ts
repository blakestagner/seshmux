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

export default async function customizationsRoutes(f: FastifyInstance, opts: CustomizationsRouteOpts = {}) {
  const listProviders = opts.listProviders ?? getProviders;
  const resolveRepo = opts.resolveRepo ?? (await import('./bridge')).defaultResolveRepo;

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

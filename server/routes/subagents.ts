// GET /api/subagents?project=&session= → { nodes: SubagentNode[] } (the flat tree)
// GET /api/subagents/detail?project=&session=&agent= → SubagentDetail (404 if unknown)
//
// Read-only viewer of a claude session's subagent transcripts. The provider seam owns all
// ~/.claude path + subagents/ layout knowledge (hard rule 3); this route only calls
// support.list/detail. Codex has no `subagents` capability → nodes:[] (chip never shows).
//
// SECURITY: SubagentNode.jsonlPath carries an absolute ~/.claude path server-side. It must
// NEVER reach the client. Strip it from BOTH the list payload AND detail.node before replying.

import type { FastifyInstance } from 'fastify';
import { getProviders } from '../lib/providers/types';
import type { SubagentNode, SubagentSupport } from '../lib/providers/types';

export interface SubagentDeps {
  // Resolve the SubagentSupport (default: the claude provider's, index 0). Injectable for tests.
  support?: () => Promise<SubagentSupport | null>;
  // Called on first tree-open (GET /api/subagents) → events-hub watchSubagents (Task 4). Optional.
  onOpen?: (projectId: string, sessionId: string) => void;
}

// Drop the server-only absolute jsonl path before it leaves the process.
function stripPath(node: SubagentNode): SubagentNode {
  const { jsonlPath: _drop, ...rest } = node;
  return rest;
}

export default async function subagentRoutes(f: FastifyInstance, deps: SubagentDeps = {}) {
  const resolveSupport =
    deps.support ??
    (async () => {
      const [claude] = await getProviders(); // claude is always index 0
      return claude?.subagents ?? null;
    });

  f.get<{ Querystring: { project?: string; session?: string } }>(
    '/api/subagents',
    async (req) => {
      const { project, session } = req.query;
      const s = await resolveSupport();
      if (!s || !project || !session) return { nodes: [] };
      deps.onOpen?.(project, session); // start the lazy watch on first open
      const nodes = await s.list(project, session);
      return { nodes: nodes.map(stripPath) };
    },
  );

  f.get<{ Querystring: { project?: string; session?: string; agent?: string } }>(
    '/api/subagents/detail',
    async (req, reply) => {
      const { project, session, agent } = req.query;
      const s = await resolveSupport();
      const d = s && project && session && agent ? await s.detail(project, session, agent) : null;
      if (!d) {
        reply.code(404);
        return { error: 'agent not found' };
      }
      return { ...d, node: stripPath(d.node) };
    },
  );
}

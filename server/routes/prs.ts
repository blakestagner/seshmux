// GET /api/prs/:projectId/:sessionId -> { prs: PrRef[] }
// PRs CREATED during a session, extracted from its parsed transcript. Same
// provider-resolution + mtime-keyed cache shape as routes/transcript.ts.

import type { FastifyInstance } from 'fastify';
import { getProviders } from '../lib/providers/types';
import type { SessionMeta } from '../lib/providers/types';
import { extractPrs, type PrRef } from '../lib/store/prs';
import { Lru } from '../lib/store/lru';

export default async function prsRoutes(f: FastifyInstance) {
  // Results are tiny (a handful of PrRefs) so the cache can be roomier than
  // the transcript one; keyed by mtime so a touched session re-extracts.
  const cache = new Lru<PrRef[]>(50);
  f.get<{ Params: { projectId: string; sessionId: string } }>(
    '/api/prs/:projectId/:sessionId',
    async (req, reply) => {
      const { projectId, sessionId } = req.params;
      const providers = await getProviders();

      let owner: (typeof providers)[number] | undefined;
      let meta: SessionMeta | undefined;
      for (const p of providers) {
        const sessions = await p.listSessions(projectId).catch(() => [] as SessionMeta[]);
        const found = sessions.find((s) => s.id === sessionId);
        if (found) {
          owner = p;
          meta = found;
          break;
        }
      }

      if (!owner || !meta) {
        reply.code(404);
        return { error: 'session not found' };
      }

      const key = `${owner.id}:${projectId}:${sessionId}:${meta.mtime}`;
      const prs = await cache.get(key, async () => {
        const { msgs } = await owner!.parseTranscript(projectId, sessionId);
        return extractPrs(msgs);
      });
      return { prs };
    },
  );
}

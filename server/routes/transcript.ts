// GET /api/transcript/:projectId/:sessionId -> { msgs, ctx, meta }
// The URL carries no provider, so resolve the owning provider by finding the SessionMeta
// across providers' listSessions — that meta also becomes the response `meta`.

import type { FastifyInstance } from 'fastify';
import { getProviders } from '../lib/providers/types';
import type { SessionMeta, Msg, Ctx } from '../lib/providers/types';
import { Lru } from '../lib/store/lru';

export interface TranscriptRouteDeps {
  // LRU size from config.settings.transcriptCacheSize (read ONCE at boot by the
  // server, never on the hot path). Default 10 per plan.
  cacheSize?: number;
}

export default async function transcriptRoutes(f: FastifyInstance, deps: TranscriptRouteDeps = {}) {
  // Server-side transcript cache keyed by (provider, ids, mtime): a touched file
  // (new mtime) misses and re-parses; an unchanged one is served from memory.
  const transcriptCache = new Lru<{ msgs: Msg[]; ctx: Ctx | null; truncated: boolean }>(deps.cacheSize ?? 10);
  f.get<{ Params: { projectId: string; sessionId: string } }>(
    '/api/transcript/:projectId/:sessionId',
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
      const { msgs, ctx, truncated } = await transcriptCache.get(key, () =>
        owner!.parseTranscript(projectId, sessionId),
      );
      return { msgs, ctx, meta, truncated };
    },
  );
}

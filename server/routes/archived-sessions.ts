// GET /api/sessions/archived -> ArchivedRecord[]  (every archived session)
// PUT /api/sessions/archived { provider, sessionId, projectId, archived } -> ArchivedRecord[]
//
// Session-level twin of the project hide list in /api/config. Only seshmux's own
// archived-sessions.json is written — never a provider transcript. The rail's
// session listing (/api/projects/:id/sessions?archived=…) filters on this set.

import type { FastifyInstance } from 'fastify';
import { readArchived, setArchived, type ArchivedMap } from '../lib/archived-sessions';

// Trust boundary — this endpoint writes disk. Shapes only; an id that matches no
// real session is harmless (it simply never matches a listing).
const PROVIDER_RE = /^[a-z0-9_-]{1,32}$/;
const SESSION_RE = /^[A-Za-z0-9_.-]{1,200}$/;

const list = (m: ArchivedMap) => Object.values(m).sort((a, b) => b.archivedAt - a.archivedAt);

export default async function archivedSessionsRoutes(f: FastifyInstance) {
  f.get('/api/sessions/archived', async () => list(await readArchived()));

  f.put<{ Body: unknown }>('/api/sessions/archived', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const { provider, sessionId, projectId, archived } = b;
    if (
      typeof provider !== 'string' ||
      !PROVIDER_RE.test(provider) ||
      typeof sessionId !== 'string' ||
      !SESSION_RE.test(sessionId) ||
      typeof projectId !== 'string' ||
      !projectId ||
      projectId.length > 1000 ||
      typeof archived !== 'boolean'
    ) {
      reply.code(400);
      return { error: 'provider, sessionId, projectId (strings) and archived (boolean) are required' };
    }
    return list(await setArchived({ provider, sessionId, projectId }, archived));
  });
}

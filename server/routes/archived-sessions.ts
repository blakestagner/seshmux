// GET /api/sessions/archived -> ArchivedRecord[]  (every archived session)
// PUT /api/sessions/archived { provider, sessionId, projectId, archived } -> ArchivedRecord[]
//
// Session-level twin of the project hide list in /api/config. Only seshmux's own
// archived-sessions.json is written — never a provider transcript. The rail's
// session listing (/api/projects/:id/sessions?archived=…) filters on this set.

import type { FastifyInstance } from 'fastify';
import { readArchivedStrict, setArchived, type ArchivedMap } from '../lib/archived-sessions';
import { getProviders } from '../lib/providers/types';

// Trust boundary — this endpoint writes disk. Shapes only for the ids (an id that
// matches no real session is harmless: it never matches a listing); archiving
// needs a provider this server actually has (checked below).
const SESSION_RE = /^[A-Za-z0-9_.-]{1,200}$/;

const list = (m: ArchivedMap) => Object.values(m).sort((a, b) => b.archivedAt - a.archivedAt);

export default async function archivedSessionsRoutes(f: FastifyInstance) {
  // 500 (not an empty 200) when the file can't be read: the client keeps what it has
  // rather than taking "nothing archived" as the truth.
  f.get('/api/sessions/archived', async (_req, reply) => {
    try {
      return list(await readArchivedStrict());
    } catch (e) {
      reply.code(500);
      return { error: `could not read archived sessions: ${(e as Error).message}` };
    }
  });

  f.put<{ Body: unknown }>('/api/sessions/archived', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const { provider, sessionId, projectId, archived } = b;
    if (
      typeof provider !== 'string' ||
      !provider ||
      provider.length > 64 ||
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
    // Archiving needs a provider this server has. Restoring does not: a record left
    // behind by a provider that has since gone away must still be clearable.
    const known = (await getProviders()).some((p) => p.id === provider);
    if (!known && archived) {
      reply.code(400);
      return { error: `unknown provider: ${provider}` };
    }
    try {
      return list(await setArchived({ provider, sessionId, projectId }, archived));
    } catch (e) {
      // e.g. the archive file exists but can't be read — refused rather than overwritten.
      reply.code(500);
      return { error: `could not update archived sessions: ${(e as Error).message}` };
    }
  });
}

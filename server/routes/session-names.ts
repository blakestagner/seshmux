// GET /api/session-names -> { names: { "<provider>:<sessionId>": "<name>" } }
// PUT /api/session-names { provider, sessionId, name } -> { provider, sessionId, name: string | null }
//
// Custom display names for sessions (issue #63). Stored in seshmux's own config dir
// (server/lib/session-names.ts) — the agent transcript is never written. An empty /
// blank name clears the entry, reverting the session to its auto-derived title.
// No provider specifics here: the provider id is validated against getProviders().

import type { FastifyInstance } from 'fastify';
import { getProviders } from '../lib/providers/types';
import { isValidSessionId, readSessionNames, setSessionName } from '../lib/session-names';

export interface SessionNameChange {
  provider: string;
  sessionId: string;
  name: string | null;
}

export interface SessionNamesDeps {
  // Is `id` a provider this server knows? Default: one of getProviders()' ids.
  // Injectable so tests stay hermetic.
  isProvider?: (id: string) => Promise<boolean> | boolean;
  // Called after a successful write — the server binds this to the events hub so
  // every open browser (and every open tab) picks up the new name without a reload.
  onChanged?: (change: SessionNameChange) => void;
}

async function defaultIsProvider(id: string): Promise<boolean> {
  return (await getProviders()).some((p) => p.id === id);
}

export default async function sessionNamesRoutes(f: FastifyInstance, deps: SessionNamesDeps = {}) {
  const isProvider = deps.isProvider ?? defaultIsProvider;

  f.get('/api/session-names', async () => ({ names: await readSessionNames() }));

  f.put<{ Body: { provider?: unknown; sessionId?: unknown; name?: unknown } }>(
    '/api/session-names',
    async (req, reply) => {
      const { provider, sessionId, name } = req.body ?? {};
      if (typeof provider !== 'string' || !(await isProvider(provider))) {
        reply.code(400);
        return { error: 'unknown provider' };
      }
      if (!isValidSessionId(sessionId)) {
        reply.code(400);
        return { error: 'invalid sessionId' };
      }
      // null/undefined mean "clear" just like ''; anything else must be a string.
      if (name != null && typeof name !== 'string') {
        reply.code(400);
        return { error: 'name must be a string' };
      }
      const saved = await setSessionName(provider, sessionId, name ?? '');
      const change: SessionNameChange = { provider, sessionId, name: saved };
      deps.onChanged?.(change);
      return change;
    },
  );
}

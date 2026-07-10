// GET /api/update/check  → checkUpdate()
// POST /api/update/apply → applyUpdate() then an INJECTED onApplied callback (the daemon
// lead binds the restart choreography — exit 75 / events broadcast / relaunch loop — there;
// this route only runs the install and hands off the result).

import type { FastifyInstance } from 'fastify';
import {
  applyUpdate as realApply,
  checkUpdate as realCheck,
  type ApplyUpdateResult,
  type UpdateStatus,
} from '../lib/update';

export interface UpdateRouteDeps {
  checkUpdate?: () => Promise<UpdateStatus>;
  applyUpdate?: (opts: { installMethod: UpdateStatus['installMethod']; current: string }) => Promise<ApplyUpdateResult>;
  // TODO(wire): daemon lead binds restart choreography here — broadcast server-restarting,
  // exit 75, relaunch loop picks up the new version. Only fired on a successful install.
  onApplied?: (result: ApplyUpdateResult) => Promise<void> | void;
}

export default async function updateRoutes(f: FastifyInstance, deps: UpdateRouteDeps = {}) {
  const check = deps.checkUpdate ?? (() => realCheck());
  const apply = deps.applyUpdate ?? realApply;

  f.get('/api/update/check', async () => check());

  f.post('/api/update/apply', async (_req, reply) => {
    const status = await check();
    let result: ApplyUpdateResult;
    try {
      result = await apply({ installMethod: status.installMethod, current: status.current });
    } catch (e) {
      // applyUpdate rejects for npx installs (no self-update possible) — 409 Conflict.
      reply.code(409);
      return { error: e instanceof Error ? e.message : 'update failed' };
    }
    // Only hand off to the restart choreography when the install actually succeeded.
    if (result.ok && deps.onApplied) await deps.onApplied(result);
    return result;
  });
}

// POST /api/bridge/approval/:requestId { approved: boolean } — the UI's reply to
// an MCP bridge approval request (plan 16.7). Correlates by requestId to the
// pending hub.requestApproval() promise; resolves it so the bridge call
// proceeds/denies. Auth-guarded (mutating → onRequest hook). 404 if the request
// is unknown (already resolved, timed out, or lost to a server restart —
// fail-closed by the listener's own timeout, not here).

import type { FastifyInstance } from 'fastify';

export interface ApprovalRouteDeps {
  resolveApproval: (requestId: string, approved: boolean) => boolean;
}

export default async function approvalRoutes(f: FastifyInstance, deps: ApprovalRouteDeps) {
  f.post<{ Params: { requestId: string }; Body: { approved?: unknown } }>(
    '/api/bridge/approval/:requestId',
    async (req, reply) => {
      const approved = (req.body ?? {}).approved === true;
      const ok = deps.resolveApproval(req.params.requestId, approved);
      if (!ok) {
        reply.code(404);
        return { error: 'unknown or expired approval request' };
      }
      return { ok: true };
    },
  );
}

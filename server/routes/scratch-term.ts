// Client-facing scratch-terminal spawn/kill.
//
// Kept OUT of routes/term.ts on purpose: that file's header pins "argv comes
// ONLY from provider.commands" (hard rule 3), and a scratch shell's argv is a
// generic tool resolved in lib/scratch.ts, not a provider command — keeping the
// two files apart keeps that invariant crisp. Named scratch-term (not scratch)
// so it can't be confused with routes/scratchpad.ts.
//
//   POST   /api/term/scratch          { ownerPtyId } -> { ptyId, existing }
//   DELETE /api/term/scratch/:ptyId   scratch-guarded kill (fail-closed 404)
//
// Guarded by the onRequest auth hook in server/index.ts (under /api/).

import type { FastifyInstance } from 'fastify';
import { dial } from '../daemon-client';
import { startScratchTerminal } from '../lib/scratch';
import { readScratchMap, removeScratch } from '../lib/scratch-store';

// Injected for hermetic tests (fake daemon), same shape/posture as TermRouteDeps.
export interface ScratchTermRouteDeps {
  dialFn?: typeof dial;
}

export default async function scratchTermRoutes(f: FastifyInstance, deps: ScratchTermRouteDeps = {}) {
  // POST /api/term/scratch — spawn (or idempotently re-adopt) an owner's shell.
  f.post('/api/term/scratch', async (req, reply) => {
    const body = (req.body ?? {}) as { ownerPtyId?: unknown };
    const { ownerPtyId } = body;
    if (typeof ownerPtyId !== 'string' || !ownerPtyId) {
      return reply.code(400).send({ error: 'ownerPtyId is required' });
    }
    try {
      return await startScratchTerminal(ownerPtyId, { dialFn: deps.dialFn });
    } catch (e) {
      const msg = (e as Error).message;
      // Owner-missing / gone-cwd are client faults (400); daemon errors are 500.
      const client = msg.includes('owner session not found') || msg.includes('cwd no longer exists');
      return reply.code(client ? 400 : 500).send({ error: msg });
    }
  });

  // DELETE /api/term/scratch/:ptyId — the ONLY client-facing kill route.
  // SCRATCH-GUARDED, FAIL CLOSED: ptyId must be a known scratch, else 404 — this
  // route can never terminate an agent PTY (the internal kill RPC has no such
  // guard). readScratchMap() is parse-tolerant (never throws); an unknown id 404s.
  f.delete<{ Params: { ptyId: string } }>('/api/term/scratch/:ptyId', async (req, reply) => {
    const { ptyId } = req.params;
    const map = await readScratchMap();
    if (!map[ptyId]) return reply.code(404).send({ error: `not a scratch terminal: ${ptyId}` });
    let conn = null;
    try {
      conn = await (deps.dialFn ?? dial)();
      await conn.kill(ptyId);
      await removeScratch(ptyId); // belt-and-suspenders — the hub's exit hook also prunes.
      return { ok: true };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    } finally {
      conn?.close();
    }
  });
}

// §1a server-side sessionId binding: on a watch session-new/session-touch, write
// the emitted sessionId into the newest unbound ledger entry for the same
// repo + provider. Fresh/continue sessions have no id at spawn (session-start
// records them unbound), so this is the only path that makes most entries
// resumable. Mirrors the client heuristic (findTabToBindSession,
// lib/client/store.ts) including its two-in-one-repo ambiguity ceiling — the
// pure rule + idempotence live in live-ledger's bindSessionId (Stage 2).
//
// Hard rule 3: projectId -> repo path goes through the generic provider surface
// (scanProjects), and the worktree fold reuses derivedWorkspaceParent — no store
// path or agent-binary knowledge here.

import { getProviders } from './providers/types';
import { derivedWorkspaceParent } from './store/scan';
import { bindSessionId, readEntries } from './live-ledger';
import type { ProviderId } from './providers/types';

export interface BindDeps {
  providersFn?: typeof getProviders;
  readEntriesFn?: typeof readEntries;
  bindFn?: typeof bindSessionId;
  canon?: (cwd: string) => string;
}

/** Resolve the watch event's projectId to a repo path and bind sessionId onto
 *  the matching unbound ledger entry. All failures swallowed + logged — a binding
 *  must never disturb the watch fan-out. Returns whether a bind happened. */
export async function bindSessionFromWatch(
  provider: ProviderId,
  projectId: string,
  sessionId: string,
  deps: BindDeps = {},
): Promise<boolean> {
  const providersFn = deps.providersFn ?? getProviders;
  const readEntriesFn = deps.readEntriesFn ?? readEntries;
  const bindFn = deps.bindFn ?? bindSessionId;
  const canon = deps.canon ?? ((cwd: string) => derivedWorkspaceParent(cwd) ?? cwd);
  try {
    if (!sessionId) return false;
    // Fast-path skip FIRST: no unbound entry for this provider at all → nothing
    // to bind, so avoid the scanProjects walk on every touch storm.
    const entries = await readEntriesFn();
    if (!entries.some((e) => e.provider === provider && !e.sessionId)) return false;

    const providers = await providersFn();
    const p = providers.find((pr) => pr.id === provider);
    if (!p) return false;
    const projects = await p.scanProjects();
    const project = projects.find((pj) => pj.id === projectId);
    if (!project) return false;

    return await bindFn(provider, project.path, sessionId, canon);
  } catch (e) {
    console.error('[seshmux] ledger bind failed:', e);
    return false;
  }
}

// Status-hook install routes (Spec 2 — hook-based status authority). Settings
// "Deep agent integration" toggle is the ONLY caller — never installed silently.
// Provider-agnostic route; the actual agent-config write lives behind
// ClaudeProvider.statusHooks (hard rule 3 — no ~/.claude path outside providers/).

import type { FastifyInstance } from 'fastify';
import { getProviders as realGetProviders, type AgentProvider, type ProviderId } from '../lib/providers/types';

export interface HooksInstallState {
  available: boolean;
  installed: boolean;
  upToDate: boolean;
  version: number | null;
}

export interface HooksRouteDeps {
  // Test seam: real getProviders() returns the real ClaudeProvider, whose
  // statusHooks targets the real agent config file. Tests inject a fake
  // provider list with a stub statusHooks pointed at a temp file instead —
  // NEVER exercise this route against the real getProviders() in a test.
  getProviders?: () => Promise<AgentProvider[]>;
}

async function stateForProvider(provider: AgentProvider | undefined): Promise<HooksInstallState> {
  const hooks = provider?.statusHooks;
  if (!hooks) return { available: false, installed: false, upToDate: false, version: null };
  const st = await hooks.hooksInstallState();
  return { available: hooks.hooksAvailable(), ...st };
}

export default async function hooksRoutes(f: FastifyInstance, deps: HooksRouteDeps = {}) {
  const getProviders = deps.getProviders ?? realGetProviders;

  f.get('/api/hooks/status', async () => {
    const providers = await getProviders();
    const out: Record<string, HooksInstallState> = {};
    for (const p of providers) out[p.id] = await stateForProvider(p);
    return out;
  });

  f.post<{ Body: { provider?: string } }>('/api/hooks/install', async (req, reply) => {
    const id = req.body?.provider as ProviderId | undefined;
    const providers = await getProviders();
    const provider = providers.find((p) => p.id === id);
    if (!provider?.statusHooks?.hooksAvailable()) {
      reply.code(400);
      return { error: `provider ${id ?? '?'} does not support status hooks` };
    }
    try {
      await provider.statusHooks.installHooks();
    } catch (err) {
      reply.code(500);
      return { error: (err as Error).message };
    }
    return stateForProvider(provider);
  });

  f.post<{ Body: { provider?: string } }>('/api/hooks/uninstall', async (req, reply) => {
    const id = req.body?.provider as ProviderId | undefined;
    const providers = await getProviders();
    const provider = providers.find((p) => p.id === id);
    if (!provider?.statusHooks) {
      reply.code(400);
      return { error: `provider ${id ?? '?'} does not support status hooks` };
    }
    try {
      await provider.statusHooks.uninstallHooks();
    } catch (err) {
      reply.code(500);
      return { error: (err as Error).message };
    }
    return stateForProvider(provider);
  });
}

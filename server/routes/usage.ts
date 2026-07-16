// GET /api/usage?days=30 -> merged UsageSummary across all providers.
// Sums totals; recomputes byProject and byProvider percentages on the MERGED token base.

import type { FastifyInstance } from 'fastify';
import { getProviders } from '../lib/providers/types';
import type { ProviderId, UsageSummary } from '../lib/providers/types';

export default async function usageRoutes(f: FastifyInstance) {
  f.get<{ Querystring: { days?: string } }>('/api/usage', async (req) => {
    const days = req.query.days != null ? Number(req.query.days) : 30;
    const window = Number.isNaN(days) ? 30 : days;

    const providers = await getProviders();
    const per = await Promise.all(
      providers.map(async (p) => ({ id: p.id, u: await p.usage(window).catch(() => null) })),
    );

    let sessions = 0;
    let totalTokens = 0;
    let cacheReads = 0;
    let estCostUsd = 0;
    const projectTokens = new Map<string, number>();
    const providerTokens = new Map<ProviderId, number>();

    for (const { id, u } of per) {
      if (!u) continue;
      sessions += u.sessions;
      totalTokens += u.totalTokens;
      cacheReads += u.cacheReads;
      estCostUsd += u.estCostUsd;
      providerTokens.set(id, (providerTokens.get(id) ?? 0) + u.totalTokens);
      // byProject entries carry pct against that provider's own base — reconstruct raw
      // token share so the merged pct is correct: rawTokens = pct% * providerTotal.
      for (const bp of u.byProject) {
        const raw = (bp.pct / 100) * u.totalTokens;
        projectTokens.set(bp.name, (projectTokens.get(bp.name) ?? 0) + raw);
      }
    }

    const byProject =
      totalTokens > 0
        ? [...projectTokens.entries()]
            .map(([name, t]) => ({ name, pct: Math.round((t / totalTokens) * 100) }))
            .sort((a, b) => b.pct - a.pct)
        : [];

    const byProvider =
      totalTokens > 0
        ? [...providerTokens.entries()]
            .filter(([, t]) => t > 0)
            .map(([provider, t]) => ({ provider, pct: Math.round((t / totalTokens) * 100) }))
        : [];

    const result: UsageSummary = { sessions, totalTokens, cacheReads, estCostUsd, byProject, byProvider };
    return result;
  });
}

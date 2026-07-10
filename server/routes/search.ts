// GET /api/search?q= -> SearchHit[] across EVERY provider's store, merged, sorted by ts
// desc, capped at 200 total. Search logic lives behind provider.search() (hard rule 3).

import type { FastifyInstance } from 'fastify';
import { getProviders } from '../lib/providers/types';
import type { SearchHit } from '../lib/providers/types';

const TOTAL_CAP = 200;

export default async function searchRoutes(f: FastifyInstance) {
  f.get<{ Querystring: { q?: string } }>('/api/search', async (req) => {
    const q = (req.query.q ?? '').trim();
    if (!q) return [] as SearchHit[];

    const providers = await getProviders();
    const results = await Promise.all(providers.map((p) => p.search(q).catch(() => [] as SearchHit[])));
    return results
      .flat()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, TOTAL_CAP);
  });
}

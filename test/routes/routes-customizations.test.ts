import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import customizationsRoutes from '../../server/routes/customizations';
import type { CustomizationItem } from '../../server/lib/providers/customizations';

const item = (over: Partial<CustomizationItem>): CustomizationItem => ({
  id: 'x', provider: 'claude', scope: 'global', filePath: '/f', title: 't', meta: {}, content: '', ...over,
});

function app(overrides: Partial<Parameters<typeof customizationsRoutes>[1]> = {}) {
  const f = Fastify();
  f.register(customizationsRoutes, {
    listProviders: async () => [
      { id: 'claude', customizations: { agents: async () => [item({ title: 'b-agent' })] } },
      { id: 'codex', customizations: { agents: async () => [item({ provider: 'codex', title: 'a-prompt' })] } },
    ] as any,
    resolveRepo: async (projectId: string) => (projectId === 'known' ? '/repo/known' : null),
    ...overrides,
  });
  return f;
}

describe('GET /api/customizations', () => {
  it('merges providers and sorts by title; sections with no scanner are empty arrays', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/customizations?scope=global' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents.map((i: any) => i.title)).toEqual(['a-prompt', 'b-agent']);
    expect(body.skills).toEqual([]);
    expect(body.hooks).toEqual([]);
  });

  it('project scope resolves the repo through the injected resolver', async () => {
    let got: any = null;
    const f = app({
      listProviders: async () => [
        { id: 'claude', customizations: { agents: async (s: any) => { got = s; return []; } } },
      ] as any,
    });
    await f.inject({ method: 'GET', url: '/api/customizations?scope=project&project=known' });
    expect(got).toEqual({ kind: 'project', repoPath: '/repo/known' });
  });

  it('404s an unknown project id', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/customizations?scope=project&project=nope' });
    expect(res.statusCode).toBe(404);
  });

  it('a scanner that throws drops to [] for that provider, not a 500', async () => {
    const f = app({
      listProviders: async () => [
        { id: 'claude', customizations: { agents: async () => { throw new Error('boom'); } } },
        { id: 'codex', customizations: { agents: async () => [item({ provider: 'codex' })] } },
      ] as any,
    });
    const res = await f.inject({ method: 'GET', url: '/api/customizations?scope=global' });
    expect(res.statusCode).toBe(200);
    expect(res.json().agents).toHaveLength(1);
  });
});

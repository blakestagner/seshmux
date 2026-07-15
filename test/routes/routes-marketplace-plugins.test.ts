import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import marketplaceRoutes from '../../server/routes/marketplace';
import type { AgentProvider } from '../../server/lib/providers/types';

function fakeProvider(overrides: Partial<AgentProvider> = {}): AgentProvider {
  return {
    id: 'claude',
    pluginCommands: {
      listAvailable: () => ['claude', 'plugin', 'list', '--available', '--json'],
      listMarketplaces: () => ['claude', 'plugin', 'marketplace', 'list', '--json'],
      install: (plugin: string, scope: 'user' | 'project') => ['claude', 'plugin', 'install', '-s', scope, '--', plugin],
    },
    ...overrides,
  } as AgentProvider;
}

function app(
  runArgv: (argv: string[], cwd: string) => Promise<{ text: string; ok: boolean }>,
  opts: { listProviders?: () => Promise<AgentProvider[]>; resolveRepo?: (id: string) => Promise<string | null> } = {},
) {
  const f = Fastify();
  f.register(marketplaceRoutes, {
    runArgv,
    resolveRepo: opts.resolveRepo ?? (async (id: string) => (id === 'proj-1' ? '/repo' : null)),
    listProviders: opts.listProviders ?? (async () => [fakeProvider()]),
  });
  return f;
}

describe('GET /api/marketplace/plugins', () => {
  it('returns supported:true with parsed plugins + marketplaces + installed on happy JSON', async () => {
    const f = app(async (argv: string[]) => {
      if (argv.includes('--available')) {
        return {
          ok: true,
          text: JSON.stringify({
            available: [{ pluginId: 'foo@some-marketplace', name: 'foo', description: 'a plugin' }],
            installed: [
              {
                id: 'bar@some-marketplace',
                version: '1.0.0',
                scope: 'user',
                enabled: true,
                installPath: '/home/user/.claude/plugins/bar',
                installedAt: '2026-07-01T00:00:00Z',
                lastUpdated: '2026-07-01T00:00:00Z',
              },
            ],
          }),
        };
      }
      if (argv.includes('marketplace')) {
        return { ok: true, text: JSON.stringify([{ name: 'mkt-1' }]) };
      }
      throw new Error(`unexpected argv ${argv.join(' ')}`);
    });
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/plugins?projectId=proj-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      supported: true,
      plugins: [{ pluginId: 'foo@some-marketplace', name: 'foo', description: 'a plugin' }],
      marketplaces: [{ name: 'mkt-1' }],
      installed: [
        {
          id: 'bar@some-marketplace',
          version: '1.0.0',
          scope: 'user',
          enabled: true,
          installPath: '/home/user/.claude/plugins/bar',
          installedAt: '2026-07-01T00:00:00Z',
          lastUpdated: '2026-07-01T00:00:00Z',
        },
      ],
    });
  });

  it('missing installed key on available JSON -> installed defaults to [] (still supported)', async () => {
    const f = app(async (argv: string[]) => {
      if (argv.includes('--available')) {
        return { ok: true, text: JSON.stringify({ available: [{ pluginId: 'foo@mkt', name: 'foo' }] }) };
      }
      if (argv.includes('marketplace')) {
        return { ok: true, text: JSON.stringify([{ name: 'mkt-1' }]) };
      }
      throw new Error(`unexpected argv ${argv.join(' ')}`);
    });
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/plugins?projectId=proj-1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.supported).toBe(true);
    expect(body.installed).toEqual([]);
  });

  it('non-JSON output -> supported:false (not an error status)', async () => {
    const f = app(async () => ({ ok: true, text: 'not json' }));
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/plugins?projectId=proj-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ supported: false });
  });

  it('spawn error -> supported:false', async () => {
    const f = app(async () => ({ ok: false, text: 'command not found' }));
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/plugins?projectId=proj-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ supported: false });
  });

  it('no provider supports pluginCommands -> supported:false', async () => {
    const f = app(
      async () => ({ ok: true, text: '[]' }),
      { listProviders: async () => [{ id: 'claude' } as AgentProvider] },
    );
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/plugins?projectId=proj-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ supported: false });
  });

  it('unknown project -> supported:false (probe, not 404)', async () => {
    const f = app(async () => ({ ok: true, text: JSON.stringify({ available: [] }) }));
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/plugins?projectId=nope' });
    expect(res.statusCode).toBe(200);
    expect(res.json().supported).toBeDefined();
  });
});

describe('POST /api/marketplace/plugins/install', () => {
  it('installs and returns ok:true with output', async () => {
    const f = app(async () => ({ ok: true, text: 'Installed plugin "foo"' }));
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/plugins/install',
      payload: { projectId: 'proj-1', plugin: 'foo', scope: 'user' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, output: 'Installed plugin "foo"' });
  });

  it('502s with CLI output text on install failure', async () => {
    const f = app(async () => ({ ok: false, text: 'Failed to install plugin "foo": not found' }));
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/plugins/install',
      payload: { projectId: 'proj-1', plugin: 'foo', scope: 'user' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('not found');
  });

  it('400s a bad plugin name', async () => {
    const f = app(async () => {
      throw new Error('should not be called');
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/plugins/install',
      payload: { projectId: 'proj-1', plugin: 'bad plugin!', scope: 'user' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s a bad scope', async () => {
    const f = app(async () => {
      throw new Error('should not be called');
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/plugins/install',
      payload: { projectId: 'proj-1', plugin: 'foo', scope: 'local' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s an unknown project', async () => {
    const f = app(async () => {
      throw new Error('should not be called');
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/plugins/install',
      payload: { projectId: 'nope', plugin: 'foo', scope: 'user' },
    });
    expect(res.statusCode).toBe(404);
  });
});

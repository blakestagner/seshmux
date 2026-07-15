import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { tmpdir } from 'node:os';
import marketplaceRoutes from '../../server/routes/marketplace';
import type { AgentProvider } from '../../server/lib/providers/types';

// realpath() must resolve these, so use real, always-present directories rather
// than fake strings like '/repo' — cwd and the OS temp dir both exist everywhere
// tests run, and (unlike '/repo') are guaranteed to realpath-resolve.
const REPO_DIR = process.cwd();
const OTHER_DIR = tmpdir();

function fakeProvider(overrides: Partial<AgentProvider> = {}): AgentProvider {
  return {
    id: 'claude',
    pluginCommands: {
      listAvailable: () => ['claude', 'plugin', 'list', '--available', '--json'],
      listMarketplaces: () => ['claude', 'plugin', 'marketplace', 'list', '--json'],
      install: (plugin: string, scope: 'user' | 'project') => ['claude', 'plugin', 'install', '-s', scope, '--', plugin],
      uninstall: (plugin: string, scope: 'user' | 'project') => ['claude', 'plugin', 'uninstall', '-s', scope, '--', plugin],
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
      plugins: [
        { pluginId: 'foo@some-marketplace', name: 'foo', description: 'a plugin' },
        // synthesized: "bar" is installed but excluded from the CLI's
        // --available catalog, so it has no other source of a plugin row.
        { pluginId: 'bar@some-marketplace', name: 'bar', marketplaceName: 'some-marketplace' },
      ],
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

  it('installed plugin already present in --available output is not duplicated', async () => {
    const f = app(async (argv: string[]) => {
      if (argv.includes('--available')) {
        return {
          ok: true,
          text: JSON.stringify({
            available: [{ pluginId: 'foo@mkt', name: 'foo' }],
            installed: [{ id: 'foo@mkt', version: '1.0.0', scope: 'user', enabled: true, installPath: '/x', installedAt: '2026-07-01T00:00:00Z', lastUpdated: '2026-07-01T00:00:00Z' }],
          }),
        };
      }
      if (argv.includes('marketplace')) {
        return { ok: true, text: JSON.stringify([{ name: 'mkt-1' }]) };
      }
      throw new Error(`unexpected argv ${argv.join(' ')}`);
    });
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/plugins?projectId=proj-1' });
    expect(res.json().plugins).toEqual([{ pluginId: 'foo@mkt', name: 'foo' }]);
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
    const f = app(async () => {
      throw new Error('should not run the CLI for an unresolvable projectId');
    });
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/plugins?projectId=nope' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ supported: false });
  });

  it('drops a project-scope installed entry whose projectPath belongs to a different project', async () => {
    const f = app(
      async (argv: string[]) => {
        if (argv.includes('--available')) {
          return {
            ok: true,
            text: JSON.stringify({
              available: [],
              installed: [
                { id: 'foo@mkt', scope: 'project', projectPath: OTHER_DIR },
              ],
            }),
          };
        }
        return { ok: true, text: JSON.stringify([{ name: 'mkt-1' }]) };
      },
      { resolveRepo: async (id: string) => (id === 'proj-1' ? REPO_DIR : null) },
    );
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/plugins?projectId=proj-1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.supported).toBe(true);
    expect(body.installed).toEqual([]);
  });

  it('keeps a project-scope installed entry whose projectPath matches the requested project', async () => {
    const f = app(
      async (argv: string[]) => {
        if (argv.includes('--available')) {
          return {
            ok: true,
            text: JSON.stringify({
              available: [],
              installed: [{ id: 'foo@mkt', scope: 'project', projectPath: REPO_DIR }],
            }),
          };
        }
        return { ok: true, text: JSON.stringify([{ name: 'mkt-1' }]) };
      },
      { resolveRepo: async (id: string) => (id === 'proj-1' ? REPO_DIR : null) },
    );
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/plugins?projectId=proj-1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.installed).toEqual([{ id: 'foo@mkt', scope: 'project', projectPath: REPO_DIR }]);
  });

  it('always keeps user-scope installed entries regardless of project', async () => {
    const f = app(
      async (argv: string[]) => {
        if (argv.includes('--available')) {
          return {
            ok: true,
            text: JSON.stringify({
              available: [],
              installed: [{ id: 'foo@mkt', scope: 'user' }],
            }),
          };
        }
        return { ok: true, text: JSON.stringify([{ name: 'mkt-1' }]) };
      },
      { resolveRepo: async (id: string) => (id === 'proj-1' ? '/repo' : null) },
    );
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/plugins?projectId=proj-1' });
    expect(res.json().installed).toEqual([{ id: 'foo@mkt', scope: 'user' }]);
  });

  it('global request (no projectId) drops all project-scope entries but keeps user-scope', async () => {
    const f = app(async (argv: string[]) => {
      if (argv.includes('--available')) {
        return {
          ok: true,
          text: JSON.stringify({
            available: [],
            installed: [
              { id: 'foo@mkt', scope: 'project', projectPath: REPO_DIR },
              { id: 'bar@mkt', scope: 'user' },
            ],
          }),
        };
      }
      return { ok: true, text: JSON.stringify([{ name: 'mkt-1' }]) };
    });
    const res = await f.inject({ method: 'GET', url: '/api/marketplace/plugins' });
    expect(res.statusCode).toBe(200);
    expect(res.json().installed).toEqual([{ id: 'bar@mkt', scope: 'user' }]);
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

  it('404s an unknown project for PROJECT-scope installs', async () => {
    const f = app(async () => {
      throw new Error('should not be called');
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/plugins/install',
      payload: { projectId: 'nope', plugin: 'foo', scope: 'project' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('user-scope install works without a project (global modal), cwd-independent', async () => {
    let argv: string[] = [];
    const f = app(async (a: string[]) => {
      argv = a;
      return { text: 'installed', ok: true };
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/plugins/install',
      payload: { plugin: 'foo@mkt', scope: 'user' },
    });
    expect(res.statusCode).toBe(200);
    expect(argv).toEqual(['claude', 'plugin', 'install', '-s', 'user', '--', 'foo@mkt']);
  });
});

describe('POST /api/marketplace/plugins/uninstall', () => {
  it('uninstalls and returns ok:true with output, argv passthrough', async () => {
    let argv: string[] = [];
    const f = app(async (a: string[]) => {
      argv = a;
      return { ok: true, text: 'Uninstalled plugin "foo"' };
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/plugins/uninstall',
      payload: { projectId: 'proj-1', plugin: 'foo', scope: 'user' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, output: 'Uninstalled plugin "foo"' });
    expect(argv).toEqual(['claude', 'plugin', 'uninstall', '-s', 'user', '--', 'foo']);
  });

  it('502s with CLI output text on uninstall failure', async () => {
    const f = app(async () => ({ ok: false, text: 'Failed to uninstall plugin "foo": not installed' }));
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/plugins/uninstall',
      payload: { projectId: 'proj-1', plugin: 'foo', scope: 'user' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('not installed');
  });

  it('400s a bad plugin name', async () => {
    const f = app(async () => {
      throw new Error('should not be called');
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/plugins/uninstall',
      payload: { projectId: 'proj-1', plugin: 'bad plugin!', scope: 'user' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s an unknown project for PROJECT-scope uninstalls', async () => {
    const f = app(async () => {
      throw new Error('should not be called');
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/plugins/uninstall',
      payload: { projectId: 'nope', plugin: 'foo', scope: 'project' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('user-scope uninstall works without a project (global modal), cwd-independent', async () => {
    let argv: string[] = [];
    const f = app(async (a: string[]) => {
      argv = a;
      return { text: 'uninstalled', ok: true };
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/plugins/uninstall',
      payload: { plugin: 'foo@mkt', scope: 'user' },
    });
    expect(res.statusCode).toBe(200);
    expect(argv).toEqual(['claude', 'plugin', 'uninstall', '-s', 'user', '--', 'foo@mkt']);
  });
});

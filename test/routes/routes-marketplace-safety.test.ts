import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { AgentProvider } from '../../server/lib/providers/types';
import marketplaceRoutes from '../../server/routes/marketplace';

const SHA = 'a'.repeat(40);

function makeProvider(overrides: Partial<AgentProvider> = {}): AgentProvider {
  return {
    id: 'claude',
    label: 'Claude',
    commands: {
      launch: () => [],
      resume: () => [],
      headlessAsk: (cwd: string, prompt: string) => ['claude', '-p', '--', prompt],
    },
    scanProjects: async () => [],
    ...overrides,
  } as unknown as AgentProvider;
}

function app(options: {
  fetchText: (url: string) => Promise<string>;
  resolveRepo?: (projectId: string) => Promise<string | null>;
  listProviders?: () => Promise<AgentProvider[]>;
  runArgv?: (argv: string[], cwd: string) => Promise<{ text: string; ok: boolean; stderr?: string }>;
}) {
  const f = Fastify();
  f.register(marketplaceRoutes, {
    fetchText: options.fetchText,
    resolveRepo: options.resolveRepo ?? (async (id: string) => (id === 'proj-1' ? '/repo' : null)),
    listProviders: options.listProviders ?? (async () => [makeProvider()]),
    runArgv: options.runArgv,
  });
  return f;
}

const treeUrl = (owner: string, repo: string) => `https://api.github.com/repos/${owner}/${repo}/git/trees/${SHA}?recursive=1`;
const rawUrl = (owner: string, repo: string, path: string) =>
  `https://raw.githubusercontent.com/${owner}/${repo}/${SHA}/${path}`;

function goodBody(overrides: Record<string, unknown> = {}) {
  return {
    source: 'acme/safety-repo',
    sha: SHA,
    path: 'skills/foo',
    provider: 'claude',
    projectId: 'proj-1',
    ...overrides,
  };
}

describe('POST /api/marketplace/safety-check', () => {
  it('400s a bad source', async () => {
    const f = app({ fetchText: async () => { throw new Error('should not be called'); } });
    const res = await f.inject({ method: 'POST', url: '/api/marketplace/safety-check', payload: goodBody({ source: 'nope' }) });
    expect(res.statusCode).toBe(400);
  });

  it('400s a bad sha', async () => {
    const f = app({ fetchText: async () => { throw new Error('should not be called'); } });
    const res = await f.inject({ method: 'POST', url: '/api/marketplace/safety-check', payload: goodBody({ sha: 'nope' }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad sha');
  });

  it('400s a missing path', async () => {
    const f = app({ fetchText: async () => { throw new Error('should not be called'); } });
    const res = await f.inject({ method: 'POST', url: '/api/marketplace/safety-check', payload: goodBody({ path: '' }) });
    expect(res.statusCode).toBe(400);
  });

  it('404s an unknown project', async () => {
    const f = app({ fetchText: async () => { throw new Error('should not be called'); } });
    const res = await f.inject({ method: 'POST', url: '/api/marketplace/safety-check', payload: goodBody({ projectId: 'nope' }) });
    expect(res.statusCode).toBe(404);
  });

  it('400s when the provider lacks headlessAsk', async () => {
    const f = app({
      fetchText: async () => { throw new Error('should not be called'); },
      listProviders: async () => [makeProvider({ commands: { launch: () => [], resume: () => [] } as any })],
    });
    const res = await f.inject({ method: 'POST', url: '/api/marketplace/safety-check', payload: goodBody() });
    expect(res.statusCode).toBe(400);
  });

  it('404s an unknown provider id', async () => {
    const f = app({ fetchText: async () => { throw new Error('should not be called'); } });
    const res = await f.inject({ method: 'POST', url: '/api/marketplace/safety-check', payload: goodBody({ provider: 'nonexistent' }) });
    expect(res.statusCode).toBe(400);
  });

  it('runs headlessAsk with the prompt as ONE argv element and parses strict JSON', async () => {
    const tree = { tree: [{ path: 'skills/foo/SKILL.md', type: 'blob' }] };
    const fetchText = async (url: string) => {
      if (url === treeUrl('acme', 'runs-repo')) return JSON.stringify(tree);
      if (url === rawUrl('acme', 'runs-repo', 'skills/foo/SKILL.md')) return '---\nname: foo\n---\nbody';
      throw new Error(`unexpected url ${url}`);
    };
    let capturedArgv: string[] | undefined;
    const runArgv = vi.fn(async (argv: string[]) => {
      capturedArgv = argv;
      return { text: '{"verdict":"caution","concerns":["x"]}', ok: true };
    });
    const f = app({ fetchText, runArgv });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/safety-check',
      payload: goodBody({ source: 'acme/runs-repo' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ verdict: 'caution', concerns: ['x'], cached: false });
    expect(runArgv).toHaveBeenCalledTimes(1);
    expect(capturedArgv).toEqual(['claude', '-p', '--', expect.any(String)]);
    // prompt is one argv element; no other element carries file content
    expect(capturedArgv![3]).toContain('body');
  });

  it('unparseable output → 502 review output unparseable', async () => {
    const tree = { tree: [{ path: 'skills/foo/SKILL.md', type: 'blob' }] };
    const fetchText = async (url: string) => {
      if (url === treeUrl('acme', 'bad-json-repo')) return JSON.stringify(tree);
      if (url === rawUrl('acme', 'bad-json-repo', 'skills/foo/SKILL.md')) return '---\nname: foo\n---\nbody';
      throw new Error(`unexpected url ${url}`);
    };
    const runArgv = vi.fn(async () => ({ text: 'sure thing, looks fine to me', ok: true }));
    const f = app({ fetchText, runArgv });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/safety-check',
      payload: goodBody({ source: 'acme/bad-json-repo' }),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('review output unparseable');
  });

  it('provider failure → 502 with provider text', async () => {
    const tree = { tree: [{ path: 'skills/foo/SKILL.md', type: 'blob' }] };
    const fetchText = async (url: string) => {
      if (url === treeUrl('acme', 'fail-provider-repo')) return JSON.stringify(tree);
      if (url === rawUrl('acme', 'fail-provider-repo', 'skills/foo/SKILL.md')) return '---\nname: foo\n---\nbody';
      throw new Error(`unexpected url ${url}`);
    };
    const runArgv = vi.fn(async () => ({ text: 'provider exploded', ok: false }));
    const f = app({ fetchText, runArgv });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/safety-check',
      payload: goodBody({ source: 'acme/fail-provider-repo' }),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('provider exploded');
  });

  it('cache: second identical call skips the provider and returns cached:true', async () => {
    const tree = { tree: [{ path: 'skills/foo/SKILL.md', type: 'blob' }] };
    const fetchText = async (url: string) => {
      if (url === treeUrl('acme', 'cache-repo')) return JSON.stringify(tree);
      if (url === rawUrl('acme', 'cache-repo', 'skills/foo/SKILL.md')) return '---\nname: foo\n---\nbody';
      throw new Error(`unexpected url ${url}`);
    };
    const runArgv = vi.fn(async () => ({ text: '{"verdict":"ok","concerns":[]}', ok: true }));
    const f = app({ fetchText, runArgv });
    const body = goodBody({ source: 'acme/cache-repo' });

    const res1 = await f.inject({ method: 'POST', url: '/api/marketplace/safety-check', payload: body });
    expect(res1.statusCode).toBe(200);
    expect(res1.json()).toEqual({ verdict: 'ok', concerns: [], cached: false });

    const res2 = await f.inject({ method: 'POST', url: '/api/marketplace/safety-check', payload: body });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual({ verdict: 'ok', concerns: [], cached: true });

    expect(runArgv).toHaveBeenCalledTimes(1);
  });
});

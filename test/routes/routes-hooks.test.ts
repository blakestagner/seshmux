// Hooks route tests: NEVER exercise against the real getProviders()/ClaudeProvider
// (that would touch the real ~/.claude/settings.json). Always inject a fake
// provider list with a stub statusHooks pointed at test-local state.

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import hooksRoutes from '../../server/routes/hooks';
import type { AgentProvider, StatusHookSupport } from '../../server/lib/providers/types';

function fakeStatusHooks(initial: { installed: boolean; upToDate: boolean; version: number | null }): StatusHookSupport {
  let state = { ...initial };
  return {
    hooksAvailable: () => true,
    installHooks: async () => {
      state = { installed: true, upToDate: true, version: 1 };
    },
    uninstallHooks: async () => {
      state = { installed: false, upToDate: false, version: null };
    },
    hooksInstallState: async () => state,
  };
}

function fakeProvider(id: 'claude' | 'codex', statusHooks?: StatusHookSupport): AgentProvider {
  return {
    id,
    detect: async () => ({ found: true }),
    scanProjects: async () => [],
    listSessions: async () => [],
    parseTranscript: async () => ({ msgs: [], ctx: null }),
    readCtx: async () => null,
    search: async () => [],
    usage: async () => ({ sessions: 0, totalTokens: 0, cacheReads: 0, estCostUsd: 0, byProject: [], byProvider: [] }),
    commands: {
      fresh: () => [id],
      continue: () => [id],
      resume: () => [id],
      headlessPlan: () => [id],
      headlessAsk: () => [id],
    },
    needsInputPatterns: [],
    statusHooks,
  };
}

describe('GET /api/hooks/status', () => {
  it('reports availability per provider, codex without statusHooks reports unavailable', async () => {
    const f = Fastify();
    f.register(hooksRoutes, {
      getProviders: async () => [
        fakeProvider('claude', fakeStatusHooks({ installed: false, upToDate: false, version: null })),
        fakeProvider('codex'), // no statusHooks — codex stays heuristics-only
      ],
    });
    const res = await f.inject({ method: 'GET', url: '/api/hooks/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.claude).toEqual({ available: true, installed: false, upToDate: false, version: null });
    expect(body.codex).toEqual({ available: false, installed: false, upToDate: false, version: null });
  });
});

describe('POST /api/hooks/install', () => {
  it('installs and returns the updated state', async () => {
    const f = Fastify();
    const hooks = fakeStatusHooks({ installed: false, upToDate: false, version: null });
    f.register(hooksRoutes, {
      getProviders: async () => [fakeProvider('claude', hooks)],
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/hooks/install',
      payload: { provider: 'claude' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, installed: true, upToDate: true, version: 1 });
  });

  it('400s for a provider with no statusHooks support (codex)', async () => {
    const f = Fastify();
    f.register(hooksRoutes, { getProviders: async () => [fakeProvider('codex')] });
    const res = await f.inject({
      method: 'POST',
      url: '/api/hooks/install',
      payload: { provider: 'codex' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('500s and reports the error when installHooks throws (e.g. malformed settings.json)', async () => {
    const f = Fastify();
    const hooks: StatusHookSupport = {
      hooksAvailable: () => true,
      installHooks: async () => {
        throw new Error('settings.json is not valid JSON');
      },
      uninstallHooks: async () => {},
      hooksInstallState: async () => ({ installed: false, upToDate: false, version: null }),
    };
    f.register(hooksRoutes, { getProviders: async () => [fakeProvider('claude', hooks)] });
    const res = await f.inject({
      method: 'POST',
      url: '/api/hooks/install',
      payload: { provider: 'claude' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/not valid JSON/i);
  });
});

describe('POST /api/hooks/uninstall', () => {
  it('uninstalls and returns the updated state', async () => {
    const f = Fastify();
    const hooks = fakeStatusHooks({ installed: true, upToDate: true, version: 1 });
    f.register(hooksRoutes, { getProviders: async () => [fakeProvider('claude', hooks)] });
    const res = await f.inject({
      method: 'POST',
      url: '/api/hooks/uninstall',
      payload: { provider: 'claude' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, installed: false, upToDate: false, version: null });
  });

  it('400s for an unknown provider id', async () => {
    const f = Fastify();
    f.register(hooksRoutes, { getProviders: async () => [fakeProvider('claude')] });
    const res = await f.inject({
      method: 'POST',
      url: '/api/hooks/uninstall',
      payload: { provider: 'nonexistent' },
    });
    expect(res.statusCode).toBe(400);
  });
});

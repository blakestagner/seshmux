import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import teamRoutes, { type TeamRouteDeps } from '../../server/routes/teams';
import * as teamsLib from '../../server/lib/teams';

const origin = 'http://127.0.0.1:4700';
let repo: string;
let configDir: string;
let prevConfigDir: string | undefined;

function makeApp(over: Partial<TeamRouteDeps> = {}) {
  const calls: any[] = [];
  const deps: TeamRouteDeps = {
    resolveRepo: () => repo,
    resolveProjectProvider: async () => 'claude',
    startSession: async (i) => {
      calls.push(i);
      return {
        ptyId: 'p1',
        tabMeta: { ptyId: 'p1', provider: 'claude', projectPath: i.projectPath, mode: 'new', tmux: true },
      };
    },
    ...over,
  };
  const f = Fastify();
  f.register(teamRoutes, deps);
  return { f, calls };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'teamsroute-repo-'));
  configDir = mkdtempSync(join(tmpdir(), 'teamsroute-config-'));
  prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
  process.env.SESHMUX_CONFIG_DIR = configDir;
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
  else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
});

describe('POST /api/teams/start', () => {
  it('composes the prompt and spawns via the SHARED startSession', async () => {
    const { f, calls } = makeApp();
    const res = await f.inject({
      method: 'POST',
      url: '/api/teams/start',
      headers: { origin },
      payload: {
        projectId: 'proj',
        inline: { name: 'Recon', members: [{ name: 'scout', role: 'map', model: 'sonnet' }] },
        task: 'audit auth',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].provider).toBe('claude');
    expect(calls[0].projectPath).toBe(repo);
    expect(calls[0].firstPrompt).toContain('Recon');
    expect(calls[0].firstPrompt).toContain('scout');
    expect(calls[0].firstPrompt).toContain('audit auth');
    expect(res.json().tabMeta.ptyId).toBe('p1');
  });

  it('saveTemplate:true persists the inline team as a template', async () => {
    const { f } = makeApp();
    const res = await f.inject({
      method: 'POST',
      url: '/api/teams/start',
      headers: { origin },
      payload: {
        projectId: 'proj',
        inline: { name: 'Recon', members: [{ name: 'scout', role: 'map' }] },
        task: 'audit auth',
        saveTemplate: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const templates = await teamsLib.listTemplates();
    expect(templates.some((t) => t.name === 'Recon')).toBe(true);
  });

  it('400s when template is valid but the inline to save is not (never persist junk)', async () => {
    const { f, calls } = makeApp();
    const res = await f.inject({
      method: 'POST',
      url: '/api/teams/start',
      headers: { origin },
      payload: {
        projectId: 'proj',
        template: { name: 'Recon', members: [{ name: 'scout', role: 'map' }] },
        inline: {},
        task: 'audit auth',
        saveTemplate: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    expect(await teamsLib.listTemplates()).toEqual([]);
  });

  it('400s on a malformed member shape (missing role / empty name / bad model)', async () => {
    const { f, calls } = makeApp();
    for (const members of [
      [{ name: 'scout' }], // no role
      [{ name: '', role: 'map' }], // empty name
      [{ name: 'scout', role: 'map', model: 'gpt-5' }], // unknown model
    ]) {
      const res = await f.inject({
        method: 'POST',
        url: '/api/teams/start',
        headers: { origin },
        payload: { projectId: 'proj', inline: { name: 'Recon', members }, task: 'audit auth' },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects a codex projectId (teams are claude-only)', async () => {
    const { f, calls } = makeApp({ resolveProjectProvider: async () => 'codex' });
    const res = await f.inject({
      method: 'POST',
      url: '/api/teams/start',
      headers: { origin },
      payload: {
        projectId: 'proj',
        inline: { name: 'Recon', members: [{ name: 'scout', role: 'map' }] },
        task: 'audit auth',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('templates CRUD', () => {
  it('GET/POST/DELETE round-trips templates', async () => {
    const { f } = makeApp();

    const empty = await f.inject({ method: 'GET', url: '/api/teams', headers: { origin } });
    expect(empty.json()).toEqual([]);

    const created = await f.inject({
      method: 'POST',
      url: '/api/teams',
      headers: { origin },
      payload: { name: 'Recon', members: [{ name: 'scout', role: 'map' }] },
    });
    expect(created.statusCode).toBe(200);

    const listed = await f.inject({ method: 'GET', url: '/api/teams', headers: { origin } });
    expect(listed.json()).toHaveLength(1);
    expect(listed.json()[0].name).toBe('Recon');

    const deleted = await f.inject({ method: 'DELETE', url: '/api/teams?name=Recon', headers: { origin } });
    expect(deleted.statusCode).toBe(200);

    const listedAfter = await f.inject({ method: 'GET', url: '/api/teams', headers: { origin } });
    expect(listedAfter.json()).toEqual([]);
  });
});

describe('GET /api/teams/members', () => {
  it('404s when the roster cannot be resolved', async () => {
    const { f } = makeApp({ teamRoster: async () => null });
    const res = await f.inject({ method: 'GET', url: '/api/teams/members?teamName=nope', headers: { origin } });
    expect(res.statusCode).toBe(404);
  });

  it('resolves by leadSession when teamName is absent', async () => {
    const info = { teamName: 'Recon', leadSessionId: 'lead-1', createdAt: 1, members: [] };
    const { f } = makeApp({ teamByLeadSession: async (id) => (id === 'lead-1' ? info : null) });
    const res = await f.inject({ method: 'GET', url: '/api/teams/members?leadSession=lead-1', headers: { origin } });
    expect(res.statusCode).toBe(200);
    expect(res.json().teamName).toBe('Recon');
  });

  // The ?leadSession= probe fires for EVERY rehydrated/resumed session, and "not a team
  // lead" is the answer for nearly all of them. A 404 there painted the devtools console
  // red on every page load (the browser logs the failed request even though the client
  // catches it). It's a question, not a resource fetch — answer it with 200 + null.
  it('answers 200 + null (not 404) when the session simply is not a team lead', async () => {
    const { f } = makeApp({ teamByLeadSession: async () => null });
    const res = await f.inject({ method: 'GET', url: '/api/teams/members?leadSession=not-a-lead', headers: { origin } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
  });

  // ...but ?teamName= DOES name a resource, so a miss there is still a genuine 404.
  it('still 404s an unknown teamName — that one names a resource', async () => {
    const { f } = makeApp({ teamRoster: async () => null });
    const res = await f.inject({ method: 'GET', url: '/api/teams/members?teamName=ghost', headers: { origin } });
    expect(res.statusCode).toBe(404);
  });

  it('arms the events-hub team watch (Task 4) with the resolved config path, once per request', async () => {
    const info = { teamName: 'Recon', leadSessionId: 'lead-1', createdAt: 1, members: [] };
    const armed: any[] = [];
    const { f } = makeApp({
      teamRoster: async (name) => (name === 'Recon' ? info : null),
      teamConfigPath: async (name) => `/fake/teams/${name}/config.json`,
      onTeamWatch: (teamName, leadSessionId, configPath) => armed.push({ teamName, leadSessionId, configPath }),
    });
    const res = await f.inject({ method: 'GET', url: '/api/teams/members?teamName=Recon', headers: { origin } });
    expect(res.statusCode).toBe(200);
    expect(armed).toEqual([{ teamName: 'Recon', leadSessionId: 'lead-1', configPath: '/fake/teams/Recon/config.json' }]);
  });

  it('does not call onTeamWatch when the roster 404s', async () => {
    const armed: any[] = [];
    const { f } = makeApp({ teamRoster: async () => null, onTeamWatch: (...a) => armed.push(a) });
    const res = await f.inject({ method: 'GET', url: '/api/teams/members?teamName=nope', headers: { origin } });
    expect(res.statusCode).toBe(404);
    expect(armed).toHaveLength(0);
  });

  it('400s a path-traversal teamName without ever calling the provider', async () => {
    const calls: string[] = [];
    const { f } = makeApp({
      teamRoster: async (name) => {
        calls.push(name);
        return null;
      },
    });
    for (const bad of ['../../../../etc', '..%2f..%2fetc', 'foo/bar', 'foo\\bar', '..']) {
      const res = await f.inject({
        method: 'GET',
        url: `/api/teams/members?teamName=${encodeURIComponent(bad)}`,
        headers: { origin },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
});

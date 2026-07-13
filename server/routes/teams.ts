// GET    /api/teams              -> TeamTemplate[]
// POST   /api/teams               -> save a template
// DELETE /api/teams?name=         -> delete a template
// POST   /api/teams/start         -> compose prompt, spawn lead via SHARED startSession
// GET    /api/teams/members       -> roster read (?teamName= or ?leadSession=)
//
// Teams are claude-only (native claude-swarm teammates) — spawning reuses the SHARED
// startSession() (hard rule: one spawn path). The on-disk team name is never user-
// controlled (always claude's auto session-<hex>), so /start never resolves a team
// name — it returns the lead's tabMeta immediately; the client resolves the roster
// later via /members (leadSession watch, Task 4).

import type { FastifyInstance } from 'fastify';
import { getProviders, type ProviderId, type TeamInfo } from '../lib/providers/types';
import { decodeProjectDir } from '../lib/store/scan';
import * as teamsLib from '../lib/teams';
import type { TeamMemberTemplate } from '../lib/teams';
import { startSession, type StartSessionResult } from '../session-start';

interface TeamDef { name: string; members: TeamMemberTemplate[] }

export interface TeamRouteDeps {
  // Mirrors workspaces.ts's defaultResolveRepo — injectable for tests.
  resolveRepo?: (projectId: string) => string | null | Promise<string | null>;
  // Which provider a projectId belongs to (mirrors bridge.ts's resolveSessionProvider
  // shape) — used to reject non-claude projects on /start. Injectable for tests.
  resolveProjectProvider?: (projectId: string) => Promise<ProviderId | null>;
  startSession?: (input: Parameters<typeof startSession>[0]) => Promise<StartSessionResult>;
  listTemplates?: typeof teamsLib.listTemplates;
  saveTemplate?: typeof teamsLib.saveTemplate;
  deleteTemplate?: typeof teamsLib.deleteTemplate;
  teamRoster?: (teamName: string) => Promise<TeamInfo | null>;
  teamByLeadSession?: (leadSessionId: string) => Promise<TeamInfo | null>;
  // Resolve a team's config.json absolute path via the claude provider (hard
  // rule 3 — the route is the one place already going through the provider;
  // the hub never constructs the path itself). Injectable for tests.
  teamConfigPath?: (teamName: string) => Promise<string | null>;
  // Task 4: arm the events-hub's lazy config.json watch on first roster
  // request. Optional — omitted in tests that don't care about live push.
  onTeamWatch?: (teamName: string, leadSessionId: string, configPath: string) => void;
}

async function isDir(path: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const MODELS = ['opus', 'sonnet', 'haiku'];

// Real team names are claude's auto session-<hex> or a human-typed template
// name — never a path segment. teamName flows straight into
// join(teamsRoot, teamName, 'config.json') in teams-store, so an unvalidated
// value (e.g. `../../../../etc`) is a path-traversal vector into an arbitrary
// config.json, including arming a chokidar watch on it. Allowlist rather than
// blocklist: reject anything but this safe charset.
const SAFE_TEAM_NAME = /^[A-Za-z0-9._-]+$/;
function isSafeTeamName(name: string): boolean {
  return SAFE_TEAM_NAME.test(name) && !name.includes('..');
}

function isTeamDef(v: unknown): v is TeamDef {
  if (!v || typeof v !== 'object') return false;
  const t = v as Partial<TeamDef>;
  return (
    typeof t.name === 'string' &&
    !!t.name &&
    Array.isArray(t.members) &&
    t.members.length > 0 &&
    t.members.every(
      (m) =>
        !!m &&
        typeof m === 'object' &&
        typeof m.name === 'string' &&
        !!m.name.trim() &&
        typeof m.role === 'string' &&
        !!m.role.trim() &&
        (m.model === undefined || MODELS.includes(m.model)),
    )
  );
}

export default async function teamRoutes(f: FastifyInstance, deps: TeamRouteDeps = {}) {
  const defaultResolveRepo = async (id: string): Promise<string | null> => {
    const providers = await getProviders();
    for (const p of providers) {
      const projects = await p.scanProjects().catch(() => []);
      const hit = projects.find((pr) => pr.id === id);
      if (hit) return hit.path;
    }
    return decodeProjectDir(id).path;
  };
  const defaultResolveProjectProvider = async (id: string): Promise<ProviderId | null> => {
    const providers = await getProviders();
    for (const p of providers) {
      const projects = await p.scanProjects().catch(() => []);
      if (projects.some((pr) => pr.id === id)) return p.id;
    }
    return null;
  };
  const defaultTeamRoster = async (teamName: string): Promise<TeamInfo | null> => {
    const providers = await getProviders();
    const claude = providers.find((p) => p.id === 'claude');
    return claude?.teams ? claude.teams.teamRoster(teamName) : null;
  };
  const defaultTeamByLeadSession = async (leadSessionId: string): Promise<TeamInfo | null> => {
    const providers = await getProviders();
    const claude = providers.find((p) => p.id === 'claude');
    return claude?.teams ? claude.teams.teamByLeadSession(leadSessionId) : null;
  };
  const defaultTeamConfigPath = async (teamName: string): Promise<string | null> => {
    const providers = await getProviders();
    const claude = providers.find((p) => p.id === 'claude');
    return claude?.teams ? claude.teams.configPath(teamName) : null;
  };

  const resolveRepo = deps.resolveRepo ?? defaultResolveRepo;
  const resolveProjectProvider = deps.resolveProjectProvider ?? defaultResolveProjectProvider;
  const doStart = deps.startSession ?? startSession;
  const doList = deps.listTemplates ?? teamsLib.listTemplates;
  const doSave = deps.saveTemplate ?? teamsLib.saveTemplate;
  const doDelete = deps.deleteTemplate ?? teamsLib.deleteTemplate;
  const doTeamRoster = deps.teamRoster ?? defaultTeamRoster;
  const doTeamByLeadSession = deps.teamByLeadSession ?? defaultTeamByLeadSession;
  const doTeamConfigPath = deps.teamConfigPath ?? defaultTeamConfigPath;

  // GET /api/teams -> saved templates.
  f.get('/api/teams', async () => doList());

  // POST /api/teams { name, members } -> save a template.
  f.post<{ Body: { name?: string; members?: TeamMemberTemplate[] } }>('/api/teams', async (req, reply) => {
    const body = req.body ?? {};
    if (!isTeamDef(body)) {
      reply.code(400);
      return { error: 'name and a non-empty members[] are required' };
    }
    return doSave(body);
  });

  // DELETE /api/teams?name= -> delete a template.
  f.delete<{ Querystring: { name?: string } }>('/api/teams', async (req, reply) => {
    const { name } = req.query;
    if (!name) {
      reply.code(400);
      return { error: 'name is required' };
    }
    await doDelete(name);
    return { ok: true };
  });

  // POST /api/teams/start { projectId, template?, inline?, task, saveTemplate? }
  // -> compose prompt from template|inline + task, spawn the lead via the SHARED
  // startSession. Teams are claude-only; non-claude projects 400.
  f.post<{
    Body: {
      projectId?: string;
      template?: TeamDef;
      inline?: TeamDef;
      task?: string;
      saveTemplate?: boolean;
    };
  }>('/api/teams/start', async (req, reply) => {
    const { projectId, template, inline, task, saveTemplate } = req.body ?? {};
    if (typeof projectId !== 'string' || !projectId) {
      reply.code(400);
      return { error: 'projectId is required' };
    }
    if (typeof task !== 'string' || !task.trim()) {
      reply.code(400);
      return { error: 'task is required' };
    }
    const def = template ?? inline;
    if (!isTeamDef(def)) {
      reply.code(400);
      return { error: 'template or inline (with name + non-empty members[]) is required' };
    }
    // saveTemplate persists `inline` specifically — validate it even when a
    // valid `template` was what passed the check above.
    if (saveTemplate && inline && !isTeamDef(inline)) {
      reply.code(400);
      return { error: 'inline is invalid; cannot save as template' };
    }

    const projectProvider = await resolveProjectProvider(projectId);
    if (projectProvider !== 'claude') {
      reply.code(400);
      return { error: 'teams are claude-only' };
    }

    const repo = await resolveRepo(projectId);
    if (!repo || !(await isDir(repo))) {
      reply.code(404);
      return { error: 'project not found' };
    }

    const firstPrompt = teamsLib.composeTeamPrompt(def, task);
    const result = await doStart({ projectPath: repo, provider: 'claude', mode: 'new', firstPrompt });

    if (saveTemplate && inline) {
      await doSave({ name: inline.name, members: inline.members });
    }

    return { tabMeta: result.tabMeta };
  });

  // GET /api/teams/members?teamName=|leadSession= -> roster panel data.
  f.get<{ Querystring: { teamName?: string; leadSession?: string } }>(
    '/api/teams/members',
    async (req, reply) => {
      const { teamName, leadSession } = req.query;
      if (!teamName && !leadSession) {
        reply.code(400);
        return { error: 'teamName or leadSession is required' };
      }
      if (teamName && !isSafeTeamName(teamName)) {
        reply.code(400);
        return { error: 'invalid teamName' };
      }
      const info = teamName ? await doTeamRoster(teamName) : await doTeamByLeadSession(leadSession as string);
      if (!info) {
        // ?teamName= names a resource: not finding it IS an error -> 404.
        // ?leadSession= is a QUESTION ("is this session a team lead?"), asked once per
        // rehydrated/resumed session. "No" is the normal answer for almost every session,
        // so answering 404 painted the console red on the happy path even though the client
        // catches it (the browser logs a failed request regardless). Answer 200 + null.
        if (teamName) {
          reply.code(404);
          return { error: 'team not found' };
        }
        return null;
      }
      // Task 4: arm the live-roster watch on first request for this team —
      // idempotent on the hub side, so every subsequent /members poll is a no-op here.
      if (deps.onTeamWatch) {
        const configPath = await doTeamConfigPath(info.teamName);
        if (configPath) deps.onTeamWatch(info.teamName, info.leadSessionId, configPath);
      }
      return info;
    },
  );
}

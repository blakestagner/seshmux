// Teams v1 roster reader. PROVIDER-AGNOSTIC by design (mirrors scan.ts): the
// `~/.claude/teams` path is NOT hardcoded here (hard rule 3) — the caller
// (server/lib/providers/claude.ts) supplies both `teamsRoot` and `projectsRoot`.
// This file only knows the on-disk shape of a team's config.json plus how to join
// its members against teammate session jsonls (via scan.ts's readHead cache).

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readDirSessions } from './scan';
import { Lru } from './lru';

export interface TeamMemberInfo {
  name: string;
  agentType?: string;
  model?: string;
  color?: string;
  role?: string; // config.prompt
  backendType?: 'tmux' | 'in-process';
  isActive?: boolean;
  joinedAt: number;
  sessionId: string | null; // resolved teammate session id, or null (in-process/no jsonl yet)
}

export interface TeamInfo {
  teamName: string;
  leadSessionId: string;
  createdAt: number;
  members: TeamMemberInfo[];
}

interface RawTeamConfig {
  leadSessionId: string;
  createdAt: number;
  members: Array<{
    name: string;
    agentType?: string;
    model?: string;
    color?: string;
    prompt?: string;
    backendType?: 'tmux' | 'in-process';
    isActive?: boolean;
    joinedAt: number;
  }>;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

// Memoize resolved TeamInfo keyed by (config.json path, config.json mtime) — a fresh mtime
// (a join/leave rewrites config.json) is a new key that re-resolves; the stale key ages out.
// LRU-bounded (S4-8): a plain Map grew one entry per (team × config revision) forever over
// server uptime. 200 covers far more live teams than any local session realistically has.
const rosterCache = new Lru<TeamInfo | null>(200);

// Which project dir under `projectsRoot` holds `<leadSessionId>.jsonl`. Bounded: one
// readdir of the top-level project dirs + one stat per dir (existence check only, no
// jsonl content read) — O(projects), never O(sessions).
async function findLeadProjectDir(projectsRoot: string, leadSessionId: string): Promise<string | null> {
  let dirents;
  try {
    dirents = await readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const candidate = join(projectsRoot, d.name, `${leadSessionId}.jsonl`);
    try {
      await stat(candidate);
      return join(projectsRoot, d.name);
    } catch {
      /* lead session not in this project dir */
    }
  }
  return null;
}

// Resolve a tmux teammate's own session id by scanning ONLY the lead's project dir
// (never the whole store — bounded to one dir) for a jsonl head stamped with this
// team+member name. Reuses scan.ts's readHead (file, mtime) cache via
// readDirSessions, so a session already read elsewhere isn't re-parsed here.
async function findMemberSession(
  projectsRoot: string,
  leadSessionId: string,
  teamName: string,
  memberName: string,
): Promise<string | null> {
  const dirPath = await findLeadProjectDir(projectsRoot, leadSessionId);
  if (!dirPath) return null;
  const metas = await readDirSessions(dirPath, '', 'claude');
  const hit = metas
    .filter((m) => m.teamName === teamName && m.agentName === memberName)
    .sort((a, b) => b.mtime - a.mtime)[0]; // most recent jsonl wins if somehow >1
  return hit ? hit.id : null;
}

export async function teamRoster(teamsRoot: string, projectsRoot: string, teamName: string): Promise<TeamInfo | null> {
  const configPath = join(teamsRoot, teamName, 'config.json');
  let mtime: number;
  try {
    mtime = (await stat(configPath)).mtimeMs;
  } catch {
    return null; // no such team
  }

  return rosterCache.get(`${configPath}:${mtime}`, async () => {
    const cfg = await readJson<RawTeamConfig>(configPath);
    if (!cfg) return null;
    const leadName = cfg.members.find((m) => m.agentType === 'team-lead')?.name;

    const members: TeamMemberInfo[] = [];
    for (const m of cfg.members) {
      const sessionId =
        m.name === leadName
          ? cfg.leadSessionId
          : m.backendType === 'tmux'
            ? await findMemberSession(projectsRoot, cfg.leadSessionId, teamName, m.name)
            : null; // in-process member: no own jsonl
      members.push({
        name: m.name,
        agentType: m.agentType,
        model: m.model,
        color: m.color,
        role: m.prompt,
        backendType: m.backendType,
        isActive: m.isActive,
        joinedAt: m.joinedAt,
        sessionId,
      });
    }

    return { teamName, leadSessionId: cfg.leadSessionId, createdAt: cfg.createdAt, members };
  });
}

// Bound the `teams/*/config.json` glob to the most mtime-recent team dirs, not an
// unbounded sweep of every team ever created — resolving a live lead session only
// ever needs a recently-touched team.
const MAX_TEAMS_SCANNED = 200;

export async function teamByLeadSession(
  teamsRoot: string,
  projectsRoot: string,
  leadSessionId: string,
): Promise<TeamInfo | null> {
  let dirents;
  try {
    dirents = await readdir(teamsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates: Array<{ name: string; mtime: number }> = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    try {
      const st = await stat(join(teamsRoot, d.name, 'config.json'));
      candidates.push({ name: d.name, mtime: st.mtimeMs });
    } catch {
      /* no config.json in this dir */
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);

  for (const c of candidates.slice(0, MAX_TEAMS_SCANNED)) {
    const cfg = await readJson<RawTeamConfig>(join(teamsRoot, c.name, 'config.json'));
    if (cfg?.leadSessionId === leadSessionId) {
      return teamRoster(teamsRoot, projectsRoot, c.name);
    }
  }
  return null;
}

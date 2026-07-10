import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeProvider } from '../../server/lib/providers/claude';
import { CodexProvider } from '../../server/lib/providers/codex';
import type { AgentProvider } from '../../server/lib/providers/types';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'smx-teams-'));
const projDir = '-Users-demo-github-teamrepo';
const projPath = path.join(home, '.claude', 'projects', projDir);

const LEAD_SESSION_ID = 'lead-0001';
const SCOUT_SESSION_ID = 'scout-0002';

beforeAll(() => {
  fs.mkdirSync(projPath, { recursive: true });

  // Lead session jsonl — no teamName/agentName stamped (the lead never stamps them).
  fs.writeFileSync(
    path.join(projPath, `${LEAD_SESSION_ID}.jsonl`),
    [
      JSON.stringify({
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'coordinate the team' },
        uuid: 'u0',
        timestamp: '2026-07-10T10:00:00.000Z',
        cwd: '/Users/demo/github/teamrepo',
        sessionId: LEAD_SESSION_ID,
        gitBranch: 'main',
      }),
    ].join('\n') + '\n',
  );

  // Teammate (tmux) session jsonl — stamps teamName + agentName in the head.
  fs.writeFileSync(
    path.join(projPath, `${SCOUT_SESSION_ID}.jsonl`),
    [
      JSON.stringify({
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'scout the terrain' },
        uuid: 'u0',
        timestamp: '2026-07-10T10:05:00.000Z',
        cwd: '/Users/demo/github/teamrepo',
        sessionId: SCOUT_SESSION_ID,
        gitBranch: 'main',
        teamName: 'session-fix',
        agentName: 'scout',
      }),
    ].join('\n') + '\n',
  );

  // Team config — one tmux member (scout, resolvable via jsonl), one in-process
  // member (ghost, no jsonl of its own -> sessionId stays null), plus the lead.
  const teamDir = path.join(home, '.claude', 'teams', 'session-fix');
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, 'config.json'),
    JSON.stringify({
      leadSessionId: LEAD_SESSION_ID,
      createdAt: 1752000000000,
      members: [
        {
          name: 'lead',
          agentType: 'team-lead',
          model: 'opus',
          color: 'blue',
          prompt: 'lead the team',
          backendType: 'in-process',
          isActive: true,
          joinedAt: 1752000000000,
        },
        {
          name: 'scout',
          agentType: 'worker',
          model: 'sonnet',
          color: 'green',
          prompt: 'scout ahead',
          backendType: 'tmux',
          isActive: true,
          joinedAt: 1752000001000,
        },
        {
          name: 'ghost',
          agentType: 'worker',
          model: 'sonnet',
          color: 'grey',
          prompt: 'haunt the codebase',
          backendType: 'in-process',
          isActive: true,
          joinedAt: 1752000002000,
        },
      ],
    }),
  );
});

describe('ClaudeProvider.teams', () => {
  const claude = new ClaudeProvider({ homeDir: home });

  it('teamRoster joins config members to teammate session jsonls by teamName+agentName', async () => {
    const roster = await claude.teams!.teamRoster('session-fix');
    expect(roster).not.toBeNull();
    expect(roster!.teamName).toBe('session-fix');
    expect(roster!.leadSessionId).toBe(LEAD_SESSION_ID);

    const scout = roster!.members.find((m) => m.name === 'scout')!;
    expect(scout.sessionId).toBe(SCOUT_SESSION_ID);
    expect(scout.backendType).toBe('tmux');

    const lead = roster!.members.find((m) => m.name === 'lead')!;
    expect(lead.sessionId).toBe(LEAD_SESSION_ID);

    const ghost = roster!.members.find((m) => m.name === 'ghost')!;
    expect(ghost.sessionId).toBeNull(); // in-process -> no own jsonl
  });

  it('teamByLeadSession finds the team whose config.leadSessionId matches', async () => {
    const t = await claude.teams!.teamByLeadSession(LEAD_SESSION_ID);
    expect(t).not.toBeNull();
    expect(t!.teamName).toBe('session-fix');
  });

  it('readHead captures teamName + agentName from a teammate jsonl head', async () => {
    const metas = await claude.listSessions(projDir);
    const m = metas.find((x) => x.id === SCOUT_SESSION_ID)!;
    expect(m.teamName).toBe('session-fix');
    expect(m.agentName).toBe('scout');

    const lead = metas.find((x) => x.id === LEAD_SESSION_ID)!;
    expect(lead.teamName).toBeUndefined();
    expect(lead.agentName).toBeUndefined();
  });
});

describe('CodexProvider.teams', () => {
  it('does not implement TeamSupport', () => {
    const cx: AgentProvider = new CodexProvider(path.join(home, '.codex', 'sessions'));
    expect(cx.teams).toBeUndefined();
  });
});

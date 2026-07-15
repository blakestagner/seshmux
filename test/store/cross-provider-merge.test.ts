import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeProvider } from '../../server/lib/providers/claude';
import { CodexProvider } from '../../server/lib/providers/codex';
import { encodeProjectId } from '../../server/lib/store/scan';

// D5-1: the SAME repo cwd, recorded by both providers, must produce ONE project id so
// routes/projects.ts (`merged.get(proj.id)`) folds them into a single card instead of two
// unpaired ones. Exercises the REAL entry paths — ClaudeProvider.scanProjects() reading a
// dirent it decodes and CodexProvider.scanProjects() encoding a cwd read out of a rollout —
// not encodeProjectId() called directly.
//
// The three non-alphanumeric shapes below are the ones that broke a "/"-only encode: space,
// underscore, and dot, plus a plain control path with none of them.
// NOTE: the dot-shape deliberately avoids `.claude/worktrees/<name>` — that pattern now folds
// into its parent project id by design (see derivedWorkspaceParent in scan.ts), which is
// exactly NOT what this fixture is testing (id-encoding stability for an ordinary path with a
// dot in it, unrelated to worktree folding).
const CWDS = [
  '/Users/demo/Local Sites/markauthor',
  '/Users/demo/Local Sites/app/themes/ML_Author',
  '/Users/demo/GitHub/seshmux/v1.old-experiments',
  '/Users/demo/GitHub/seshmux',
];

describe('cross-provider project id merge (D5-1)', () => {
  it('every repo cwd yields ONE project id shared by both the claude and codex providers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seshmux-cross-'));
    const claudeRoot = join(root, 'claude-projects');
    const codexRoot = join(root, 'codex-sessions');
    mkdirSync(claudeRoot);
    mkdirSync(codexRoot);

    CWDS.forEach((cwd, i) => {
      // Claude side: a project dirent named exactly the way Claude Code itself names it
      // on disk, containing a jsonl whose lines carry `cwd` (computeHead's real read).
      const dirent = cwd.replace(/[^a-zA-Z0-9]/g, '-');
      const dir = join(claudeRoot, dirent);
      mkdirSync(dir);
      const sid = `sess-${i}`;
      writeFileSync(
        join(dir, `${sid}.jsonl`),
        JSON.stringify({
          parentUuid: null,
          type: 'user',
          message: { role: 'user', content: `task in ${cwd}` },
          uuid: 'u0',
          timestamp: '2026-07-01T10:00:00.000Z',
          cwd,
          sessionId: sid,
          gitBranch: 'main',
        }) + '\n',
      );

      // Codex side: a real-form rollout whose session_meta payload is {id, timestamp, cwd,
      // originator, cli_version} — the shape codex.ts's readSummary actually parses.
      const day = join(codexRoot, '2026', '07', String(i + 1).padStart(2, '0'));
      mkdirSync(day, { recursive: true });
      const uuid = `019aebe9-51ba-7810-959a-6b8c0797${(9000 + i).toString().padStart(4, '0')}`;
      writeFileSync(
        join(day, `rollout-2026-07-01T12-00-0${i}-${uuid}.jsonl`),
        JSON.stringify({
          timestamp: '2026-07-01T12:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: uuid,
            timestamp: '2026-07-01T12:00:00.000Z',
            cwd,
            originator: 'cli',
            cli_version: '0.143.0',
          },
        }) + '\n',
      );
    });

    const claudeProjects = await new ClaudeProvider({ root: claudeRoot }).scanProjects();
    const codexProjects = await new CodexProvider(codexRoot).scanProjects();

    // Merge exactly as server/routes/projects.ts does: `Map<id, Project>` keyed by proj.id.
    const merged = new Map<string, Set<string>>();
    for (const list of [claudeProjects, codexProjects]) {
      for (const proj of list) {
        if (!merged.has(proj.id)) merged.set(proj.id, new Set());
        merged.get(proj.id)!.add(proj.provider);
      }
    }

    expect(merged.size).toBe(4);
    for (const cwd of CWDS) {
      const id = encodeProjectId(cwd);
      expect(merged.has(id)).toBe(true);
      expect(merged.get(id)).toEqual(new Set(['claude', 'codex']));
    }
  });

  it('a .claude/worktrees cwd folds to its parent id the same way for both providers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seshmux-cross-wt-'));
    const claudeRoot = join(root, 'claude-projects');
    const codexRoot = join(root, 'codex-sessions');
    mkdirSync(claudeRoot);
    mkdirSync(codexRoot);

    const parentCwd = '/Users/demo/GitHub/seshmux';
    const wtCwd = '/Users/demo/GitHub/seshmux/.claude/worktrees/agent-a8f';

    // Claude side: only the worktree cwd has a session (no direct parent-repo session) —
    // exercises the synthesized-parent-id path too.
    const dirent = wtCwd.replace(/[^a-zA-Z0-9]/g, '-');
    mkdirSync(join(claudeRoot, dirent));
    writeFileSync(
      join(claudeRoot, dirent, 'sess-wt.jsonl'),
      JSON.stringify({
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'task in worktree' },
        uuid: 'u0',
        timestamp: '2026-07-01T10:00:00.000Z',
        cwd: wtCwd,
        sessionId: 'sess-wt',
        gitBranch: 'marketplace',
      }) + '\n',
    );

    // Codex side: same worktree cwd, real rollout shape.
    const day = join(codexRoot, '2026', '07', '01');
    mkdirSync(day, { recursive: true });
    const uuid = '019aebe9-51ba-7810-959a-6b8c07979999';
    writeFileSync(
      join(day, `rollout-2026-07-01T12-00-00-${uuid}.jsonl`),
      JSON.stringify({
        timestamp: '2026-07-01T12:00:00.000Z',
        type: 'session_meta',
        payload: { id: uuid, timestamp: '2026-07-01T12:00:00.000Z', cwd: wtCwd, originator: 'cli', cli_version: '0.143.0' },
      }) + '\n',
    );

    const claudeProjects = await new ClaudeProvider({ root: claudeRoot }).scanProjects();
    const codexProjects = await new CodexProvider(codexRoot).scanProjects();

    const parentId = encodeProjectId(parentCwd);
    const wtId = encodeProjectId(wtCwd);

    for (const list of [claudeProjects, codexProjects]) {
      expect(list.map((p) => p.id)).toContain(parentId);
      expect(list.map((p) => p.id)).not.toContain(wtId);
      expect(list.find((p) => p.id === parentId)?.path).toBe(parentCwd);
    }
  });
});

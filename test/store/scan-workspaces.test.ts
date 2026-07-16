// Spec 1 "Scanning seam": a workspace worktree cwd must fold into its PARENT
// project in scanProjects, AND the parent's listSessions must surface the
// workspace's sessions too — folding only the project list (not sessions)
// would make the rail count right but hide the actual sessions.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProjects, listSessions, sessionFilePath, encodeProjectId } from '../../server/lib/store/scan';
import { ClaudeProvider } from '../../server/lib/providers/claude';
import * as workspaces from '../../server/lib/workspaces';

let configDir: string;
let repo: string;
let storeRoot: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd }).toString();
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

// Minimal claude-shaped jsonl: one user line carrying cwd (used for both title
// AND real-cwd resolution, matching scan.ts's readHead).
function writeSessionFile(dirPath: string, sessionId: string, cwd: string, branch: string, title: string) {
  mkdirSync(dirPath, { recursive: true });
  const line = {
    type: 'user',
    message: { role: 'user', content: title },
    uuid: 'u0',
    timestamp: '2026-07-05T10:00:00.000Z',
    cwd,
    sessionId,
    gitBranch: branch,
  };
  writeFileSync(join(dirPath, `${sessionId}.jsonl`), JSON.stringify(line) + '\n');
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'seshmux-cfg-'));
  process.env.SESHMUX_CONFIG_DIR = configDir;
  // realpath: a real agent's jsonl records getcwd(), which is always canonical (macOS
  // /tmp -> /private/tmp). Writing the raw path here would be an unrealistic fixture — and
  // it silently masked whether grouping survives a symlinked repo root.
  //
  // .native, specifically: it must be the SAME realpath flavor the product canonicalizes
  // with (workspaces.ts canon() -> fs/promises realpath, which is the native one). The JS
  // realpathSync does NOT expand Windows 8.3 short names, the native one does. That only
  // shows up where tmpdir() is itself an 8.3 path — as on the windows-latest CI runner,
  // C:\Users\RUNNER~1\... — and there the fixture held the SHORT spelling while every
  // product record held the LONG one, so each `path === repo` compare missed and the
  // worktree never folded into its parent. Measured:
  //   realpathSync(short)        -> C:\...\SESHMU~1            (short, unchanged)
  //   realpathSync.native(short) -> C:\...\seshmuxlongrepodir  (== fs/promises realpath)
  // Identity on posix, where the two flavors agree.
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'seshmux-repo-')));
  initRepo(repo);
  storeRoot = mkdtempSync(join(tmpdir(), 'seshmux-store-'));
});

afterEach(() => {
  delete process.env.SESHMUX_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(storeRoot, { recursive: true, force: true });
});

describe('scanProjects workspace grouping', () => {
  it('folds a workspace worktree project into its parent (one group, summed count)', async () => {
    const parentDirName = encodeProjectId(repo);
    writeSessionFile(join(storeRoot, parentDirName), 'parent-1', repo, 'main', 'do the main thing');

    const { dir: wsDir } = await workspaces.create(repo);
    const wsDirName = encodeProjectId(wsDir);
    writeSessionFile(join(storeRoot, wsDirName), 'ws-1', wsDir, 'agent/foo-1', 'do the workspace thing');

    const projects = await scanProjects(storeRoot, 'claude');

    // Exactly one project for this repo — no separate group for the workspace.
    const matches = projects.filter((p) => p.path === repo);
    expect(matches).toHaveLength(1);
    expect(matches[0].sessionCount).toBe(2); // summed across parent + workspace dirs
    expect(projects.some((p) => p.path === wsDir)).toBe(false); // never its own group

    await workspaces.remove(wsDir, { mode: 'discard' });
  });

  it('listSessions on the scanned project id also returns the workspace session', async () => {
    const parentDirName = encodeProjectId(repo);
    writeSessionFile(join(storeRoot, parentDirName), 'parent-1', repo, 'main', 'do the main thing');

    const { dir: wsDir } = await workspaces.create(repo);
    const wsDirName = encodeProjectId(wsDir);
    writeSessionFile(join(storeRoot, wsDirName), 'ws-1', wsDir, 'agent/foo-1', 'do the workspace thing');

    // Take project.id from the scan result (never hardcode the dirent name) —
    // exercises the same id-resolution path the rail actually calls through.
    const projects = await scanProjects(storeRoot, 'claude');
    const project = projects.find((p) => p.path === repo)!;
    expect(project).toBeDefined();

    const sessions = await listSessions(project.id, { root: storeRoot, provider: 'claude' });
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain('parent-1');
    expect(ids).toContain('ws-1');
    const wsSession = sessions.find((s) => s.id === 'ws-1')!;
    expect(wsSession.branch).toBe('agent/foo-1');

    await workspaces.remove(wsDir, { mode: 'discard' });
  });

  it('two workspaces with no direct-in-repo session both surface via listSessions(project.id)', async () => {
    const { dir: ws1Dir } = await workspaces.create(repo);
    const ws1DirName = encodeProjectId(ws1Dir);
    writeSessionFile(join(storeRoot, ws1DirName), 'ws-1', ws1Dir, 'agent/foo-1', 'workspace one thing');

    const { dir: ws2Dir } = await workspaces.create(repo);
    const ws2DirName = encodeProjectId(ws2Dir);
    writeSessionFile(join(storeRoot, ws2DirName), 'ws-2', ws2Dir, 'agent/bar-1', 'workspace two thing');

    const projects = await scanProjects(storeRoot, 'claude');
    const project = projects.find((p) => p.path === repo)!;
    expect(project).toBeDefined();
    expect(project.sessionCount).toBe(2);

    const sessions = await listSessions(project.id, { root: storeRoot, provider: 'claude' });
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain('ws-1');
    expect(ids).toContain('ws-2');
    expect(sessions).toHaveLength(2);

    await workspaces.remove(ws1Dir, { mode: 'discard' });
    await workspaces.remove(ws2Dir, { mode: 'discard' });
  });

  it('a workspace with no parent-repo sessions yet still surfaces as the parent project', async () => {
    const { dir: wsDir } = await workspaces.create(repo);
    const wsDirName = encodeProjectId(wsDir);
    writeSessionFile(join(storeRoot, wsDirName), 'ws-1', wsDir, 'agent/foo-1', 'first workspace session');

    const projects = await scanProjects(storeRoot, 'claude');
    const match = projects.find((p) => p.path === repo);
    expect(match).toBeDefined();
    expect(match!.sessionCount).toBe(1);
    expect(match!.missing).toBe(false);

    const sessions = await listSessions(match!.id, { root: storeRoot, provider: 'claude' });
    expect(sessions.map((s) => s.id)).toContain('ws-1');

    await workspaces.remove(wsDir, { mode: 'discard' });
  });
});

// Claude Code's own EnterWorktree creates `<repo>/.claude/worktrees/<name>` with
// no workspaces.json record at all — must fold in from the cwd pattern alone.
describe('scanProjects .claude/worktrees pattern grouping', () => {
  it('folds a .claude/worktrees cwd into its parent (one group, summed count), no workspaces.json record', async () => {
    const parentDirName = encodeProjectId(repo);
    writeSessionFile(join(storeRoot, parentDirName), 'parent-1', repo, 'main', 'do the main thing');

    const wtDir = join(repo, '.claude', 'worktrees', 'skills-agents-authoring');
    const wtDirName = encodeProjectId(wtDir);
    writeSessionFile(join(storeRoot, wtDirName), 'wt-1', wtDir, 'marketplace', 'worktree thing');

    const projects = await scanProjects(storeRoot, 'claude');

    const matches = projects.filter((p) => p.path === repo);
    expect(matches).toHaveLength(1);
    expect(matches[0].sessionCount).toBe(2);
    expect(projects.some((p) => p.path === wtDir)).toBe(false);

    const sessions = await listSessions(matches[0].id, { root: storeRoot, provider: 'claude' });
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain('parent-1');
    expect(ids).toContain('wt-1');
  });

  it('a .claude/worktrees cwd with no parent-repo sessions yet still synthesizes the parent project', async () => {
    const wtDir = join(repo, '.claude', 'worktrees', 'skills-agents-authoring');
    const wtDirName = encodeProjectId(wtDir);
    writeSessionFile(join(storeRoot, wtDirName), 'wt-1', wtDir, 'marketplace', 'worktree thing');

    const projects = await scanProjects(storeRoot, 'claude');
    const match = projects.find((p) => p.path === repo);
    expect(match).toBeDefined();
    expect(match!.sessionCount).toBe(1);
    expect(match!.missing).toBe(false);

    const sessions = await listSessions(match!.id, { root: storeRoot, provider: 'claude' });
    expect(sessions.map((s) => s.id)).toContain('wt-1');
  });

  // The verified 49-empty-transcripts bug: listSessions stamps a folded worktree
  // session with the PARENT projectId, but every file-path consumer joined
  // root/projectId/sessionId.jsonl and missed — the transcript came back empty.
  it("resolves a folded worktree session's file + transcript under the PARENT projectId", async () => {
    const parentDirName = encodeProjectId(repo);
    writeSessionFile(join(storeRoot, parentDirName), 'parent-1', repo, 'main', 'do the main thing');

    const wtDir = join(repo, '.claude', 'worktrees', 'skills-agents-authoring');
    const wtDirName = encodeProjectId(wtDir);
    writeSessionFile(join(storeRoot, wtDirName), 'wt-1', wtDir, 'marketplace', 'worktree task prompt');

    const projects = await scanProjects(storeRoot, 'claude');
    const project = projects.find((p) => p.path === repo)!;

    // Shared lookup finds the jsonl in the worktree's OWN dirent…
    expect(await sessionFilePath(project.id, 'wt-1', storeRoot, 'claude')).toBe(
      join(storeRoot, wtDirName, 'wt-1.jsonl'),
    );
    // …and the provider transcript path returns real msgs, not [].
    const provider = new ClaudeProvider({ root: storeRoot });
    const { msgs } = await provider.parseTranscript(project.id, 'wt-1');
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0].text).toBe('worktree task prompt');
    // Session meta carries the session's REAL cwd (bridge spawn/diff consumes it).
    const sessions = await listSessions(project.id, { root: storeRoot, provider: 'claude' });
    expect(sessions.find((s) => s.id === 'wt-1')!.cwd).toBe(wtDir);
  });

  it('a session cwd DEEPER inside a worktree (worktrees/x/subdir) still folds to the parent', async () => {
    const deepCwd = join(repo, '.claude', 'worktrees', 'x', 'packages', 'app');
    writeSessionFile(join(storeRoot, encodeProjectId(deepCwd)), 'deep-1', deepCwd, 'b', 'deep thing');

    const projects = await scanProjects(storeRoot, 'claude');
    const match = projects.find((p) => p.path === repo);
    expect(match).toBeDefined();
    expect(projects.some((p) => p.path === deepCwd)).toBe(false);

    const sessions = await listSessions(match!.id, { root: storeRoot, provider: 'claude' });
    expect(sessions.map((s) => s.id)).toContain('deep-1');
  });
});

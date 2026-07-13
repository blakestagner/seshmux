// Spec 1 "Scanning seam": a workspace worktree cwd must fold into its PARENT
// project in scanProjects, AND the parent's listSessions must surface the
// workspace's sessions too — folding only the project list (not sessions)
// would make the rail count right but hide the actual sessions.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProjects, listSessions } from '../../server/lib/store/scan';
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
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'seshmux-repo-')));
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
    const parentDirName = repo.replace(/\//g, '-');
    writeSessionFile(join(storeRoot, parentDirName), 'parent-1', repo, 'main', 'do the main thing');

    const { dir: wsDir } = await workspaces.create(repo);
    const wsDirName = wsDir.replace(/\//g, '-');
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
    const parentDirName = repo.replace(/\//g, '-');
    writeSessionFile(join(storeRoot, parentDirName), 'parent-1', repo, 'main', 'do the main thing');

    const { dir: wsDir } = await workspaces.create(repo);
    const wsDirName = wsDir.replace(/\//g, '-');
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
    const ws1DirName = ws1Dir.replace(/\//g, '-');
    writeSessionFile(join(storeRoot, ws1DirName), 'ws-1', ws1Dir, 'agent/foo-1', 'workspace one thing');

    const { dir: ws2Dir } = await workspaces.create(repo);
    const ws2DirName = ws2Dir.replace(/\//g, '-');
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
    const wsDirName = wsDir.replace(/\//g, '-');
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

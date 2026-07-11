// Workspaces: one-click isolated git worktree + branch per agent session.
// ALL git calls go through execFile with arg arrays (no shell) — same posture
// as validateStart in server/routes/term.ts. This file owns workspaces.json,
// the ONLY record of which worktree dir belongs to which parent repo (scan.ts
// grouping reads it; never derive the relationship any other way).
//
// Naming: branch `agent/<slug>-<n>`, worktree dir
// `<configDir>/worktrees/<repo-basename>/<slug>-<n>/`. Deliberately NOT under
// the repo itself (keeps `git status`/watchers on the main tree unaffected).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { configDir } from '../daemon-client';

const execFileP = promisify(execFile);

export interface WorkspaceRecord {
  dir: string; // absolute worktree path
  branch: string;
  project: string; // parent repo absolute path
  createdAt: number;
}

export type RemoveMode = 'merge' | 'keep' | 'discard';

const ADJECTIVES = [
  'quiet', 'brisk', 'amber', 'calm', 'swift', 'bold', 'lucid', 'mellow',
  'crisp', 'still', 'keen', 'sunny', 'misty', 'sharp', 'gentle', 'vivid',
];
const NOUNS = [
  'otter', 'falcon', 'ember', 'birch', 'heron', 'cove', 'meadow', 'quartz',
  'willow', 'harbor', 'lantern', 'thistle', 'ridge', 'coral', 'sparrow', 'ferry',
];

function randSlug(): string {
  const a = ADJECTIVES[randomBytes(1)[0] % ADJECTIVES.length];
  const n = NOUNS[randomBytes(1)[0] % NOUNS.length];
  return `${a}-${n}`;
}

function workspacesFile(): string {
  return path.join(configDir(), 'workspaces.json');
}

function worktreesRoot(): string {
  return path.join(configDir(), 'worktrees');
}

// ponytail: plain read-modify-write with a lockfile-free tmp+rename swap. A
// crash between calls loses at most one write; boot reconcile() fixes drift
// against `git worktree list` anyway. Add file locking if concurrent writers
// ever race in practice.
async function readAll(): Promise<WorkspaceRecord[]> {
  try {
    const raw = await readFile(workspacesFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(records: WorkspaceRecord[]): Promise<void> {
  const file = workspacesFile();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(records, null, 2));
  await rename(tmp, file);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd });
  return stdout;
}

// Branch names already present in the repo under our `agent/` namespace. A 'keep'-finished
// workspace removes its worktree and drops its workspaces.json record but leaves the branch
// behind — invisible to a records-only scan, yet `git worktree add -b <name>` onto it fails
// raw (S4-3). Consulting real git branches closes that gap.
async function listAgentBranches(repoPath: string): Promise<string[]> {
  try {
    const out = await git(repoPath, ['branch', '--list', '--format=%(refname:short)', 'agent/*']);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    const out = await git(repoPath, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

async function defaultBranch(repoPath: string): Promise<string> {
  // Prefer the symbolic HEAD of origin (works whether it's main/master/etc);
  // fall back to the current branch of the repo itself.
  try {
    const out = await git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const ref = out.trim().replace(/^origin\//, '');
    if (ref) return ref;
  } catch {
    /* no origin / no symbolic ref — fall through */
  }
  const out = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return out.trim() || 'main';
}

/**
 * Create an isolated worktree + branch off the repo's default branch. Never
 * couples to session spawn — callers spawn separately via the shared
 * startSession() (hard rule: one spawn path).
 */
export async function create(repoPath: string): Promise<{ dir: string; branch: string }> {
  if (!(await isGitRepo(repoPath))) {
    throw new Error(`not a git repo: ${repoPath}`);
  }
  const repoBase = path.basename(repoPath).replace(/[^a-zA-Z0-9_-]/g, '-') || 'repo';
  const base = defaultBranch(repoPath); // kick off in parallel with existing-record scan
  const branchList = listAgentBranches(repoPath); // and with the git branch scan
  const existing = await readAll();
  const takenBranches = new Set(existing.map((r) => r.branch));
  // Fold in real git branches (S4-3): a kept branch has no record but still exists on disk.
  for (const b of await branchList) takenBranches.add(b);
  const takenDirs = new Set(existing.map((r) => r.dir));

  let slug = randSlug();
  let n = 1;
  let branch = `agent/${slug}-${n}`;
  let dir = path.join(worktreesRoot(), repoBase, `${slug}-${n}`);
  // Bump -n (never -f) on any collision — recorded branch, kept git branch, dir, OR an
  // existing dir on disk. ponytail: a branch created between this scan and `worktree add`
  // (TOCTOU) would still fail raw; not worth a retry loop for a single-user local tool.
  while (takenBranches.has(branch) || takenDirs.has(dir) || existsSync(dir)) {
    n++;
    branch = `agent/${slug}-${n}`;
    dir = path.join(worktreesRoot(), repoBase, `${slug}-${n}`);
  }

  await mkdir(path.dirname(dir), { recursive: true });
  const defBranch = await base;
  await git(repoPath, ['worktree', 'add', dir, '-b', branch, defBranch]);

  // Store the REALPATH (symlinks resolved), not the raw join()'d dir: git
  // itself reports worktree paths canonicalized (macOS /tmp -> /private/tmp,
  // and any symlinked ~/.config setup), and the agent's own jsonl records
  // getcwd() output, which is also canonicalized. Recording the raw path here
  // would make scan.ts's grouping (path equality against the agent-recorded
  // cwd) and reconcile()'s `git worktree list` check silently miss.
  const realDir = await realpath(dir);
  const record: WorkspaceRecord = { dir: realDir, branch, project: repoPath, createdAt: Date.now() };
  await writeAll([...existing, record]);
  return { dir: realDir, branch };
}

/** All workspace records for a given parent repo path. */
export async function list(repoPath: string): Promise<WorkspaceRecord[]> {
  const all = await readAll();
  return all.filter((r) => r.project === repoPath);
}

/** All workspace records, regardless of parent (scan.ts grouping lookup). */
export async function listAll(): Promise<WorkspaceRecord[]> {
  return readAll();
}

/**
 * Count of dirty files in a worktree (`git status --porcelain | wc -l`
 * equivalent). Returns 0 for a clean tree or if git fails (removed dir etc).
 */
export async function dirtyCount(dir: string): Promise<number> {
  try {
    const out = await git(dir, ['status', '--porcelain']);
    return out.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * True when no TRACKED file has uncommitted changes (staged or not). Untracked files are
 * deliberately ignored — unlike dirtyCount, which counts them. Merge uses this to tell
 * "real edits a merge would not carry" (refuse) from "a build artifact left in the tree"
 * (safe to discard once the commits are merged). Fails CLOSED: if git can't answer, report
 * dirty so the caller refuses rather than force-removing on a bad read.
 */
async function isTrackedClean(dir: string): Promise<boolean> {
  try {
    await git(dir, ['diff', '--quiet', 'HEAD']); // non-zero exit → throws → dirty
    return true;
  } catch {
    return false;
  }
}

/** How many commits `branch` has that `project`'s current HEAD does not. 0 = nothing to merge. */
async function commitsAhead(project: string, branch: string): Promise<number> {
  try {
    const out = await git(project, ['rev-list', '--count', `HEAD..${branch}`]);
    return Number(out.trim()) || 0;
  } catch {
    return 0; // can't tell → treat as nothing to merge (guard refuses; never force-removes)
  }
}

/**
 * Finish a workspace. merge: `git merge --no-ff <branch>` in the parent repo
 * (failure surfaces stderr, nothing else happens — worktree/branch/record all
 * survive so the user can resolve manually and retry). keep: remove the
 * worktree, branch survives. discard: force-remove worktree + delete branch.
 * The record is dropped from workspaces.json only on success.
 *
 * Server-side dirty guard on discard: never silent-discard uncommitted work
 * even if a stale/never-polled client sends the request — `force` must be
 * explicit (the client sets it only after its typed "discard" confirm). This
 * is the durable half of the guard; the client-side typed confirm is the UX
 * half, and both must independently hold.
 */
export async function remove(dir: string, opts: { mode: RemoveMode; force?: boolean }): Promise<void> {
  const all = await readAll();
  const record = all.find((r) => r.dir === dir);
  if (!record) throw new Error(`unknown workspace dir: ${dir}`);

  if (opts.mode === 'merge') {
    // Merge is the mode users pick to KEEP work, so it must never destroy any — but it also
    // must not refuse a finished workspace just because a build artifact is lying around.
    // Two precise guards instead of a blanket "is anything dirty" (which re-broke S4-4):
    //
    //   1. Uncommitted edits to TRACKED files are real work that a merge does NOT move (it
    //      moves commits) and the force-remove below would destroy them (R5-1).
    if (!(await isTrackedClean(dir))) {
      throw new Error('workspace has uncommitted changes — commit them in the workspace before merging');
    }
    //   2. Nothing committed to merge at all: `merge --no-ff` would exit 0 ("Already up to
    //      date") and the force-remove would silently delete an untracked-but-real file the
    //      agent wrote and never staged, while reporting success (the other half of R5-1).
    if ((await commitsAhead(record.project, record.branch)) === 0) {
      throw new Error('workspace has no commits to merge — commit the work in the workspace first');
    }
    // Past both guards the worktree holds only untracked leftovers (build artifacts) and the
    // branch has real commits, so the merge genuinely moves the work and the leftovers are
    // disposable — that's the S4-4 case, and the force-remove below is safe.
    // Was the PARENT already mid-merge (the user's own conflict, maybe hand-resolved) before
    // we touched it? If so our merge refuses to start ("You have not concluded your merge"),
    // and aborting on the way out would destroy THEIR work (R5-2). Only abort a mid-merge we
    // created ourselves.
    const parentWasMidMerge = await git(record.project, ['rev-parse', '--verify', 'MERGE_HEAD'])
      .then(() => true)
      .catch(() => false);
    try {
      await git(record.project, ['merge', '--no-ff', record.branch]);
    } catch (e) {
      // A real conflict leaves the parent mid-merge (MERGE_HEAD set, conflict markers). Abort
      // so the parent is restored to its pre-merge HEAD, then rethrow — the route reports 409
      // and worktree/branch/record all survive for a manual retry (S4-6).
      if (!parentWasMidMerge) {
        await git(record.project, ['merge', '--abort']).catch(() => {});
      }
      throw e;
    }
    // Merge succeeded and (per the guards above) the worktree holds no tracked edits and the
    // branch's commits are now in the parent — so the only things left are untracked
    // artifacts. Force-remove: a plain remove refuses on those, which would misreport a DONE
    // merge as a 409 and wedge every retry (the re-merge is a no-op, the remove fails again).
    await git(record.project, ['worktree', 'remove', '--force', dir]);
  } else if (opts.mode === 'keep') {
    await git(record.project, ['worktree', 'remove', dir]);
  } else {
    if (!opts.force && (await dirtyCount(dir)) > 0) {
      throw new Error('workspace has uncommitted changes — discard requires force');
    }
    await git(record.project, ['worktree', 'remove', '--force', dir]);
    await git(record.project, ['branch', '-D', record.branch]);
  }

  await writeAll(all.filter((r) => r.dir !== dir));
}

/**
 * Boot reconcile: cross-check workspaces.json against `git worktree list` per
 * parent repo, and prune records whose dir is gone from disk. A crash between
 * `git worktree add` and the json write (or vice versa) can orphan either
 * side — this fixes both directions without touching the git state itself.
 */
export async function reconcile(): Promise<void> {
  const all = await readAll();
  const kept: WorkspaceRecord[] = [];
  for (const record of all) {
    if (!existsSync(record.dir)) continue; // dir gone — drop the record
    if (!existsSync(record.project)) continue; // parent repo gone too
    try {
      const out = await git(record.project, ['worktree', 'list', '--porcelain']);
      const dirs = out
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length).trim());
      // git resolves symlinks in its report (e.g. macOS /tmp -> /private/tmp),
      // so compare realpaths, not raw strings, or every workspace on macOS
      // gets silently pruned on the next boot.
      const real = await realpath(record.dir);
      if (!dirs.includes(real)) continue; // git doesn't know this worktree anymore
    } catch {
      continue; // parent repo unreachable — drop the orphan record
    }
    kept.push(record);
  }
  if (kept.length !== all.length) await writeAll(kept);
}

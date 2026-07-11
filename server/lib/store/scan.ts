// Claude session-store scanner. PROVIDER-AGNOSTIC by design: the `~/.claude/projects`
// path and the `'claude'` provider id are NOT hardcoded here (hard rule 3) — the caller
// (server/lib/providers/claude.ts) supplies both `root` and `provider`. This file only
// knows how to read a directory of dash-encoded project dirs each holding `<id>.jsonl`.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { listAll as listAllWorkspaces } from '../workspaces';
import { Lru } from './lru';

export type ProviderId = 'claude' | 'codex';

export interface Project {
  id: string;
  provider: ProviderId;
  name: string;
  path: string;
  sessionCount: number;
  // For rail sort. updatedAt = newest session activity (max mtime across the
  // project's .jsonl files — NOT the dir mtime, which misses resume/continue
  // appends). createdAt = oldest session's birthtime.
  createdAt: number;
  updatedAt: number;
  // True when the repo folder no longer exists on disk (deleted worktree, tmp
  // dir). Sessions stay browsable/searchable but resume/spawn can't work — the
  // rail hides these by default.
  missing: boolean;
  // Set by the /api/projects merge (not by providers): per-provider session
  // counts, so the rail's provider filter can show the filtered count.
  sessionCountByProvider?: Partial<Record<ProviderId, number>>;
}

export interface SessionMeta {
  id: string;
  provider: ProviderId;
  projectId: string;
  title: string;
  branch: string | null;
  mtime: number;
  startedAt: number | null;
  durationMs: number | null;
  live: boolean;
  // Teams v1 (additive): present only on teammate sessions, which stamp both fields in
  // their jsonl head. The lead session stamps neither, so these stay undefined for it.
  teamName?: string;
  agentName?: string;
}

export interface ListOpts {
  root: string;
  provider: ProviderId;
  before?: number;
  limit?: number;
  q?: string;
}

// Entries whose first user message starts with one of these are meta/command/framing
// entries, not the real task prompt — skip them when picking a session title.
// `<teammate-message` added after the Task 7 real-store eyeball: team sessions open with
// it and it was rendering as the title.
const SKIP_TITLE_PREFIXES = [
  '<command-name>',
  '<local-command',
  '<system-reminder',
  '<teammate-message',
  '<task-notification',
];

const LIVE_WINDOW_MS = 60_000;

// Decode a dash-encoded project dir name into an absolute cwd + short repo name.
// `-Users-demo-github-myrepo` -> path `/Users/demo/github/myrepo`, name `myrepo`.
export function decodeProjectDir(dir: string): { path: string; name: string } {
  const path = dir.replace(/-/g, '/');
  const segments = path.split('/').filter(Boolean);
  const name = segments[segments.length - 1] ?? dir;
  return { path, name };
}

interface HeadInfo {
  title: string;
  branch: string | null;
  startedAt: number | null;
  // Real cwd recorded in the jsonl. The dir name is a lossy dash-encoding of the
  // path ("/"→"-"), so a repo whose folder contains a hyphen can't be recovered
  // by decode alone — use this true cwd for the project path when present.
  cwd: string | null;
  // Teams v1: teamName + agentName, present only when this jsonl is a teammate
  // session (the lead session never stamps them).
  teamName: string | null;
  agentName: string | null;
}

// Cache parsed head info keyed by (file, mtime) so repeated listings are cheap.
// LRU-bounded: every agent turn bumps mtime and orphans the old key, so an
// unbounded Map grew forever over server uptime.
const headCache = new Lru<HeadInfo>(500);

function firstUserText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as any).type === 'text') {
        return String((block as any).text ?? '');
      }
    }
  }
  return null;
}

// Read only the first ~50 lines of a jsonl session file to extract title + branch +
// startedAt, stopping as soon as we have a title (branch keeps updating to last seen).
async function readHead(filePath: string, mtime: number): Promise<HeadInfo> {
  return headCache.get(`${filePath}:${mtime}`, () => computeHead(filePath));
}

async function computeHead(filePath: string): Promise<HeadInfo> {
  let title = '';
  let branch: string | null = null;
  let startedAt: number | null = null;
  let cwd: string | null = null;
  let teamName: string | null = null;
  let agentName: string | null = null;
  let lineCount = 0;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (++lineCount > 50 && title && cwd) break;
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // tolerate malformed lines
      }

      if (typeof obj.gitBranch === 'string') branch = obj.gitBranch;
      if (cwd === null && typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd;
      // Team membership (Teams v1 discovery): teammate sessions stamp teamName +
      // agentName; the lead session stamps neither.
      if (teamName === null && typeof obj.teamName === 'string') teamName = obj.teamName;
      if (agentName === null && typeof obj.agentName === 'string') agentName = obj.agentName;

      if (obj.type === 'user' && obj.message?.role === 'user') {
        const text = firstUserText(obj.message.content);
        if (startedAt === null && typeof obj.timestamp === 'string') {
          startedAt = Date.parse(obj.timestamp);
        }
        if (!title && text) {
          const trimmed = text.trim();
          const isMeta = SKIP_TITLE_PREFIXES.some((p) => trimmed.startsWith(p));
          if (!isMeta) title = trimmed.slice(0, 80);
        }
      }
    }
  } finally {
    rl.close();
  }

  return { title, branch, startedAt, cwd, teamName, agentName };
}

// worktree dir -> parent repo absolute path (workspaces.json is the lookup —
// Spec 1's "Scanning seam"). Never throws; an unreadable/missing
// workspaces.json just means no grouping happens.
async function workspaceParentMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const records = await listAllWorkspaces();
    for (const r of records) map.set(r.dir, r.project);
  } catch {
    /* no workspaces store yet */
  }
  return map;
}

// Intermediate per-dirent scan result before the byPath merge pass folds
// workspace dirents into their parent. `isWorkspace` is scan-internal only —
// dropped before Project[] is returned.
interface ScannedEntry extends Project {
  isWorkspace: boolean;
}

export async function scanProjects(root: string, provider: ProviderId): Promise<Project[]> {
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const parentOf = await workspaceParentMap();
  const projects: ScannedEntry[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dirPath = join(root, d.name);
    let files: string[];
    try {
      files = (await readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    const decoded = decodeProjectDir(d.name);
    // Stat each session file: updatedAt = newest mtime (catches resume appends
    // that leave the dir mtime untouched), createdAt = oldest birthtime. Track
    // the newest file so we can read its real cwd from the jsonl head.
    let updatedAt = 0;
    let createdAt = Number.MAX_SAFE_INTEGER;
    let newestFile: { path: string; mtime: number } | null = null;
    for (const f of files) {
      try {
        const fp = join(dirPath, f);
        const st = await stat(fp);
        updatedAt = Math.max(updatedAt, st.mtimeMs);
        createdAt = Math.min(createdAt, st.birthtimeMs || st.mtimeMs);
        if (!newestFile || st.mtimeMs > newestFile.mtime) newestFile = { path: fp, mtime: st.mtimeMs };
      } catch {
        /* skip unreadable file */
      }
    }
    if (createdAt === Number.MAX_SAFE_INTEGER) createdAt = updatedAt;
    // Prefer the real cwd from the jsonl over the lossy dash-decode (a repo folder
    // with a hyphen decodes to a wrong, nonexistent path → resume 400s).
    let path = decoded.path;
    let name = decoded.name;
    if (newestFile) {
      const head = await readHead(newestFile.path, Math.floor(newestFile.mtime));
      if (head.cwd) {
        path = head.cwd;
        name = head.cwd.split('/').filter(Boolean).pop() || decoded.name;
      }
    }
    let missing = false;
    try {
      missing = !(await stat(path)).isDirectory();
    } catch {
      missing = true;
    }
    // parentPath set = this dirent's cwd is a known workspace worktree dir —
    // folded into the parent project below, never listed on its own (no rail
    // sprout of one project group per workspace).
    const parentPath = parentOf.get(path);
    projects.push({
      id: d.name,
      provider,
      name,
      path: parentPath ?? path,
      sessionCount: files.length,
      createdAt,
      updatedAt,
      missing: parentPath ? false : missing, // parent's own missing-ness checked in the merge pass
      isWorkspace: !!parentPath,
    });
  }

  // Merge pass: fold every entry whose (possibly rewritten) path matches a
  // parent repo into ONE Project per path. The id/name winner is picked
  // deterministically — the repo's OWN dirent (not a workspace dirent) always
  // wins, never "whichever readdir returned first". If no own-dirent exists
  // (workspace-only parent, no direct sessions yet), synthesize the id/name
  // from the repo path via the same dash-encoding decodeProjectDir reverses,
  // so downstream listSessions/rehydrate resolve against a stable, correct id.
  const byPath = new Map<string, ScannedEntry>();
  for (const p of projects) {
    const prev = byPath.get(p.path);
    if (prev) {
      prev.sessionCount += p.sessionCount;
      prev.updatedAt = Math.max(prev.updatedAt, p.updatedAt);
      prev.createdAt = Math.min(prev.createdAt, p.createdAt);
      // Own-dirent (non-workspace) always wins the id/name, regardless of
      // readdir order.
      if (prev.isWorkspace && !p.isWorkspace) {
        prev.id = p.id;
        prev.name = p.name;
        prev.isWorkspace = false;
      }
    } else {
      byPath.set(p.path, { ...p });
    }
  }
  // Every remaining group still flagged isWorkspace never saw its repo's own
  // dirent — synthesize a stable id/name from the repo path itself.
  const out = [...byPath.values()];
  for (const p of out) {
    if (p.isWorkspace) {
      p.id = p.path.replace(/\//g, '-');
      p.name = p.path.split('/').filter(Boolean).pop() || p.id;
    }
    // Re-stat `missing` post-merge: a workspace-only parent (brand new repo,
    // no sessions yet outside the workspace) never got a real missing check.
    try {
      p.missing = !(await stat(p.path)).isDirectory();
    } catch {
      p.missing = true;
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  // Strip the scan-internal flag before returning — callers get Project[].
  return out.map(({ isWorkspace: _isWorkspace, ...rest }) => rest);
}

// Read every session file in one project dir into SessionMeta[] (no sort/filter —
// callers combine multiple dirs first). Shared by listSessions' own dir and its
// workspace-dir folding below.
// Exported for teams-store.ts: resolving a teammate's session id needs the same
// head-cache reads this function already does — no separate re-parse of the jsonl.
export async function readDirSessions(dirPath: string, projectId: string, provider: ProviderId): Promise<SessionMeta[]> {
  let files: string[];
  try {
    files = (await readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const now = Date.now();
  const metas: SessionMeta[] = [];
  for (const file of files) {
    const filePath = join(dirPath, file);
    let mtime: number;
    try {
      mtime = Math.floor((await stat(filePath)).mtimeMs);
    } catch {
      continue;
    }
    const head = await readHead(filePath, mtime);
    const id = file.replace(/\.jsonl$/, '');
    metas.push({
      id,
      provider,
      projectId,
      title: head.title,
      branch: head.branch,
      mtime,
      startedAt: head.startedAt,
      durationMs: head.startedAt !== null ? mtime - head.startedAt : null,
      live: now - mtime < LIVE_WINDOW_MS,
      teamName: head.teamName ?? undefined,
      agentName: head.agentName ?? undefined,
    });
  }
  return metas;
}

// Real cwd this project dir was recorded under (prefers the jsonl-recorded
// cwd over the lossy dash-decode — mirrors scanProjects; a hyphenated repo
// name would otherwise resolve to the wrong parent path here too).
async function realCwdOf(dirPath: string, fallback: string): Promise<string> {
  let files: string[];
  try {
    files = (await readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return fallback;
  }
  let newestFile: { path: string; mtime: number } | null = null;
  for (const f of files) {
    const fp = join(dirPath, f);
    try {
      const st = await stat(fp);
      if (!newestFile || st.mtimeMs > newestFile.mtime) newestFile = { path: fp, mtime: st.mtimeMs };
    } catch {
      /* skip */
    }
  }
  if (!newestFile) return fallback;
  const head = await readHead(newestFile.path, Math.floor(newestFile.mtime));
  return head.cwd || fallback;
}

// Given a parent repo path, find every dirent under `root` that belongs to
// its session group: the repo's OWN dirent (real cwd === parentPath) plus
// every workspace worktree dirent (real cwd is one of parentPath's recorded
// worktree dirs) — the other half of scanProjects' grouping (Spec 1
// "Scanning seam"). Reads only dir names + one head each; cheap relative to
// the per-session parse below. Returns [] when parentPath has no known
// workspaces AND doesn't match any dirent's own cwd (plain, non-workspace
// project — caller falls back to reading its own dirent directly).
async function memberDirs(root: string, parentPath: string, parentOf: Map<string, string>): Promise<string[]> {
  const workspaceDirs = new Set([...parentOf.entries()].filter(([, p]) => p === parentPath).map(([dir]) => dir));

  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dirPath = join(root, d.name);
    let files: string[];
    try {
      files = (await readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    // One head read is enough to learn this dirent's real cwd.
    let newestFile: { path: string; mtime: number } | null = null;
    for (const f of files) {
      const fp = join(dirPath, f);
      try {
        const st = await stat(fp);
        if (!newestFile || st.mtimeMs > newestFile.mtime) newestFile = { path: fp, mtime: st.mtimeMs };
      } catch {
        /* skip */
      }
    }
    if (!newestFile) continue;
    const head = await readHead(newestFile.path, Math.floor(newestFile.mtime));
    if (head.cwd && (head.cwd === parentPath || workspaceDirs.has(head.cwd))) hits.push(dirPath);
  }
  return hits;
}

export async function listSessions(projectId: string, opts: ListOpts): Promise<SessionMeta[]> {
  const { root, provider, before, limit, q } = opts;
  const dirPath = join(root, projectId);

  // Resolve projectId to the parent repo's real path, handling all three id
  // forms a caller may pass:
  //  1. A workspace worktree's OWN dirent id — realCwdOf(dirPath) resolves to
  //     the worktree's cwd, which IS a key in parentOf; map UP to its parent
  //     repo (a worktree scanned as its own entry before grouping applied).
  //  2. The repo's own dirent id — realCwdOf(dirPath) resolves directly to
  //     the repo path (not a worktree dir), used as-is.
  //  3. A synthesized parent id (scanProjects made one up because no repo
  //     dirent exists — order 2's fix) — dirPath doesn't exist on disk, so
  //     realCwdOf falls back to the lossy decode of projectId, which for a
  //     synthesized id IS already the dash-encoding of the real repo path
  //     (scanProjects and this synthesis use the same encoding), so the
  //     lossy decode happens to be exact here — EXCEPT when the repo path
  //     itself contains a hyphen, where decode would mangle it. Guard that
  //     case by reverse-matching projectId against every known parent repo's
  //     own dash-encoding first.
  const parentOf = await workspaceParentMap();
  const repoByEncodedId = new Map(
    [...new Set(parentOf.values())].map((repoPath) => [repoPath.replace(/\//g, '-'), repoPath]),
  );
  const enteredCwd = await realCwdOf(dirPath, decodeProjectDir(projectId).path);
  const parentPath = parentOf.get(enteredCwd) ?? repoByEncodedId.get(projectId) ?? enteredCwd;

  const members = await memberDirs(root, parentPath, parentOf);
  const dirs = members.length ? members : [dirPath]; // no workspaces -> plain project, read its own dirent

  const metas: SessionMeta[] = [];
  for (const dir of dirs) {
    metas.push(...(await readDirSessions(dir, projectId, provider)));
  }

  metas.sort((a, b) => b.mtime - a.mtime); // newest first

  let filtered = metas;
  if (typeof before === 'number') filtered = filtered.filter((m) => m.mtime < before);
  if (q) {
    const needle = q.toLowerCase();
    filtered = filtered.filter(
      (m) =>
        m.title.toLowerCase().includes(needle) ||
        (m.branch ?? '').toLowerCase().includes(needle),
    );
  }
  if (typeof limit === 'number') filtered = filtered.slice(0, limit);
  return filtered;
}

// Recursively sum the byte size of every `.jsonl` under `root`. Works for both the flat
// claude layout (<root>/<projectDir>/<id>.jsonl) and the nested codex layout
// (<root>/YYYY/MM/DD/rollout-*.jsonl). Never throws — returns 0 on a missing/unreadable root.
export async function storeBytes(root: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0; // no store
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      total += await storeBytes(p);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        total += (await stat(p)).size;
      } catch {
        /* file vanished mid-scan — skip */
      }
    }
  }
  return total;
}

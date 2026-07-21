// Claude session-store scanner. PROVIDER-AGNOSTIC by design: the `~/.claude/projects`
// path and the `'claude'` provider id are NOT hardcoded here (hard rule 3) — the caller
// (server/lib/providers/claude.ts) supplies both `root` and `provider`. This file only
// knows how to read a directory of dash-encoded project dirs each holding `<id>.jsonl`.

import { open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { git, listAll as listAllWorkspaces } from '../workspaces';
import { Lru } from './lru';

// A session head lives in the first handful of lines; cap the bytes we read so a
// newline-free / giant single-line jsonl can't be buffered whole (BUG-C1: readline
// over such a file pulled a 209MB line into RSS on GET /api/projects). 256KB covers
// far more than the 50-line head scan below for any real session.
// ponytail: if a legit head sits past 256KB (huge pasted first message), title degrades
// to '' — but cwd is RECOVERED from a bounded tail read (see computeHead), because a null
// cwd mis-paths the whole project group (resume 400s on hyphenated repos).
const HEAD_BYTES = 256 * 1024;
const TAIL_RECOVER_BYTES = 64 * 1024;

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
  // The session's REAL working directory from its jsonl head. For a folded worktree
  // session this is the worktree dir, NOT the parent repo the projectId names —
  // consumers that spawn/diff in "the session's directory" must use this, never
  // re-derive a path from projectId (bridge handoff/review cwd fix).
  cwd?: string;
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
// Reject an id that could traverse out of the store root when path-joined. A valid
// projectId/sessionId is always a single dirent name or a dash-encoded path (never
// contains a real "/"), so banning path separators, NUL and any ".." segment closes
// traversal (join can only escape root via "..") without rejecting any legit id form.
// ponytail: syntactic reject is enough — no separators/".." means join(root,id) stays
// under root, so realpath containment would be redundant.
export function isSafeId(id: string): boolean {
  return !!id && !id.includes('/') && !id.includes('\\') && !id.includes('\0') && !id.includes('..');
}

// Encode an absolute cwd into the project id — the dash-encoded dirent name Claude Code
// itself writes under ~/.claude/projects. EVERY provider must produce byte-identical ids
// for the same repo path or routes/projects.ts merges them into separate cards and the
// cross-agent bridge can never pair them (D5-1).
//
// SCHEMA DISCOVERY (hard rule 6 — derived, not guessed, from all 17 real (cwd, dirent)
// pairs in this machine's ~/.claude/projects on 2026-07-11, by reading each dirent's own
// recorded cwd): Claude replaces EVERY non-alphanumeric character with "-", not just "/".
// Real pairs that prove each class:
//   "/Users/b/Local Sites/markauthor"            -> "-Users-b-Local-Sites-markauthor"   (space)
//   ".../seshmux/.claude/worktrees/agent-a8fd"   -> "...-seshmux--claude-worktrees-..." (dot)
//   ".../themes/ML_Author"                       -> "...-themes-ML-Author"              (underscore)
// A "/"-only encode mismatched 8/17; a "/"+space encode still mismatched 5/17; this
// [^a-zA-Z0-9] encode matched 17/17. Lossy by design (decodeProjectDir cannot invert it) —
// callers needing the true path use the cwd recorded inside the session file.
export function encodeProjectId(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// Segment separators of a REAL, OS-native path. win32 accepts both; on posix a
// backslash is a legal FILENAME character, so treating it as a separator there
// would change behavior — hence the platform branch rather than a blanket
// [\\/]. Identity on posix.
const PATH_SEP_RE = process.platform === 'win32' ? /[\\/]/ : /\//;

/**
 * Last segment of a REAL path (a cwd the agent recorded, or a repo path we
 * resolved) — i.e. the project's display name.
 *
 * A `/`-only split never splits a native Windows path, so `.pop()` returned the
 * WHOLE absolute path and every project on Windows was titled
 * "C:\Users\b\dev\seshmux" instead of "seshmux".
 *
 * NOT for decodeProjectDir's output: that is a synthetic "-"→"/" decode which is
 * forward-slash by construction and must keep splitting on "/" only.
 */
export function pathLeaf(p: string): string | undefined {
  return p.split(PATH_SEP_RE).filter(Boolean).pop();
}

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

  // Bounded read of the file head only (never the whole file — BUG-C1). A partial
  // last line from the byte cap just fails JSON.parse below and is skipped.
  let text = '';
  let tail = '';
  try {
    const fh = await open(filePath, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      text = buf.toString('utf8', 0, bytesRead);
      // A first LINE bigger than the cap leaves zero parseable head lines → cwd null →
      // the project path falls back to the lossy dash-decode (resume 400s on hyphenated
      // repos — the exact failure the head read exists to avoid). Recover cwd/branch from
      // a bounded TAIL read: later events also stamp cwd, and the tail of a giant-first-
      // line file is still cheap. Only when the head hit the cap without a newline.
      if (bytesRead === HEAD_BYTES && !text.includes('\n')) {
        const { size } = await fh.stat();
        const tailStart = Math.max(HEAD_BYTES, size - TAIL_RECOVER_BYTES);
        const tailBuf = Buffer.alloc(Math.min(TAIL_RECOVER_BYTES, Math.max(0, size - tailStart)));
        if (tailBuf.length > 0) {
          const r = await fh.read(tailBuf, 0, tailBuf.length, tailStart);
          tail = tailBuf.toString('utf8', 0, r.bytesRead);
          tail = tail.slice(tail.indexOf('\n') + 1); // drop the leading partial line
        }
      }
    } finally {
      await fh.close();
    }
  } catch {
    // open/read error (EACCES/ENOENT/vanished-between-stat-and-open) — degrade to an
    // empty head instead of rejecting; protects both readHead call sites
    // (computeRootScan, readDirSessions) at the root.
    return { title, branch, startedAt, cwd, teamName, agentName };
  }
  if (tail) text = text.slice(0, text.lastIndexOf('\n') + 1) + tail;

  for (const line of text.split('\n')) {
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

  // win32: fold the recorded cwd to the SAME canonical form the workspaces store
  // uses. workspaces.json's `project`/`dir` are realpath'd via node:fs/promises
  // (the native flavor, which expands 8.3 short names: C:\Users\RUNNER~1\ ->
  // runneradmin). A real Windows agent launched from an 8.3-spelled directory
  // records the SHORT form via getcwd(), so its worktree would never fold into
  // its parent (raw short cwd != canonical long record). Canonicalize here, at
  // the single point cwd is extracted, so every reader (grouping, memberDirs,
  // projectSessionDirs, SessionMeta.cwd) compares like-for-like. Cached by
  // readHead's mtime key, so the realpath runs once per file change, not per scan.
  // Identity on posix (getcwd() is already canonical there). Fallback to the raw
  // path when it no longer exists (deleted repo — realpath ENOENTs).
  if (cwd) cwd = await canonCwd(cwd);

  return { title, branch, startedAt, cwd, teamName, agentName };
}

async function canonCwd(cwd: string): Promise<string> {
  if (process.platform !== 'win32') return cwd;
  try {
    return await realpath(cwd);
  } catch {
    return cwd;
  }
}

// Inverse of workspaces.ts's gitPath(): git ALWAYS reports forward slashes,
// even on native Windows, so any path taken from git output must be converted
// before it is compared against (or used as a map key alongside) a node-native
// path. Identity on posix, where sep is already '/'.
function nativePath(gitFormPath: string): string {
  return process.platform === 'win32' ? gitFormPath.split('/').join(sep) : gitFormPath;
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

// Claude Code's own EnterWorktree creates `<repo>/.claude/worktrees/<name>` —
// no workspaces.json record (that store is seshmux-owned, hard rule 3 keeps
// provider-specific paths out of it), so these must be recognized purely from
// the cwd pattern rather than a lookup. Record-driven workspaceParentMap()
// can't hold this: it's built from workspaces.json BEFORE the scan discovers
// any cwd, so there's no candidate list to pre-populate. Every parentOf.get()
// call site below falls back to this so all three consumers (grouping,
// memberDirs, listSessions id-resolution) agree on the same parent.
// Matches the worktree root AND any cwd deeper inside it (a session started in
// worktrees/x/subdir must fold too). Greedy `(.+)` takes the LAST occurrence, so a
// nested worktree-in-worktree folds to its innermost parent — fine.
// Matched against a REAL recorded cwd, so it must accept the host's separator:
// on native Windows those cwds are backslash-separated and the "/"-only form
// never matched, silently disabling worktree folding everywhere
// derivedWorkspaceParent is consumed (grouping, memberDirs, listSessions,
// routes/bridge wait, routes/term). Platform-branched rather than a blanket
// [\\/] because a backslash is a legal posix filename character — identity on
// posix.
const CLAUDE_WORKTREE_RE =
  process.platform === 'win32'
    ? /^(.+)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/]|$)/
    : /^(.+)\/\.claude\/worktrees\/[^/]+(?:\/|$)/;
// Exported: CodexProvider.scanProjects()/listSessions() do their own cwd->id grouping
// (they don't route through computeRootScan above) and must apply the same fold so a
// repo cwd resolves to the same project id regardless of which provider recorded it
// (cross-provider-merge D5-1).
// NOTE (fold scope, deliberate): scannedResolveRepo (routes/customizations.ts) resolves a
// folded project id to the PARENT repo path, so project-scope customization/marketplace
// writes intentionally land in the parent repo's .claude — not in a transient worktree.
export function derivedWorkspaceParent(cwd: string): string | null {
  return CLAUDE_WORKTREE_RE.exec(cwd)?.[1] ?? worktreeParentCached(cwd);
}

// ── git-truth worktree fold ────────────────────────────────────────────────
// The two mechanisms above only recognize worktrees by WHERE THEY LIVE:
// workspaces.json (dirs seshmux created) and the `.claude/worktrees/` pattern.
// A worktree made with plain `git worktree add ../anywhere` matches neither, so
// its sessions surfaced as their own top-level project instead of folding into
// the repo they belong to. Only git can answer for those, so ask git.
//
// `rev-parse --git-common-dir --show-toplevel` answers both halves in one call:
// common-dir is always the MAIN repo's .git (even from inside a linked
// worktree), so dirname(common-dir) is the parent repo, and it differs from
// show-toplevel exactly when the cwd is in a linked worktree.
//
// Cached because this runs per project dirent per scan and a scan is frequent.
// Negative results are cached too — most cwds are ordinary repos and re-probing
// them every scan is the cost that actually matters.
//
// ponytail: derivedWorkspaceParent() stays SYNC (restore.ts, codex.ts and
// ledger-binding.ts all call it in sync paths), so it reads this cache rather
// than probing. It therefore folds a git-discovered worktree only once a scan
// has warmed the entry — which computeRootScan does for every project cwd, so
// in practice the first scan warms it and those callers agree from then on.
// Making it async would ripple through all three call sites for a fold that
// only affects grouping display; revisit if a sync caller ever needs it cold.
const WORKTREE_PARENT_TTL_MS = 60_000;
const worktreeParents = new Map<string, { parent: string | null; at: number }>();
const worktreeProbes = new Map<string, Promise<string | null>>();

function worktreeParentCached(cwd: string): string | null {
  const hit = worktreeParents.get(cwd);
  return hit && Date.now() - hit.at < WORKTREE_PARENT_TTL_MS ? hit.parent : null;
}

/**
 * Parent repo of `cwd` when it sits inside a linked git worktree, else null.
 * Fails open: a non-repo, a git that can't answer, or a git too old for
 * --path-format all return null, which just means "no fold" — the same result
 * as before this existed.
 */
export async function worktreeParent(cwd: string): Promise<string | null> {
  const hit = worktreeParents.get(cwd);
  if (hit && Date.now() - hit.at < WORKTREE_PARENT_TTL_MS) return hit.parent;
  // Dedupe concurrent probes: computeRootScan maps over dirents in parallel and
  // several can share a cwd, which would otherwise be N identical subprocesses.
  const inFlight = worktreeProbes.get(cwd);
  if (inFlight) return inFlight;

  const probe = (async () => {
    let parent: string | null = null;
    try {
      const out = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']);
      const [commonDir, toplevel] = out.split('\n').map((l) => l.trim());
      if (commonDir && toplevel) {
        const mainRepo = dirname(commonDir); // <main>/.git -> <main>
        // Comparing the two raw is safe — both come from the same git output,
        // so they share a separator form. Equal = this IS the main worktree
        // (or a subdir of it): nothing to fold.
        //
        // The RETURNED value is not safe raw. git emits forward slashes even
        // on native Windows ("C:/Users/…") while every other cwd in this file
        // is native form via canonCwd(), and this value becomes a byPath map
        // KEY in computeRootScan — mismatched forms hash apart and the fold
        // silently stops happening. Exactly the bug workspaces.ts's gitPath()
        // exists for ("the same silent prune hit EVERY workspace on native
        // Windows, on every boot"). Convert to native, then canonCwd so 8.3
        // short names match the recorded-cwd side too.
        if (mainRepo !== toplevel) parent = await canonCwd(nativePath(mainRepo));
      }
    } catch {
      /* not a repo / git unavailable — no fold */
    }
    if (worktreeParents.size > 500) worktreeParents.clear(); // ponytail: crude bound
    worktreeParents.set(cwd, { parent, at: Date.now() });
    worktreeProbes.delete(cwd);
    return parent;
  })();
  worktreeProbes.set(cwd, probe);
  return probe;
}

// Encoded-id sibling of derivedWorkspaceParent, for callers that only have a store
// DIRENT name (watch.ts events see file paths, and decodeProjectDir is lossy — the
// "." in ".claude" decodes to "/", so path-level matching can't work there).
// encodeProjectId maps "/.claude/worktrees/" to "--claude-worktrees-", so strip that
// suffix to recover the parent's encoded id. Greedy `(.+)` = innermost fold wins.
// ponytail: a repo literally named "*--claude-worktrees-*" would false-fold; encode is
// lossy so this can't be told apart — acceptable, same ceiling as decodeProjectDir.
// ponytail: win32 8.3 ceiling — this matches on the ENCODED DIRENT NAME, which watch.ts
// events see (they have no cwd to realpath). A worktree whose recorded cwd is an 8.3
// short path encodes to "*CLAUDE~1-WORKTR~1*", not "--claude-worktrees-", so it won't
// fold here even though canonCwd folds it in the path-based scan. Rare (an agent hand-
// launched from a short path) and unreachable from the cwd side — left as-is.
const CLAUDE_WORKTREE_ID_RE = /^(.+)--claude-worktrees-.+$/;
export function derivedWorkspaceParentId(encodedId: string): string | null {
  return CLAUDE_WORKTREE_ID_RE.exec(encodedId)?.[1] ?? null;
}

// Intermediate per-dirent scan result before the byPath merge pass folds
// workspace dirents into their parent. `isWorkspace` is scan-internal only —
// dropped before Project[] is returned.
interface ScannedEntry extends Project {
  isWorkspace: boolean;
}

// Result of one full root walk: the merged Project[] AND the per-dirent real
// cwd map that listSessions' member-dir resolution needs, computed in the SAME
// pass so listSessions never re-walks the root (PERF-1). `dirCwds` holds only
// dirents with a non-null recorded cwd — the only ones member-dir matching or
// realCwd resolution ever hits.
interface RootScan {
  projects: Project[];
  dirCwds: { dirPath: string; cwd: string }[];
}

// Short-TTL memo of the store scan, keyed per (provider, root). One request used
// to re-crawl ~3,600 files several times (GET /api/projects, per-project listing,
// search enrichment, per-PTY live resolution); this collapses them to one walk
// bounded by TTL, and the chokidar watcher invalidates on file change so
// staleness is bounded by watcher-debounce, not just the TTL floor.
// The PROMISE is cached (not the resolved value) so concurrent callers within
// one tick — e.g. the /api/sessions/live Promise.all over N PTYs — share a
// single in-flight walk (PERF-2).
const SCAN_TTL_MS = 3000;
interface ScanCacheEntry {
  at: number;
  scan: Promise<RootScan>;
}
const scanCache = new Map<string, ScanCacheEntry>();

function scanKey(root: string, provider: ProviderId): string {
  return `${provider}:${root}`;
}

async function scanRoot(root: string, provider: ProviderId): Promise<RootScan> {
  const key = scanKey(root, provider);
  const hit = scanCache.get(key);
  if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.scan;
  const scan = computeRootScan(root, provider);
  scanCache.set(key, { at: Date.now(), scan });
  // A rejected scan must not stay cached for the full TTL (it would recur on
  // every read) — evict it, guarded by identity so a newer entry isn't clobbered.
  scan.catch(() => {
    if (scanCache.get(key)?.scan === scan) scanCache.delete(key);
  });
  return scan;
}

// Drop cached scans so the next read re-walks disk. No arg = clear everything;
// a provider id clears only that provider's roots (wired to the chokidar watcher
// in events-hub — a session-new/touch on a provider bumps its scan). Safe to
// call with any ProviderId; a provider with no cached root is a no-op.
export function invalidateScanCache(provider?: ProviderId): void {
  if (!provider) {
    scanCache.clear();
    return;
  }
  const prefix = `${provider}:`;
  for (const key of scanCache.keys()) {
    if (key.startsWith(prefix)) scanCache.delete(key);
  }
}

export async function scanProjects(root: string, provider: ProviderId): Promise<Project[]> {
  return (await scanRoot(root, provider)).projects;
}

async function computeRootScan(root: string, provider: ProviderId): Promise<RootScan> {
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch {
    return { projects: [], dirCwds: [] };
  }

  const parentOf = await workspaceParentMap();
  const dirCwds: { dirPath: string; cwd: string }[] = [];

  // Scan every project dir in parallel (PERF-5): each is independent readdir +
  // stat-all + one head read.
  const scanned = await Promise.all(
    dirents
      .filter((d) => d.isDirectory())
      .map(async (d): Promise<ScannedEntry | null> => {
        const dirPath = join(root, d.name);
        let files: string[];
        try {
          files = (await readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
        } catch {
          return null;
        }
        if (files.length === 0) return null;
        const decoded = decodeProjectDir(d.name);
        // Stat each session file: updatedAt = newest mtime (catches resume appends
        // that leave the dir mtime untouched), createdAt = oldest birthtime. Track
        // the newest file so we can read its real cwd from the jsonl head.
        const stats = await Promise.all(
          files.map(async (f) => {
            const fp = join(dirPath, f);
            try {
              return { fp, st: await stat(fp) };
            } catch {
              return null; // skip unreadable file
            }
          }),
        );
        let updatedAt = 0;
        let createdAt = Number.MAX_SAFE_INTEGER;
        let newestFile: { path: string; mtime: number } | null = null;
        for (const s of stats) {
          if (!s) continue;
          updatedAt = Math.max(updatedAt, s.st.mtimeMs);
          createdAt = Math.min(createdAt, s.st.birthtimeMs || s.st.mtimeMs);
          if (!newestFile || s.st.mtimeMs > newestFile.mtime) newestFile = { path: s.fp, mtime: s.st.mtimeMs };
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
            name = pathLeaf(head.cwd) || decoded.name;
            dirCwds.push({ dirPath, cwd: head.cwd });
          }
        }
        let missing = false;
        try {
          missing = !(await stat(path)).isDirectory();
        } catch {
          missing = true;
        }
        // parentPath set = this dirent's cwd is a worktree — folded into the
        // parent project below, never listed on its own (no rail sprout of one
        // project group per workspace). Three sources, cheapest first: the
        // seshmux ledger, the .claude/worktrees path pattern, and finally git
        // itself for worktrees created anywhere else. The git probe is cached
        // and only reached when the first two miss.
        const parentPath =
          parentOf.get(path) ?? CLAUDE_WORKTREE_RE.exec(path)?.[1] ?? (await worktreeParent(path)) ?? null;
        return {
          id: d.name,
          provider,
          name,
          path: parentPath ?? path,
          sessionCount: files.length,
          createdAt,
          updatedAt,
          missing: parentPath ? false : missing, // parent's own missing-ness checked in the merge pass
          isWorkspace: !!parentPath,
        };
      }),
  );
  const projects = scanned.filter((p): p is ScannedEntry => p !== null);

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
      } else if (!prev.isWorkspace && !p.isWorkspace && p.id < prev.id) {
        // Two non-workspace dirents on the SAME canonical path (win32 only: the
        // same repo recorded once short-form, once long-form, now folded by
        // canonCwd). Neither is "the" own-dirent, so the tiebreak above never
        // fires — pick the lexicographically smaller id so the winner is
        // deterministic, not dependent on readdir order. No-op on posix (a
        // canonical cwd yields exactly one dirent per path).
        prev.id = p.id;
        prev.name = p.name;
      }
    } else {
      byPath.set(p.path, { ...p });
    }
  }
  // Every remaining group still flagged isWorkspace never saw its repo's own
  // dirent — synthesize a stable id/name from the repo path itself.
  const out = [...byPath.values()];
  await Promise.all(
    out.map(async (p) => {
      if (p.isWorkspace) {
        p.id = encodeProjectId(p.path);
        p.name = pathLeaf(p.path) || p.id;
      }
      // Re-stat `missing` post-merge: a workspace-only parent (brand new repo,
      // no sessions yet outside the workspace) never got a real missing check.
      try {
        p.missing = !(await stat(p.path)).isDirectory();
      } catch {
        p.missing = true;
      }
    }),
  );
  out.sort((a, b) => a.name.localeCompare(b.name));
  // Strip the scan-internal flag before returning — callers get Project[].
  return { projects: out.map(({ isWorkspace: _isWorkspace, ...rest }) => rest), dirCwds };
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
      cwd: head.cwd ?? undefined,
      teamName: head.teamName ?? undefined,
      agentName: head.agentName ?? undefined,
    });
  }
  return metas;
}

// Given a parent repo path, find every dirent that belongs to its session
// group: the repo's OWN dirent (real cwd === parentPath) plus every workspace
// worktree dirent (real cwd is one of parentPath's recorded worktree dirs) —
// the other half of scanProjects' grouping (Spec 1 "Scanning seam"). Pure over
// the cached scan's dirCwds map (no disk walk — that already happened once in
// computeRootScan). Returns [] when parentPath has no known workspaces AND
// doesn't match any dirent's own cwd (plain, non-workspace project — caller
// falls back to reading its own dirent directly).
function memberDirs(
  dirCwds: { dirPath: string; cwd: string }[],
  parentPath: string,
  parentOf: Map<string, string>,
): string[] {
  const workspaceDirs = new Set([...parentOf.entries()].filter(([, p]) => p === parentPath).map(([dir]) => dir));
  return dirCwds
    .filter(({ cwd }) => cwd === parentPath || workspaceDirs.has(cwd) || derivedWorkspaceParent(cwd) === parentPath)
    .map(({ dirPath }) => dirPath);
}

// Resolve a projectId to EVERY store dirent holding its sessions: the parent repo's
// own dirent plus every folded workspace/worktree dirent. This is the single
// projectId→disk lookup — listSessions AND sessionFilePath below both route through
// it, so "session listed under this id" and "session file found under this id" can
// never disagree. Returns [] only for an unsafe id.
export async function projectSessionDirs(projectId: string, root: string, provider: ProviderId): Promise<string[]> {
  if (!isSafeId(projectId)) return []; // traversal guard (SEC-4): never join a "../" id
  const dirPath = join(root, projectId);

  // Resolve projectId to the parent repo's real path, handling all three id
  // forms a caller may pass:
  //  1. A workspace worktree's OWN dirent id — its recorded cwd IS a key in
  //     parentOf; map UP to its parent repo (a worktree scanned as its own
  //     entry before grouping applied).
  //  2. The repo's own dirent id — its recorded cwd resolves directly to the
  //     repo path (not a worktree dir), used as-is.
  //  3. A synthesized parent id (scanProjects made one up because no repo
  //     dirent exists — order 2's fix) — dirPath isn't in dirCwds, so we fall
  //     back to the lossy decode of projectId, which for a synthesized id IS
  //     already the dash-encoding of the real repo path (scanProjects and this
  //     synthesis use the same encoding), so the lossy decode happens to be
  //     exact here — EXCEPT when the repo path itself contains a hyphen, where
  //     decode would mangle it. Guard that case by reverse-matching projectId
  //     against every known parent repo's own dash-encoding first.
  const { dirCwds } = await scanRoot(root, provider);
  const cwdByDir = new Map(dirCwds.map(({ dirPath: d, cwd }) => [d, cwd]));
  const parentOf = await workspaceParentMap();
  // Known parent repo paths for the reverse-encode guard above: recorded workspace parents
  // PLUS pattern-derived parents of every cwd this scan actually saw (a .claude/worktrees
  // parent has no workspaces.json record to supply it otherwise).
  const knownParents = new Set(parentOf.values());
  for (const { cwd } of dirCwds) {
    const derived = derivedWorkspaceParent(cwd);
    if (derived) knownParents.add(derived);
  }
  const repoByEncodedId = new Map([...knownParents].map((repoPath) => [encodeProjectId(repoPath), repoPath]));
  const enteredCwd = cwdByDir.get(dirPath) ?? decodeProjectDir(projectId).path;
  const parentPath =
    parentOf.get(enteredCwd) ?? derivedWorkspaceParent(enteredCwd) ?? repoByEncodedId.get(projectId) ?? enteredCwd;

  const members = memberDirs(dirCwds, parentPath, parentOf);
  return members.length ? members : [dirPath]; // no workspaces -> plain project, read its own dirent
}

// Resolve (projectId, sessionId) to the owning session file. A folded worktree
// session LISTS under the parent projectId but its jsonl lives in the worktree's own
// dirent — the naive join(root, projectId, id + '.jsonl') misses it (49 real sessions
// returned empty transcripts). Cheap path first: one stat on the direct join; only a
// miss pays for the member-dir scan. Returns null only for an unsafe id; a session
// that exists nowhere returns the direct path so callers degrade exactly as before
// (stat fails -> empty transcript / null ctx).
export async function sessionFilePath(
  projectId: string,
  sessionId: string,
  root: string,
  provider: ProviderId,
): Promise<string | null> {
  if (!isSafeId(projectId) || !isSafeId(sessionId)) return null;
  const direct = join(root, projectId, `${sessionId}.jsonl`);
  try {
    await stat(direct);
    return direct;
  } catch {
    /* fall through to member-dir search */
  }
  for (const dir of await projectSessionDirs(projectId, root, provider)) {
    const candidate = join(dir, `${sessionId}.jsonl`);
    if (candidate === direct) continue; // already checked
    try {
      await stat(candidate);
      return candidate;
    } catch {
      /* not in this member dir */
    }
  }
  return direct;
}

export async function listSessions(projectId: string, opts: ListOpts): Promise<SessionMeta[]> {
  const { root, provider, before, limit, q } = opts;
  const dirs = await projectSessionDirs(projectId, root, provider);

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

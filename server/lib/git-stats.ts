// Line-count diff for the statusbar +N/-N chip and the changes panel:
// everything not in the base branch — committed branch work, dirty tracked
// edits, and untracked files — measured against merge-base(base, HEAD).
// Read-only git throughout; every failure degrades to zeros (the bar shows
// nothing rather than erroring). Deliberately NOT part of workspaces.ts —
// that file is the destructive finish path and its guards fail closed;
// display data fails open.
//
// All path-emitting git calls use -z (NUL separators): the default
// core.quotepath octal-escapes non-ASCII filenames in newline output, which
// corrupted every unicode path. --no-renames keeps numstat/name-status on
// plain one-path records (renames otherwise emit `{old => new}` pseudo-paths
// that match nothing on disk); a rename shows as delete + add, which is also
// what the tree view can actually render.

import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { git } from './workspaces';

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  status: string; // git name-status letter (M/A/D…); untracked reported as 'A'
}

export interface GitChanges {
  added: number;
  removed: number;
  files: FileChange[];
  tree?: string[]; // full tracked file list + untracked, only when requested
}

// numstat record: `added\tremoved\tpath` — `-` for binary counts. Accepts
// both -z (NUL) and legacy newline separation.
export function parseNumstat(out: string): { path: string; added: number; removed: number }[] {
  const rows: { path: string; added: number; removed: number }[] = [];
  for (const line of out.split(/\0|\n/)) {
    if (!line.trim()) continue;
    const [a, r, ...rest] = line.split('\t');
    if (rest.length === 0) continue;
    rows.push({
      path: rest.join('\t'),
      added: a === '-' ? 0 : Number(a) || 0,
      removed: r === '-' ? 0 : Number(r) || 0,
    });
  }
  return rows;
}

// merge-base failure (unknown ref, unborn HEAD, detached weirdness) →
// diff against HEAD, i.e. uncommitted-only. Wrong-but-useful beats a 500.
async function resolveMergeBase(dir: string, baseRef: string | null): Promise<string> {
  if (!baseRef) return 'HEAD';
  try {
    return (await git(dir, ['merge-base', baseRef, 'HEAD'])).trim() || 'HEAD';
  } catch {
    return 'HEAD';
  }
}

/**
 * The ref everything is diffed against. origin/HEAD when there is an origin;
 * otherwise prefer a local main/master over the repo's CURRENT branch — the
 * old current-branch fallback gave agent/* worktree tabs a silently wrong
 * base whenever an originless repo sat on a feature branch. Null → callers
 * degrade to uncommitted-only.
 */
export async function defaultBaseRef(repo: string): Promise<string | null> {
  try {
    const out = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const ref = out.trim().replace(/^origin\//, '');
    if (ref) return ref;
  } catch {
    /* no origin — fall through */
  }
  for (const name of ['main', 'master']) {
    try {
      await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
      return name;
    } catch {
      /* not this one */
    }
  }
  try {
    return (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

// ── Untracked line counting ────────────────────────────────────────────────
// Streamed with a hard size cap (never buffer whole files — an untracked
// 1.5GB sqlite dump used to be read fully into memory on every 10s poll) and
// cached by (mtime, size) so unchanged files are never re-read.
const LINE_COUNT_CAP = 10 * 1024 * 1024; // count at most the first 10MB
const lineCache = new Map<string, { mtimeMs: number; size: number; lines: number }>();

async function untrackedLines(abs: string): Promise<number> {
  try {
    const st = await stat(abs);
    const hit = lineCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.lines;

    let lines = 0;
    let read = 0;
    let lastByte = 10;
    let binary = false;
    if (st.size > 0) {
      const fh = await open(abs, 'r');
      try {
        const buf = Buffer.alloc(64 * 1024);
        const limit = Math.min(st.size, LINE_COUNT_CAP);
        while (read < limit) {
          const { bytesRead } = await fh.read(buf, 0, buf.length, read);
          if (bytesRead <= 0) break;
          // Binary sniff on the first chunk (NUL byte) → 0 lines but the file
          // still appears in the list, mirroring how numstat reports binaries.
          if (read === 0 && buf.subarray(0, Math.min(bytesRead, 8192)).includes(0)) {
            binary = true;
            break;
          }
          for (let i = 0; i < bytesRead; i++) if (buf[i] === 10) lines++;
          lastByte = buf[bytesRead - 1];
          read += bytesRead;
        }
      } finally {
        await fh.close();
      }
    }
    // Trailing partial line counts only when we actually read to EOF — a
    // cap-truncated count stays a lower bound rather than inventing a line.
    const result = binary || st.size === 0 ? 0 : lines + (lastByte !== 10 && read >= st.size ? 1 : 0);
    if (lineCache.size > 10_000) lineCache.clear(); // ponytail: crude bound; LRU if it ever matters
    lineCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, lines: result });
    return result;
  } catch {
    return 0;
  }
}

const splitZ = (out: string) => out.split('\0').filter(Boolean);

// Cap the diff shipped to the browser — the client renders one element per
// line, so an uncapped lockfile diff froze the tab.
const MAX_DIFF_LINES = 5000;

/**
 * Unified diff for ONE file vs the merge-base (same base logic as changes()).
 * Untracked files diff against /dev/null so they render as all-added.
 * Truncated past MAX_DIFF_LINES (flag tells the client to say so).
 *
 * `relPath` is a TRUST BOUNDARY: it arrives from a query param, and the
 * untracked branch below hands an absolute path to `git diff --no-index`,
 * which would happily read any file on disk. Resolve + prefix-check against
 * the repo dir and refuse anything that escapes. Failures return an empty
 * diff — this is display data, not a guard.
 */
export async function fileDiff(
  dir: string,
  baseRef: string | null,
  relPath: string,
): Promise<{ diff: string; truncated: boolean }> {
  const empty = { diff: '', truncated: false };
  try {
    const abs = path.resolve(dir, relPath);
    if (!abs.startsWith(path.resolve(dir) + path.sep)) return empty;

    const base = await resolveMergeBase(dir, baseRef);
    const tracked = await git(dir, ['diff', '--no-renames', base, '--', relPath]);
    if (tracked) return truncateDiff(tracked);

    // Untracked? Only diff --no-index files git itself lists as untracked —
    // never an arbitrary path (see trust-boundary note above).
    const untracked = splitZ(await git(dir, ['ls-files', '-o', '--exclude-standard', '-z', '--', relPath]));
    if (untracked.length === 0) return empty;
    try {
      return truncateDiff(await git(dir, ['diff', '--no-index', '--', '/dev/null', abs]));
    } catch (e) {
      // git diff --no-index exits 1 when files differ — that's the success path.
      const out = (e as { stdout?: string }).stdout;
      return typeof out === 'string' ? truncateDiff(out) : empty;
    }
  } catch {
    return empty;
  }
}

function truncateDiff(diff: string): { diff: string; truncated: boolean } {
  const lines = diff.split('\n');
  if (lines.length <= MAX_DIFF_LINES) return { diff, truncated: false };
  return { diff: lines.slice(0, MAX_DIFF_LINES).join('\n'), truncated: true };
}

// ── changes(): the chip + panel data ───────────────────────────────────────
// Coalesced: the statusbar chip, an open panel, and N grid tiles of the same
// project all poll the same (dir, base) — one in-flight computation plus a
// short TTL serves them all instead of N× the subprocess fan-out.
const changesMemo = new Map<string, { at: number; promise: Promise<GitChanges> }>();
const CHANGES_TTL_MS = 5000;

export function changes(dir: string, baseRef: string | null, wantTree: boolean): Promise<GitChanges> {
  const key = `${dir}\0${baseRef ?? ''}\0${wantTree}`;
  const hit = changesMemo.get(key);
  if (hit && Date.now() - hit.at < CHANGES_TTL_MS) return hit.promise;
  const promise = computeChanges(dir, baseRef, wantTree);
  if (changesMemo.size > 200) changesMemo.clear(); // ponytail: crude bound
  changesMemo.set(key, { at: Date.now(), promise });
  return promise;
}

async function computeChanges(dir: string, baseRef: string | null, wantTree: boolean): Promise<GitChanges> {
  try {
    const base = await resolveMergeBase(dir, baseRef);

    const [numstatOut, nameStatusOut, untrackedOut] = await Promise.all([
      git(dir, ['diff', '--numstat', '--no-renames', '-z', base]),
      git(dir, ['diff', '--name-status', '--no-renames', '-z', base]),
      git(dir, ['ls-files', '-o', '--exclude-standard', '-z']),
    ]);

    // name-status -z is a flat token stream: status, path, status, path, …
    // (--no-renames guarantees one path per record).
    const statusTokens = splitZ(nameStatusOut);
    const statusByPath = new Map<string, string>();
    for (let i = 0; i + 1 < statusTokens.length; i += 2) {
      statusByPath.set(statusTokens[i + 1], statusTokens[i].charAt(0));
    }

    const files: FileChange[] = parseNumstat(numstatOut).map((f) => ({
      ...f,
      status: statusByPath.get(f.path) ?? 'M',
    }));

    // Untracked counts in small batches: parallel enough to not serialize a
    // big list, bounded so 30k suddenly-untracked files can't exhaust fds.
    const untracked = splitZ(untrackedOut);
    for (let i = 0; i < untracked.length; i += 16) {
      const batch = await Promise.all(
        untracked.slice(i, i + 16).map(async (rel) => ({
          path: rel,
          added: await untrackedLines(path.join(dir, rel)),
          removed: 0,
          status: 'A',
        })),
      );
      files.push(...batch);
    }

    const result: GitChanges = {
      added: files.reduce((n, f) => n + f.added, 0),
      removed: files.reduce((n, f) => n + f.removed, 0),
      files,
    };
    if (wantTree) {
      const tracked = splitZ(await git(dir, ['ls-files', '-z']));
      result.tree = [...new Set([...tracked, ...untracked])].sort();
    }
    return result;
  } catch {
    return { added: 0, removed: 0, files: [] };
  }
}

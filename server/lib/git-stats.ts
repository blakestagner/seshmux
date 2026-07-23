// Line-count diff for the statusbar +N/-N chip and the changes panel:
// everything not in the base branch — committed branch work, dirty tracked
// edits, and untracked files — measured against merge-base(base, HEAD).
// Read-only git throughout; failures degrade to a zeros payload carrying
// `degraded: true` so clients can keep their last good value instead of
// blanking the chip (and the memo below never caches a degraded result).
// Deliberately NOT part of workspaces.ts — that file is the destructive
// finish path and its guards fail closed; display data fails open.
//
// All path-emitting git calls use -z (NUL separators): the default
// core.quotepath octal-escapes non-ASCII filenames in newline output, which
// corrupted every unicode path. Rename detection stays ON — a rename is
// reported as the new path (status R, the DETECTED line counts, so a pure
// `git mv` counts ~0, not the whole file) plus the old path as a delete.

import { mkdir, open, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { git } from './workspaces';

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  status: string; // git name-status letter (M/A/D/R/C…); untracked reported as 'A'
  approx?: boolean; // line count capped (huge untracked file) — a lower bound
}

export interface GitChanges {
  added: number;
  removed: number;
  files: FileChange[];
  tree?: string[]; // full tracked file list + untracked, only when requested
  root?: string; // absolute dir the tree is relative to (tree requests only)
  degraded?: boolean; // git failed — zeros payload, keep your last good value
}

export interface NumstatEntry {
  path: string;
  added: number;
  removed: number;
  oldPath?: string; // set for rename/copy records (path = the NEW name)
}

// numstat record: `added\tremoved\tpath` — `-` for binary counts. -z (NUL)
// input gets the structural parser (handles rename records and filenames
// containing ANY byte incl. newlines); newline input is the legacy/test form.
export function parseNumstat(out: string): NumstatEntry[] {
  if (out.includes('\0')) return parseNumstatZ(out);
  const rows: NumstatEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [a, r, ...rest] = line.split('\t');
    if (rest.length === 0) continue;
    rows.push({ path: rest.join('\t'), added: num(a), removed: num(r) });
  }
  return rows;
}

const num = (s: string) => (s === '-' ? 0 : Number(s) || 0);

// -z numstat: normal records are one token `a\tr\tpath`; rename/copy records
// are `a\tr\t` followed by the old and new paths as their own NUL tokens.
function parseNumstatZ(out: string): NumstatEntry[] {
  const tokens = out.split('\0');
  const rows: NumstatEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const tab1 = t.indexOf('\t');
    const tab2 = t.indexOf('\t', tab1 + 1);
    if (tab1 === -1 || tab2 === -1) continue;
    const added = num(t.slice(0, tab1));
    const removed = num(t.slice(tab1 + 1, tab2));
    const rest = t.slice(tab2 + 1);
    if (rest === '') {
      const oldPath = tokens[++i];
      const newPath = tokens[++i];
      if (oldPath && newPath) rows.push({ path: newPath, added, removed, oldPath });
    } else {
      rows.push({ path: rest, added, removed });
    }
  }
  return rows;
}

// merge-base failure (unknown ref, unborn HEAD, detached weirdness) →
// diff against HEAD, i.e. uncommitted-only. Wrong-but-useful beats a 500.
//
// Both the local branch AND its origin/ counterpart are candidates, newest
// merge-base wins: a stale local main (or a stale origin/main with unpushed
// local commits) otherwise counts every commit between the stale tip and the
// real fork point as "branch changes" — the +12k phantom-diff bug.
async function resolveMergeBase(dir: string, baseRef: string | null): Promise<string> {
  if (!baseRef) return 'HEAD';
  const candidates = baseRef.startsWith('origin/')
    ? [baseRef, baseRef.slice('origin/'.length)]
    : [baseRef, `origin/${baseRef}`];
  let best = '';
  for (const ref of candidates) {
    const mb = await git(dir, ['merge-base', ref, 'HEAD']).then((s) => s.trim(), () => '');
    if (!mb || mb === best) continue;
    // keep whichever merge-base is the descendant (closest to the real fork)
    const newer = !best || (await git(dir, ['merge-base', '--is-ancestor', best, mb]).then(() => true, () => false));
    if (newer) best = mb;
  }
  return best || 'HEAD';
}

// ── Untracked line counting ────────────────────────────────────────────────
// Streamed with a hard size cap (never buffer whole files — an untracked
// 1.5GB sqlite dump used to be read fully into memory on every 10s poll) and
// cached by (mtime, size) so unchanged files are never re-read. A capped
// count is a LOWER BOUND and says so via `approx`.
const LINE_COUNT_CAP = 10 * 1024 * 1024; // count at most the first 10MB
const lineCache = new Map<string, { mtimeMs: number; size: number; lines: number; approx: boolean }>();

async function untrackedLines(abs: string): Promise<{ lines: number; approx: boolean }> {
  try {
    const st = await stat(abs);
    const hit = lineCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;

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
    const result = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      lines: binary || st.size === 0 ? 0 : lines + (lastByte !== 10 && read >= st.size ? 1 : 0),
      approx: !binary && st.size > LINE_COUNT_CAP,
    };
    if (lineCache.size > 10_000) lineCache.clear(); // ponytail: crude bound; LRU if it ever matters
    lineCache.set(abs, result);
    return result;
  } catch {
    return { lines: 0, approx: false };
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
 * --no-renames here (unlike changes()): a single pathspec can't carry a
 * rename pair, so the click-through for a renamed file shows it as all-added
 * — wrong-but-useful, and the tree's R status tells the real story.
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
    // realpath, not just the lexical check above: an untracked SYMLINK inside
    // the repo passes ls-files and the prefix check, but --no-index follows it
    // and would read any file on disk. Same containment readWorkingFile uses.
    const rootReal = await realpath(path.resolve(dir));
    const absReal = await realpath(abs);
    if (absReal !== rootReal && !absReal.startsWith(rootReal + path.sep)) return empty;
    try {
      return truncateDiff(await git(dir, ['diff', '--no-index', '--', '/dev/null', absReal]));
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

export const MAX_FILE_BYTES = 1_000_000;

/**
 * repo-relative path → absolute, or null if it escapes. Fails CLOSED
 * (hard-rule-7 spirit): relative path only, resolved result must stay under
 * realpath(dir) — symlinked files/dirs that escape are rejected, git cannot
 * be asked to answer for them. Shared with git-search's replace path, where
 * "fails closed" means a refused write rather than a refused read.
 */
export async function resolveContained(dir: string, relPath: string): Promise<string | null> {
  if (!relPath || path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) return null;
  let real: string;
  let rootReal: string;
  try {
    rootReal = await realpath(dir);
    real = await realpath(path.resolve(dir, relPath)); // ENOENT → catch → null
  } catch {
    return null;
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
  return real;
}

/** Working-tree file content for the panel's Full view. */
export async function readWorkingFile(
  dir: string,
  relPath: string,
): Promise<{ content: string; truncated: boolean; mtimeMs: number } | { binary: true } | null> {
  const real = await resolveContained(dir, relPath);
  if (!real) return null;
  const st = await stat(real).catch(() => null);
  if (!st?.isFile() || st.size > MAX_FILE_BYTES * 4) return null; // absurd size: don't even read
  const buf = await readFile(real).catch(() => null);
  if (!buf) return null;
  if (buf.subarray(0, 8192).includes(0)) return { binary: true };
  const text = buf.subarray(0, MAX_FILE_BYTES).toString('utf8');
  const lines = text.split('\n');
  // mtime goes out with the content so an edit can be refused if the file
  // moved under the editor (an agent writes these files while you read them).
  if (lines.length <= MAX_DIFF_LINES && buf.length <= MAX_FILE_BYTES)
    return { content: text, truncated: false, mtimeMs: st.mtimeMs };
  return { content: lines.slice(0, MAX_DIFF_LINES).join('\n'), truncated: true, mtimeMs: st.mtimeMs };
}

/**
 * Overwrite an existing working-tree file from the panel's editor.
 *
 * Data-loss path, so it fails closed on every count: the target must resolve
 * INSIDE the dir, must already exist as a regular file (this route never
 * creates — drag-and-drop does that), and its mtime must still match what the
 * editor loaded. An agent writing the same file mid-edit therefore loses
 * nothing: the save is refused and the user re-reads.
 */
export async function writeWorkingFile(
  dir: string,
  relPath: string,
  content: string,
  expectMtimeMs: number,
): Promise<{ mtimeMs: number } | { error: 'missing' | 'stale' }> {
  const real = await resolveContained(dir, relPath);
  if (!real) return { error: 'missing' };
  const st = await stat(real).catch(() => null);
  if (!st?.isFile()) return { error: 'missing' };
  // Whole-millisecond compare: some filesystems round the mtime they report
  // back, and a sub-ms delta is never a real concurrent write.
  if (Math.abs(st.mtimeMs - expectMtimeMs) >= 1) return { error: 'stale' };
  await writeFile(real, content, 'utf8');
  const after = await stat(real);
  return { mtimeMs: after.mtimeMs };
}

/**
 * One directory's entries, repo-relative, dirs suffixed with '/' (same shape
 * as the collapsed ignored entries in `tree`, so the client can merge them in
 * and keep expanding). Backs the panel's lazy expand of ignored dirs —
 * plain readdir, since git deliberately doesn't list inside them.
 */
export async function listDir(dir: string, relPath: string): Promise<string[] | null> {
  const real = await resolveContained(dir, relPath);
  if (!real) return null;
  const entries = await readdir(real, { withFileTypes: true }).catch(() => null);
  if (!entries) return null;
  const base = relPath.replace(/\/+$/, '');
  return entries
    .map((e) => `${base}/${e.name}${e.isDirectory() ? '/' : ''}`)
    .sort();
}

/**
 * Write a dropped file into `relDir` inside the target dir. The one write path
 * here, so it fails closed: the destination must resolve INSIDE the repo,
 * `name` is reduced to a basename (no traversal, no absolute), and an existing
 * file is never overwritten — a suffix is added instead. Returns the absolute
 * path written, or null if the destination is outside / not a directory.
 */
export async function saveUpload(
  dir: string,
  relDir: string,
  name: string,
  data: Buffer,
): Promise<{ path: string; relPath: string } | null> {
  const base = path.basename(name);
  if (!base || base === '.' || base === '..') return null;
  // Lexical containment first so a not-yet-existing destination (the terminal's
  // .seshmux/dropped/) can be created; realpath containment is re-checked after
  // the mkdir, which is what actually catches a symlink pointing outside.
  const root = path.resolve(dir);
  const lexical = path.resolve(root, relDir || '.');
  if (lexical !== root && !lexical.startsWith(root + path.sep)) return null;
  await mkdir(lexical, { recursive: true }).catch(() => {});
  const destDir = await resolveContained(dir, relDir || '.');
  if (!destDir) return null;
  const st = await stat(destDir).catch(() => null);
  if (!st?.isDirectory()) return null;

  // relPath is measured against the RESOLVED root: destDir came back through
  // realpath (/var → /private/var on macOS), and mixing the two forms produced
  // a "relative" path full of ../../.
  const rootReal = await realpath(root).catch(() => root);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let target = path.join(destDir, base);
  for (let n = 1; n < 1000; n++) {
    // wx: create-or-fail. The existence check IS the write — a plain
    // stat-then-write would race two simultaneous drops of the same name.
    const fh = await open(target, 'wx').catch(() => null);
    if (fh) {
      await fh.writeFile(data).finally(() => fh.close());
      return { path: target, relPath: path.relative(rootReal, target) };
    }
    target = path.join(destDir, `${stem}-${n}${ext}`);
  }
  return null;
}

// ── changes(): the chip + panel data ───────────────────────────────────────
// Coalesced: the statusbar chip, an open panel, and N grid tiles of the same
// project all poll the same (dir, base) — one in-flight computation plus a
// short TTL serves them all instead of N× the subprocess fan-out. Degraded
// (git-failed) results are evicted immediately so a transient index.lock
// collision is retried on the next poll instead of being served for 5s.
const changesMemo = new Map<string, { at: number; promise: Promise<GitChanges> }>();
const CHANGES_TTL_MS = 5000;

export function changes(dir: string, baseRef: string | null, wantTree: boolean): Promise<GitChanges> {
  const key = `${dir}\0${baseRef ?? ''}\0${wantTree}`;
  const hit = changesMemo.get(key);
  if (hit && Date.now() - hit.at < CHANGES_TTL_MS) return hit.promise;
  const promise = computeChanges(dir, baseRef, wantTree);
  if (changesMemo.size > 200) changesMemo.clear(); // ponytail: crude bound
  changesMemo.set(key, { at: Date.now(), promise });
  void promise.then((res) => {
    if (res.degraded && changesMemo.get(key)?.promise === promise) changesMemo.delete(key);
  });
  return promise;
}

async function computeChanges(dir: string, baseRef: string | null, wantTree: boolean): Promise<GitChanges> {
  try {
    const base = await resolveMergeBase(dir, baseRef);

    const [numstatOut, nameStatusOut, untrackedOut] = await Promise.all([
      git(dir, ['diff', '--numstat', '-z', base]),
      git(dir, ['diff', '--name-status', '-z', base]),
      git(dir, ['ls-files', '-o', '--exclude-standard', '-z']),
    ]);

    // name-status -z is a token stream: status, then one path — or two paths
    // for rename/copy records (R100/C75 score codes).
    const statusTokens = splitZ(nameStatusOut);
    const statusByPath = new Map<string, string>();
    for (let i = 0; i < statusTokens.length; ) {
      const code = statusTokens[i++]?.charAt(0);
      if (!code) continue;
      if (code === 'R' || code === 'C') {
        i++; // old path (delete side emitted from the numstat record below)
        const newPath = statusTokens[i++];
        if (newPath) statusByPath.set(newPath, code);
      } else {
        const p = statusTokens[i++];
        if (p) statusByPath.set(p, code);
      }
    }

    const files: FileChange[] = [];
    for (const f of parseNumstat(numstatOut)) {
      if (f.oldPath) {
        // Rename: new path carries the DETECTED counts (a pure `git mv` is
        // ~0, not the whole file); the old path shows as the delete it is.
        // Copy: the source still exists unchanged — no delete row.
        const code = statusByPath.get(f.path) ?? 'R';
        files.push({ path: f.path, added: f.added, removed: f.removed, status: code });
        if (code !== 'C') files.push({ path: f.oldPath, added: 0, removed: 0, status: 'D' });
      } else {
        files.push({ path: f.path, added: f.added, removed: f.removed, status: statusByPath.get(f.path) ?? 'M' });
      }
    }

    // Untracked counts in small batches: parallel enough to not serialize a
    // big list, bounded so 30k suddenly-untracked files can't exhaust fds.
    const untracked = splitZ(untrackedOut);
    for (let i = 0; i < untracked.length; i += 16) {
      const batch = await Promise.all(
        untracked.slice(i, i + 16).map(async (rel) => {
          const { lines, approx } = await untrackedLines(path.join(dir, rel));
          return { path: rel, added: lines, removed: 0, status: 'A', ...(approx ? { approx: true } : {}) };
        }),
      );
      files.push(...batch);
    }

    const result: GitChanges = {
      added: files.reduce((n, f) => n + f.added, 0),
      removed: files.reduce((n, f) => n + f.removed, 0),
      files,
    };
    if (wantTree) {
      // Ignored entries belong in the tree too — the panel is a file browser,
      // and .env / dist / build output are exactly what people want to open.
      // --directory collapses an ignored DIRECTORY into one `node_modules/`
      // entry (trailing slash = "not expanded, ask /api/git/dir"); without it
      // a monorepo would ship 100k paths in every tree payload.
      const [tracked, ignored] = await Promise.all([
        git(dir, ['ls-files', '-z']),
        git(dir, [
          'ls-files',
          '-o',
          '-i',
          '--exclude-standard',
          '--directory',
          '--no-empty-directory',
          '-z',
        ]).catch(() => ''),
      ]);
      result.tree = [...new Set([...splitZ(tracked), ...untracked, ...splitZ(ignored)])].sort();
      // Absolute root so the panel can hand a real path to a drag (the terminal
      // needs something the shell can resolve, not a repo-relative fragment).
      result.root = path.resolve(dir);
    }
    return result;
  } catch {
    return { added: 0, removed: 0, files: [], degraded: true };
  }
}

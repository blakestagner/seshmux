// Line-count diff for the statusbar +N/-N chip and the changes panel:
// everything not in the base branch — committed branch work, dirty tracked
// edits, and untracked files — measured against merge-base(base, HEAD).
// Read-only git throughout; every failure degrades to zeros (the bar shows
// nothing rather than erroring). Deliberately NOT part of workspaces.ts —
// that file is the destructive finish path and its guards fail closed;
// display data fails open.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { git } from './workspaces';

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  status: string; // git name-status letter (M/A/D/R…); untracked reported as 'A'
}

export interface GitChanges {
  added: number;
  removed: number;
  files: FileChange[];
  tree?: string[]; // full tracked file list + untracked, only when requested
}

// numstat line: `added\tremoved\tpath` — `-` for binary counts.
export function parseNumstat(out: string): { path: string; added: number; removed: number }[] {
  const rows: { path: string; added: number; removed: number }[] = [];
  for (const line of out.split('\n')) {
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

// Count an untracked file's lines as additions. Binary sniff on the first 8KB
// (NUL byte) → 0 lines but the file still appears in the list, mirroring how
// numstat reports binaries.
async function untrackedLines(abs: string): Promise<number> {
  try {
    const buf = await readFile(abs);
    if (buf.subarray(0, 8192).includes(0)) return 0;
    if (buf.length === 0) return 0;
    let lines = 0;
    for (const b of buf) if (b === 10) lines++;
    if (buf[buf.length - 1] !== 10) lines++; // no trailing newline
    return lines;
  } catch {
    return 0;
  }
}

/**
 * Unified diff for ONE file vs the merge-base (same base logic as changes()).
 * Untracked files diff against /dev/null so they render as all-added.
 *
 * `relPath` is a TRUST BOUNDARY: it arrives from a query param, and the
 * untracked branch below hands an absolute path to `git diff --no-index`,
 * which would happily read any file on disk. Resolve + prefix-check against
 * the repo dir and refuse anything that escapes. Failures return '' — this
 * is display data, not a guard.
 */
export async function fileDiff(dir: string, baseRef: string | null, relPath: string): Promise<string> {
  try {
    const abs = path.resolve(dir, relPath);
    if (!abs.startsWith(path.resolve(dir) + path.sep)) return '';

    let base = 'HEAD';
    if (baseRef) {
      try {
        base = (await git(dir, ['merge-base', baseRef, 'HEAD'])).trim() || 'HEAD';
      } catch {
        /* fall back to HEAD */
      }
    }
    const tracked = await git(dir, ['diff', base, '--', relPath]);
    if (tracked) return tracked;

    // Untracked? Only diff --no-index files git itself lists as untracked —
    // never an arbitrary path (see trust-boundary note above).
    const untracked = (await git(dir, ['ls-files', '-o', '--exclude-standard', '--', relPath])).trim();
    if (!untracked) return '';
    try {
      return await git(dir, ['diff', '--no-index', '--', '/dev/null', abs]);
    } catch (e) {
      // git diff --no-index exits 1 when files differ — that's the success path.
      const out = (e as { stdout?: string }).stdout;
      return typeof out === 'string' ? out : '';
    }
  } catch {
    return '';
  }
}

export async function changes(dir: string, baseRef: string | null, wantTree: boolean): Promise<GitChanges> {
  try {
    // merge-base failure (unknown ref, unborn HEAD, detached weirdness) →
    // diff against HEAD, i.e. uncommitted-only. Wrong-but-useful beats a 500.
    let base = 'HEAD';
    if (baseRef) {
      try {
        base = (await git(dir, ['merge-base', baseRef, 'HEAD'])).trim() || 'HEAD';
      } catch {
        /* fall back to HEAD */
      }
    }

    const [numstatOut, nameStatusOut, untrackedOut] = await Promise.all([
      git(dir, ['diff', '--numstat', base]),
      git(dir, ['diff', '--name-status', base]),
      git(dir, ['ls-files', '-o', '--exclude-standard']),
    ]);

    const statusByPath = new Map<string, string>();
    for (const line of nameStatusOut.split('\n')) {
      if (!line.trim()) continue;
      const [code, ...rest] = line.split('\t');
      // renames are `R100\told\tnew` — key by the new path
      if (rest.length) statusByPath.set(rest[rest.length - 1], code.charAt(0));
    }

    const files: FileChange[] = parseNumstat(numstatOut).map((f) => ({
      ...f,
      status: statusByPath.get(f.path) ?? 'M',
    }));

    const untracked = untrackedOut.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const rel of untracked) {
      files.push({ path: rel, added: await untrackedLines(path.join(dir, rel)), removed: 0, status: 'A' });
    }

    const result: GitChanges = {
      added: files.reduce((n, f) => n + f.added, 0),
      removed: files.reduce((n, f) => n + f.removed, 0),
      files,
    };
    if (wantTree) {
      const tracked = (await git(dir, ['ls-files'])).split('\n').map((l) => l.trim()).filter(Boolean);
      result.tree = [...new Set([...tracked, ...untracked])].sort();
    }
    return result;
  } catch {
    return { added: 0, removed: 0, files: [] };
  }
}

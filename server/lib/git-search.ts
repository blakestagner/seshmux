// Repo-wide text search + replace for the changes panel's VS Code-style
// search UI. `git grep` does the searching: it's already a hard dependency,
// it respects .gitignore, and its flags map 1:1 onto the UI's toggles
// (-i/case, -w/whole word, -E vs -F/regex, pathspecs/include+exclude).
//
// Search is read-only and fails open (an error becomes an empty result with
// a message). Replace WRITES, so it fails closed: every edit carries the line
// text the user saw, and a file whose line no longer matches is skipped, not
// guessed at. Path containment reuses git-stats' resolveContained.
//
// -z (NUL) output for the same reason git-stats uses it: core.quotepath
// octal-escapes non-ASCII paths in the default output and corrupts them.

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveContained, MAX_FILE_BYTES } from './git-stats';

const execFileP = promisify(execFile);

export interface SearchOpts {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string; // comma-separated globs
  exclude: string; // comma-separated globs
  includeIgnored: boolean;
}

export interface SearchMatch {
  line: number; // 1-based
  text: string; // the line, verbatim (CR kept for CRLF files)
}

export interface SearchFile {
  path: string;
  matches: SearchMatch[];
  truncated?: boolean; // per-file cap hit
}

export interface SearchResult {
  files: SearchFile[];
  total: number;
  truncated: boolean;
  error?: string;
}

const MAX_MATCHES = 2000;
const MAX_PER_FILE = 200;
const GREP_TIMEOUT_MS = 20_000;

/**
 * Comma-separated user globs → git pathspecs. VS Code semantics: a glob with
 * no slash matches at any depth (`*.ts` means `**​/*.ts`), and a bare name with
 * no wildcards is also treated as a directory (`docs` → its contents too).
 */
export function toPathspecs(csv: string, exclude: boolean): string[] {
  const prefix = exclude ? ':(exclude,glob)' : ':(glob)';
  const out: string[] = [];
  for (const raw of csv.split(',')) {
    const g = raw.trim();
    if (!g) continue;
    if (g.includes('/')) {
      out.push(prefix + g);
      continue;
    }
    out.push(prefix + '**/' + g);
    if (!/[*?[\]]/.test(g)) out.push(prefix + '**/' + g + '/**'); // bare name: also as a dir
  }
  return out;
}

/** git grep -z output: `path\0lineno\0text\n`, repeated. Scanned rather than
 *  line-split so a filename containing a newline can't shear a record. */
export function parseGrepZ(out: string): { path: string; line: number; text: string }[] {
  const rows: { path: string; line: number; text: string }[] = [];
  let i = 0;
  while (i < out.length) {
    const p1 = out.indexOf('\0', i);
    if (p1 < 0) break;
    const p2 = out.indexOf('\0', p1 + 1);
    if (p2 < 0) break;
    let end = out.indexOf('\n', p2 + 1);
    if (end < 0) end = out.length;
    const line = Number(out.slice(p1 + 1, p2));
    if (Number.isFinite(line)) rows.push({ path: out.slice(i, p1), line, text: out.slice(p2 + 1, end) });
    i = end + 1;
  }
  return rows;
}

// POSIX bracket expressions: valid in git grep -E, silently WRONG in JS
// (`[[:digit:]]` compiles as a character class of ':', 'd', 'i', 'g', 't').
const POSIX_CLASS_RE = /\[\[:[a-z]+:\]\]/;

/**
 * Why a regex query can't be served, or null if it can.
 *
 * Searching runs the pattern through `git grep -E` (POSIX ERE) while
 * highlighting and replacing run the SAME string through JS's RegExp. The two
 * dialects are not the same language, so a pattern accepted by one can behave
 * differently — or not compile at all — in the other. Left alone that shows up
 * as rows highlighted on the wrong span, and a replace that silently reports
 * "no match" for a result the user is looking at.
 *
 * Rather than translate between dialects, refuse anything the two don't agree
 * on and say why. JS is the stricter, more familiar of the two here, so the
 * effective contract is "JS regex syntax", which is also what the replace and
 * highlight paths can actually honour.
 */
export function regexDialectError(query: string): string | null {
  if (POSIX_CLASS_RE.test(query)) {
    return 'POSIX classes like [[:digit:]] are not supported — use \\d, \\w, or [a-z]';
  }
  try {
    new RegExp(query);
    return null;
  } catch (e) {
    return `invalid regex: ${(e as Error).message}`;
  }
}

export async function search(dir: string, opts: SearchOpts): Promise<SearchResult> {
  const empty: SearchResult = { files: [], total: 0, truncated: false };
  if (!opts.query) return empty;
  if (opts.regex) {
    // Checked BEFORE git runs: a pattern git would happily match but JS can't
    // reproduce must never reach the results list, or replace can't honour it.
    const bad = regexDialectError(opts.query);
    if (bad) return { ...empty, error: bad };
  }

  const args = ['grep', '-n', '-I', '-z', '--untracked'];
  if (opts.includeIgnored) args.push('--no-exclude-standard');
  if (!opts.caseSensitive) args.push('-i');
  if (opts.wholeWord) args.push('-w');
  args.push(opts.regex ? '-E' : '-F');
  args.push('-e', opts.query, '--', ...toPathspecs(opts.include, false), ...toPathspecs(opts.exclude, true));

  let stdout: string;
  try {
    ({ stdout } = await execFileP('git', args, {
      cwd: dir,
      maxBuffer: 64 * 1024 * 1024,
      timeout: GREP_TIMEOUT_MS,
    }));
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    if (err.code === 1) return empty; // no matches — not a failure
    // 128 = bad regex / bad pathspec. Surface it: a silent empty list reads as
    // "nothing here" when the truth is "your pattern didn't compile".
    return { ...empty, error: (err.stderr || 'search failed').trim().replace(/^fatal:\s*/, '') };
  }

  const byPath = new Map<string, SearchFile>();
  let total = 0;
  let truncated = false;
  for (const row of parseGrepZ(stdout)) {
    if (total >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    let file = byPath.get(row.path);
    if (!file) {
      file = { path: row.path, matches: [] };
      byPath.set(row.path, file);
    }
    if (file.matches.length >= MAX_PER_FILE) {
      file.truncated = true;
      truncated = true;
      continue;
    }
    file.matches.push({ line: row.line, text: row.text });
    total++;
  }
  return { files: [...byPath.values()], total, truncated };
}

// ── replace ────────────────────────────────────────────────────────────────

export interface ReplaceEdit {
  path: string;
  line: number; // 1-based
  expected: string; // the line text the user saw; mismatch ⇒ skip
  matchIndex?: number; // 0-based match on that line; omitted ⇒ every match on it
}

export interface ReplaceResult {
  changed: string[];
  skipped: { path: string; line: number; reason: string }[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The same matcher git grep used, rebuilt for JS. Throws on a bad pattern. */
export function buildPattern(opts: SearchOpts): RegExp {
  let src = opts.regex ? opts.query : escapeRe(opts.query);
  if (opts.wholeWord) src = `\\b(?:${src})\\b`;
  return new RegExp(src, opts.caseSensitive ? 'g' : 'gi');
}

/** Replace the nth match (or all) on one line. Returns null if nothing matched. */
export function replaceInLine(line: string, re: RegExp, replacement: string, matchIndex?: number): string | null {
  re.lastIndex = 0;
  if (matchIndex == null) {
    const next = line.replace(re, replacement);
    return next === line ? null : next;
  }
  const matches = [...line.matchAll(re)];
  const m = matches[matchIndex];
  if (!m) return null;
  // Expand $1/$& against THIS match only — String.replace on a sliced range
  // would re-scan and could hit a different occurrence.
  const expanded = replacement.replace(/\$(\$|&|\d{1,2})/g, (_, t: string) =>
    t === '$' ? '$' : t === '&' ? m[0] : (m[Number(t)] ?? ''),
  );
  return line.slice(0, m.index) + expanded + line.slice(m.index + m[0].length);
}

/**
 * Apply edits to the working tree. Fails CLOSED per edit: an unreadable,
 * binary, oversized, escaped, or stale-line target is skipped with a reason
 * rather than written through. Undo is git — nothing here is transactional.
 */
export async function replace(
  dir: string,
  edits: ReplaceEdit[],
  opts: SearchOpts & { replacement: string },
): Promise<ReplaceResult> {
  const changed: string[] = [];
  const skipped: ReplaceResult['skipped'] = [];
  // Fixed-string replacement is literal: $ must not become a backreference.
  const replacement = opts.regex ? opts.replacement : opts.replacement.replace(/\$/g, '$$$$');
  let re: RegExp;
  try {
    re = buildPattern(opts);
  } catch {
    return { changed, skipped: edits.map((e) => ({ path: e.path, line: e.line, reason: 'bad pattern' })) };
  }

  const byFile = new Map<string, ReplaceEdit[]>();
  for (const e of edits) {
    const list = byFile.get(e.path);
    if (list) list.push(e);
    else byFile.set(e.path, [e]);
  }

  for (const [relPath, fileEdits] of byFile) {
    const abs = await resolveContained(dir, relPath);
    const fail = (reason: string) => fileEdits.forEach((e) => skipped.push({ path: relPath, line: e.line, reason }));
    if (!abs) {
      fail('outside repo');
      continue;
    }
    const buf = await readFile(abs).catch(() => null);
    if (!buf) {
      fail('unreadable');
      continue;
    }
    if (buf.subarray(0, 8192).includes(0)) {
      fail('binary');
      continue;
    }
    if (buf.length > MAX_FILE_BYTES) {
      fail('too large');
      continue;
    }
    // Split on \n only: a CRLF file keeps its \r inside the line text, which
    // is exactly what git grep reported and what `expected` carries, so the
    // join below restores the file's original endings untouched.
    const lines = buf.toString('utf8').split('\n');
    let dirty = false;
    for (const e of fileEdits) {
      const idx = e.line - 1;
      if (lines[idx] !== e.expected) {
        skipped.push({ path: relPath, line: e.line, reason: 'stale' });
        continue;
      }
      const next = replaceInLine(lines[idx], re, replacement, e.matchIndex);
      if (next == null) {
        skipped.push({ path: relPath, line: e.line, reason: 'no match' });
        continue;
      }
      lines[idx] = next;
      dirty = true;
    }
    if (!dirty) continue;
    try {
      await writeFile(abs, lines.join('\n'));
      changed.push(relPath);
    } catch {
      fail('write failed');
    }
  }
  return { changed, skipped };
}

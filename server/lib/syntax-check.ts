// Syntax check for the Folder panel's editor — the red squiggles.
//
// SYNTAX ONLY, never type checking: the point is catching the brace you just
// deleted, not compiling the project. It also fails SILENT — an unparseable
// language, a missing checker, an internal API that moved — because a false
// red line on correct code is worse than no line at all.
//
// Deliberately zero new dependencies:
//   .json  → JSON.parse (stdlib)
//   .ts/.tsx/.js/.jsx/… → the typescript already installed IN THE USER'S REPO,
//     resolved from the project dir. Anyone with .ts files has it; anyone
//     without gets `checked: false` and no squiggles. Bundling ~1.5MB of
//     compiler into the published package to cover the rest is not worth it.

import { createRequire } from 'node:module';
import path from 'node:path';

export interface SyntaxError_ {
  line: number; // 1-based
  message: string;
}
export interface SyntaxResult {
  checked: boolean; // false = we have no checker for this file, not "it's clean"
  errors: SyntaxError_[];
}

const NOT_CHECKED: SyntaxResult = { checked: false, errors: [] };

const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** Line number (1-based) of a character offset. */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function checkJson(text: string): SyntaxResult {
  try {
    JSON.parse(text);
    return { checked: true, errors: [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid JSON';
    // Node's message carries either "position N" or "line L column C"
    // depending on version — read whichever is there, else point at line 1.
    const byLine = /line (\d+)/.exec(msg);
    const byPos = /position (\d+)/.exec(msg);
    const line = byLine ? Number(byLine[1]) : byPos ? lineOf(text, Number(byPos[1])) : 1;
    return { checked: true, errors: [{ line, message: msg }] };
  }
}

// The compiler is loaded from the PROJECT's node_modules, never ours, and is
// cached per project dir (resolution + module load is not cheap per keystroke).
const tsCache = new Map<string, unknown | null>();
function loadTs(dir: string): any | null {
  if (tsCache.has(dir)) return tsCache.get(dir);
  let ts: unknown | null = null;
  try {
    ts = createRequire(path.join(dir, 'noop.js'))('typescript');
  } catch {
    ts = null; // not a TS project — no squiggles, and that is fine
  }
  if (tsCache.size > 100) tsCache.clear(); // ponytail: crude bound
  // Never cache a MISS (same rule as repoFor in routes/git.ts): an `npm i`
  // mid-session would otherwise leave the editor squiggle-less until the
  // server restarted. A hit is cached; a miss is retried next pause.
  if (ts) tsCache.set(dir, ts);
  return ts;
}

function checkTs(dir: string, relPath: string, text: string): SyntaxResult {
  const ts = loadTs(dir);
  if (!ts) return NOT_CHECKED;
  try {
    const ext = path.extname(relPath).toLowerCase();
    const kind =
      ext === '.tsx'
        ? ts.ScriptKind.TSX
        : ext === '.jsx'
          ? ts.ScriptKind.JSX
          : ext === '.js' || ext === '.mjs' || ext === '.cjs'
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(path.basename(relPath), text, ts.ScriptTarget.Latest, false, kind);
    // parseDiagnostics is internal-but-stable; absent → report nothing rather
    // than guessing (fail silent, see the header).
    const diags: any[] = sf.parseDiagnostics ?? [];
    return {
      checked: true,
      errors: diags.slice(0, 50).map((d) => ({
        line: lineOf(text, d.start ?? 0),
        message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
      })),
    };
  } catch {
    return NOT_CHECKED;
  }
}

export function syntaxCheck(dir: string, relPath: string, text: string): SyntaxResult {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.json') return checkJson(text);
  if (TS_EXT.has(ext)) return checkTs(dir, relPath, text);
  return NOT_CHECKED;
}

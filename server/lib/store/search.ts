// Full-text session search. PROVIDER-AGNOSTIC (hard rule 3): caller passes `root` +
// `provider`; no store path or binary name lives here. Uses ripgrep when available for
// speed, else a streamed JS scan. Each hit is enriched with its session's project name
// and title by cross-referencing the scanner, so the UI gets ready-to-render rows.

import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { listSessions, scanProjects, type ProviderId } from './scan';

export interface SearchHit {
  project: string; // project name
  provider: ProviderId;
  sessionId: string;
  title: string;
  snippet: string;
  ts: number;
}

export interface SearchOpts {
  useRg?: boolean; // default: try rg, fall back to JS
  limit?: number; // per-store cap (default 200)
}

const DEFAULT_LIMIT = 200;

// One-line snippet around the first match, trimmed.
function makeSnippet(line: string, needleLower: string): string {
  const idx = line.toLowerCase().indexOf(needleLower);
  const from = Math.max(0, idx - 40);
  const raw = line.slice(from, from + 160).trim();
  return raw.length > 157 ? raw.slice(0, 157) + '…' : raw;
}

// Map sessionId -> { title, projectName, ts } for enrichment. Cheap: reuses the scanner's
// cached head reads.
async function sessionIndex(
  root: string,
  provider: ProviderId,
): Promise<Map<string, { title: string; project: string; ts: number }>> {
  const index = new Map<string, { title: string; project: string; ts: number }>();
  const projects = await scanProjects(root, provider);
  for (const p of projects) {
    const sessions = await listSessions(p.id, { root, provider });
    for (const s of sessions) {
      index.set(s.id, { title: s.title, project: p.name, ts: s.mtime });
    }
  }
  return index;
}

function rgAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('rg', ['--version'], { timeout: 2000 }, (err) => resolve(!err));
  });
}

// rg --json search across the store; returns raw {sessionId, line} matches.
function rgSearch(root: string, q: string, limit: number): Promise<{ sessionId: string; line: string }[]> {
  return new Promise((resolve) => {
    execFile(
      'rg',
      ['--json', '-i', '-m', '3', '--', q, root],
      { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        // rg exits 1 on "no matches" — not an error for us.
        if (err && (err as any).code !== 1) return resolve([]);
        const out: { sessionId: string; line: string }[] = [];
        for (const raw of stdout.split('\n')) {
          if (!raw) continue;
          let ev: any;
          try {
            ev = JSON.parse(raw);
          } catch {
            continue;
          }
          if (ev.type !== 'match') continue;
          const path: string = ev.data?.path?.text ?? '';
          const m = path.match(/([^/]+)\.jsonl$/);
          if (!m) continue;
          out.push({ sessionId: m[1], line: ev.data?.lines?.text ?? '' });
          if (out.length >= limit) break;
        }
        resolve(out);
      },
    );
  });
}

// Streamed JS scan fallback: read every jsonl line, substring-match (case-insensitive).
async function jsSearch(
  root: string,
  q: string,
  limit: number,
): Promise<{ sessionId: string; line: string }[]> {
  const needle = q.toLowerCase();
  const out: { sessionId: string; line: string }[] = [];
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }

  for (const dir of projectDirs) {
    const dirPath = join(root, dir);
    let files: string[];
    try {
      files = (await readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      const sessionId = file.replace(/\.jsonl$/, '');
      let matched = false;
      const rl = createInterface({
        input: createReadStream(join(dirPath, file), { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      try {
        for await (const line of rl) {
          if (line.toLowerCase().includes(needle)) {
            out.push({ sessionId, line });
            matched = true;
            break; // one hit per session is enough for the dropdown
          }
        }
      } finally {
        rl.close();
      }
      if (matched && out.length >= limit) return out;
    }
  }
  return out;
}

export async function searchStore(
  root: string,
  provider: ProviderId,
  q: string,
  opts: SearchOpts = {},
): Promise<SearchHit[]> {
  if (!q.trim()) return [];
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const useRg = opts.useRg ?? (await rgAvailable());

  const raw = useRg ? await rgSearch(root, q, limit) : await jsSearch(root, q, limit);
  if (raw.length === 0) return [];

  const index = await sessionIndex(root, provider);
  const needle = q.toLowerCase();
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  for (const r of raw) {
    if (seen.has(r.sessionId)) continue;
    const meta = index.get(r.sessionId);
    if (!meta) continue; // orphan file with no decodable project — skip
    seen.add(r.sessionId);
    hits.push({
      project: meta.project,
      provider,
      sessionId: r.sessionId,
      title: meta.title,
      snippet: makeSnippet(r.line, needle),
      ts: meta.ts,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

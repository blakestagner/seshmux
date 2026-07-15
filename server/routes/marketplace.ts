// GET /api/marketplace/{browse,item,sources} — community skill/agent browser
// (Phase 2). GitHub tree/raw URL construction lives entirely in this file.
// v1 is read-only: install itself is a client-side write against the
// existing customizations write endpoint, not added here.

import type { FastifyInstance } from 'fastify';
import { parseFrontmatter } from '../lib/providers/customizations';

export interface MarketplaceRouteOpts {
  fetchText?: (url: string) => Promise<string>;
  readSettings?: () => Promise<Record<string, unknown>>;
}

const SOURCE_RE = /^[\w.-]+\/[\w.-]+$/;
const DEFAULT_SOURCES = ['anthropics/skills'];
const MAX_CONTENT = 256 * 1024;
const MAX_FILES = 20;
const CACHE_TTL_MS = 15 * 60 * 1000;

interface TreeEntry {
  path: string;
  type: string;
}

interface MarketplaceItem {
  path: string;
  name: string;
  description: string;
  section: 'skills' | 'agents';
}

// Module-level, promise-cached: concurrent requests for the same URL share one
// in-flight fetch, and results are reused for CACHE_TTL_MS.
const cache = new Map<string, { at: number; value: Promise<string> }>();

function cachedFetch(url: string, fetchText: (url: string) => Promise<string>): Promise<string> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = fetchText(url).catch((err) => {
    cache.delete(url);
    throw err;
  });
  cache.set(url, { at: Date.now(), value });
  return value;
}

async function defaultFetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'seshmux' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  return res.text();
}

async function defaultReadSettings(): Promise<Record<string, unknown>> {
  const { readConfig } = await import('./config');
  const cfg = await readConfig();
  return cfg.settings;
}

function treeUrl(owner: string, repo: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
}
function rawUrl(owner: string, repo: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path}`;
}

function parseSource(source: unknown): [string, string] | null {
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) return null;
  const [owner, repo] = source.split('/');
  return [owner, repo];
}

async function loadTree(
  owner: string,
  repo: string,
  fetchText: (url: string) => Promise<string>,
): Promise<TreeEntry[]> {
  const raw = await cachedFetch(treeUrl(owner, repo), fetchText);
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.tree) ? parsed.tree : [];
}

async function describeFile(
  owner: string,
  repo: string,
  path: string,
  fetchText: (url: string) => Promise<string>,
): Promise<string> {
  try {
    const raw = await cachedFetch(rawUrl(owner, repo, path), fetchText);
    return parseFrontmatter(raw).attrs.description ?? '';
  } catch {
    return '';
  }
}

export default async function marketplaceRoutes(f: FastifyInstance, opts: MarketplaceRouteOpts = {}) {
  const fetchText = opts.fetchText ?? defaultFetchText;
  const readSettings = opts.readSettings ?? defaultReadSettings;

  f.get<{ Querystring: { source?: string } }>('/api/marketplace/browse', async (req, reply) => {
    const parsed = parseSource(req.query.source);
    if (!parsed) return reply.code(400).send({ error: 'bad source' });
    const [owner, repo] = parsed;

    let tree: TreeEntry[];
    try {
      tree = await loadTree(owner, repo, fetchText);
    } catch {
      return reply.code(502).send({ error: 'fetch failed' });
    }

    const items: MarketplaceItem[] = [];
    for (const entry of tree) {
      if (entry.type !== 'blob') continue;

      const skillMatch = /^(.+)\/SKILL\.md$/.exec(entry.path);
      if (skillMatch) {
        const dir = skillMatch[1];
        items.push({
          path: dir,
          name: dir.split('/').pop()!,
          section: 'skills',
          description: await describeFile(owner, repo, entry.path, fetchText),
        });
        continue;
      }

      const agentMatch = /^agents\/([^/]+)\.md$/.exec(entry.path);
      if (agentMatch) {
        items.push({
          path: entry.path,
          name: agentMatch[1],
          section: 'agents',
          description: await describeFile(owner, repo, entry.path, fetchText),
        });
      }
    }
    return { items };
  });

  f.get<{ Querystring: { source?: string; path?: string } }>('/api/marketplace/item', async (req, reply) => {
    const parsed = parseSource(req.query.source);
    if (!parsed) return reply.code(400).send({ error: 'bad source' });
    const [owner, repo] = parsed;
    const dirPath = req.query.path;
    if (typeof dirPath !== 'string' || !dirPath) return reply.code(400).send({ error: 'bad path' });

    let tree: TreeEntry[];
    try {
      tree = await loadTree(owner, repo, fetchText);
    } catch {
      return reply.code(502).send({ error: 'fetch failed' });
    }

    const matches = tree.filter(
      (e) => e.type === 'blob' && (e.path === dirPath || e.path.startsWith(`${dirPath}/`)),
    );
    if (matches.length > MAX_FILES) return reply.code(400).send({ error: 'too many files' });

    const files: { path: string; content: string }[] = [];
    try {
      for (const entry of matches) {
        const content = await cachedFetch(rawUrl(owner, repo, entry.path), fetchText);
        if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT) {
          return reply.code(400).send({ error: 'file too large' });
        }
        files.push({ path: entry.path, content });
      }
    } catch {
      return reply.code(502).send({ error: 'fetch failed' });
    }
    return { files };
  });

  f.get('/api/marketplace/sources', async () => {
    const settings = await readSettings();
    const extra = Array.isArray(settings.marketplaceSources)
      ? settings.marketplaceSources.filter((s): s is string => typeof s === 'string')
      : [];
    return { sources: [...new Set([...DEFAULT_SOURCES, ...extra])] };
  });
}

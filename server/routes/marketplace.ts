// GET /api/marketplace/{browse,item,sources} — community skill/agent browser
// (Phase 2). GitHub tree/raw URL construction lives entirely in this file.
// v1 is read-only: install itself is a client-side write against the
// existing customizations write endpoint, not added here.

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { parseFrontmatter } from '../lib/providers/customizations';
import type { AgentProvider } from '../lib/providers/types';
import { getProviders } from '../lib/providers/types';
import { scannedResolveRepo } from './customizations';
import { writeWithinRepo, FsGuardError } from '../lib/fs-guard';

export interface MarketplaceRouteOpts {
  fetchText?: (url: string) => Promise<string>;
  readSettings?: () => Promise<Record<string, unknown>>;
  resolveRepo?: (projectId: string) => Promise<string | null>;
  listProviders?: () => Promise<AgentProvider[]>;
  runArgv?: (argv: string[], cwd: string) => Promise<{ text: string; ok: boolean }>;
}

// Mirrors server/routes/customizations.ts:defaultRunHeadless — execFile, never a shell
// string, stdin closed so an interactive prompt can't hang the child.
function defaultRunArgv(argv: string[], cwd: string): Promise<{ text: string; ok: boolean }> {
  const [bin, ...rest] = argv;
  return new Promise((resolve) => {
    const child = execFile(
      bin, rest,
      { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve({ text: (stdout || '').trim(), ok: !err }),
    );
    child.stdin?.end();
  });
}

const SOURCE_RE = /^[\w.-]+\/[\w.-]+$/;
const DEFAULT_SOURCES = ['anthropics/skills'];
const MAX_CONTENT = 256 * 1024;
const MAX_FILES = 20;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

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
  if (hit) {
    if (Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    cache.delete(url); // expired: evict on read, don't serve stale
  }
  const value = fetchText(url).catch((err) => {
    cache.delete(url);
    throw err;
  });
  // ponytail: FIFO eviction via Map insertion order, not true LRU; upgrade if
  // hit-rate under real traffic ever matters.
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
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

const INSTALL_NAME_RE = /^[a-z0-9-]{1,64}$/;

// Reject any tree-provided relative path that could escape the skill dir once
// joined onto it. writeWithinRepo still fails closed on an actual escape, this
// is a cheap pre-check so we never even attempt a write for an obviously bad path.
function isSafeRelPath(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('\0') || rel.includes('\\')) return false;
  return rel.split('/').every((part) => part !== '' && part !== '..');
}

// Stamp `source: owner/repo` into a SKILL.md's frontmatter, appended before the
// closing `---`, so an installed skill records where it came from. No-op if the
// file has no (or an unterminated) frontmatter block.
function stampSource(content: string, source: string): string {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return content;
  return `${content.slice(0, end)}\nsource: ${source}${content.slice(end)}`;
}

const PLUGIN_NAME_RE = /^[A-Za-z0-9@/._-]{1,128}$/;

export default async function marketplaceRoutes(f: FastifyInstance, opts: MarketplaceRouteOpts = {}) {
  const fetchText = opts.fetchText ?? defaultFetchText;
  const readSettings = opts.readSettings ?? defaultReadSettings;
  const resolveRepo = opts.resolveRepo ?? scannedResolveRepo;
  const listProviders = opts.listProviders ?? getProviders;
  const runArgv = opts.runArgv ?? defaultRunArgv;

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
      // Containment relies on `entry.path` coming from the GitHub tree response
      // (loadTree), never from the client-supplied `path` query string directly.
      // If this ever gets refactored to fetch a client-controlled path instead,
      // that reopens SSRF against the raw.githubusercontent.com fetch below.
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

  f.post<{
    Body: { projectId?: string; source?: string; path?: string; section?: 'skills' | 'agents'; name?: string };
  }>('/api/marketplace/install', async (req, reply) => {
    const { projectId, source, path: dirPath, section, name } = req.body ?? {};
    if (section !== 'skills' && section !== 'agents') return reply.code(400).send({ error: 'bad section' });
    if (typeof name !== 'string' || !INSTALL_NAME_RE.test(name)) return reply.code(400).send({ error: 'bad name' });
    const parsed = parseSource(source);
    if (!parsed) return reply.code(400).send({ error: 'bad source' });
    const [owner, repo] = parsed;
    if (typeof dirPath !== 'string' || !dirPath) return reply.code(400).send({ error: 'bad path' });

    const repoPath = projectId ? await resolveRepo(projectId) : null;
    if (!repoPath) return reply.code(404).send({ error: 'unknown project' });

    const providers = await listProviders();
    const provider = providers.find((p) => p.customizationWriteTarget);
    if (!provider?.customizationWriteTarget)
      return reply.code(400).send({ error: 'provider does not support authoring' });

    // Re-fetch the item's files ourselves (never trust client-supplied contents).
    let tree: TreeEntry[];
    try {
      tree = await loadTree(owner, repo, fetchText);
    } catch {
      return reply.code(502).send({ error: 'fetch failed' });
    }

    const matches = tree.filter(
      (e) => e.type === 'blob' && (e.path === dirPath || e.path.startsWith(`${dirPath}/`)),
    );
    if (matches.length === 0) return reply.code(404).send({ error: 'not found' });
    if (matches.length > MAX_FILES) return reply.code(400).send({ error: 'too many files' });
    if (section === 'agents' && matches.length !== 1)
      return reply.code(400).send({ error: 'agent path must match exactly one file' });

    // Belt over the guard's suspenders: reject any relative path that could
    // escape the skill dir, before we fetch or write anything.
    const relPaths: string[] = [];
    for (const entry of matches) {
      const rel = entry.path === dirPath ? basename(entry.path) : entry.path.slice(dirPath.length + 1);
      if (!isSafeRelPath(rel)) return reply.code(400).send({ error: 'unsafe file path' });
      relPaths.push(rel);
    }

    // Fetch every file's content before writing anything, so a mid-set fetch
    // failure leaves the filesystem untouched.
    const sourceLabel = `${owner}/${repo}`;
    const staged: { relPath: string; content: string }[] = [];
    try {
      for (let i = 0; i < matches.length; i++) {
        const entry = matches[i];
        let content = await cachedFetch(rawUrl(owner, repo, entry.path), fetchText);
        if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT) {
          return reply.code(400).send({ error: 'file too large' });
        }
        if (basename(entry.path) === 'SKILL.md') content = stampSource(content, sourceLabel);
        staged.push({ relPath: relPaths[i], content });
      }
    } catch {
      return reply.code(502).send({ error: 'fetch failed' });
    }

    try {
      if (section === 'agents') {
        const target = provider.customizationWriteTarget({ kind: 'project', repoPath }, 'agents', name);
        await writeWithinRepo(repoPath, target, staged[0].content);
        return { ok: true, filePaths: [target] };
      }

      // Multi-file skill install: stage every file under a temp sibling dir,
      // then rename it into place in one shot so a write-time failure partway
      // through a multi-file skill leaves nothing behind.
      const skillTarget = provider.customizationWriteTarget({ kind: 'project', repoPath }, 'skills', name);
      const skillDir = dirname(skillTarget);
      const tmpDir = `${skillDir}.install-tmp-${randomBytes(6).toString('hex')}`;
      try {
        for (const { relPath, content } of staged) {
          await writeWithinRepo(repoPath, join(tmpDir, relPath), content);
        }
        // ponytail: reinstalling over an existing skill dir can fail (ENOTEMPTY)
        // since rename won't clobber a non-empty dir; add remove-then-rename if
        // reinstall/upgrade becomes a real flow.
        await rename(tmpDir, skillDir);
      } catch (err) {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      const filePaths = staged.map(({ relPath }) => join(skillDir, relPath));
      return { ok: true, filePaths };
    } catch (err) {
      const message = err instanceof FsGuardError ? err.message : 'write failed';
      return reply.code(400).send({ error: message });
    }
  });

  // Probe endpoint, not a normal CRUD read: any failure along the way (unknown project,
  // spawn error, non-JSON output, no provider with pluginCommands) resolves to
  // `{ supported: false }` with a 200, never an error status — the client uses this to
  // decide whether to show the plugin marketplace UI at all.
  f.get<{ Querystring: { projectId?: string } }>('/api/marketplace/plugins', async (req) => {
    const { projectId } = req.query;
    const repoPath = projectId ? await resolveRepo(projectId) : null;
    const cwd = repoPath ?? process.cwd();

    const provider = (await listProviders()).find((p) => p.pluginCommands);
    if (!provider?.pluginCommands) return { supported: false };

    try {
      const [avail, mkts] = await Promise.all([
        runArgv(provider.pluginCommands.listAvailable(), cwd),
        runArgv(provider.pluginCommands.listMarketplaces(), cwd),
      ]);
      if (!avail.ok || !mkts.ok) return { supported: false };

      const availParsed = JSON.parse(avail.text);
      const mktsParsed = JSON.parse(mkts.text);
      const plugins = Array.isArray(availParsed?.available) ? availParsed.available : null;
      const marketplaces = Array.isArray(mktsParsed) ? mktsParsed : null;
      if (!plugins || !marketplaces) return { supported: false };
      const installed = Array.isArray(availParsed?.installed) ? availParsed.installed : [];

      // `--available` is genuinely "available to install" — the CLI excludes
      // anything already installed, so an installed plugin otherwise has no
      // row in `plugins` at all and the UI's installed-chip match never has
      // a target to match against. Synthesize a row from `installed[].id`
      // ("name@marketplace") for any installed plugin missing from `plugins`.
      const presentIds = new Set(
        plugins.filter((p: { pluginId?: unknown }) => typeof p?.pluginId === 'string').map((p: { pluginId: string }) => p.pluginId),
      );
      for (const entry of installed) {
        const id = entry?.id;
        if (typeof id !== 'string' || presentIds.has(id)) continue;
        const [name, marketplaceName] = id.split('@');
        plugins.push({ pluginId: id, name: name || id, marketplaceName });
        presentIds.add(id);
      }

      return { supported: true, plugins, marketplaces, installed };
    } catch {
      return { supported: false };
    }
  });

  f.post<{ Body: { projectId?: string; plugin?: string; scope?: string } }>(
    '/api/marketplace/plugins/install',
    async (req, reply) => {
      const { projectId, plugin, scope } = req.body ?? {};
      if (typeof plugin !== 'string' || !PLUGIN_NAME_RE.test(plugin))
        return reply.code(400).send({ error: 'bad plugin' });
      if (scope !== 'user' && scope !== 'project') return reply.code(400).send({ error: 'bad scope' });

      const repoPath = projectId ? await resolveRepo(projectId) : null;
      if (!repoPath) return reply.code(404).send({ error: 'unknown project' });

      const provider = (await listProviders()).find((p) => p.pluginCommands);
      if (!provider?.pluginCommands) return reply.code(400).send({ error: 'provider does not support plugins' });

      const { text, ok } = await runArgv(provider.pluginCommands.install(plugin, scope), repoPath);
      if (!ok) return reply.code(502).send({ error: text || 'install failed' });
      return { ok: true, output: text };
    },
  );

  f.get('/api/marketplace/sources', async () => {
    const settings = await readSettings();
    const extra = Array.isArray(settings.marketplaceSources)
      ? settings.marketplaceSources.filter((s): s is string => typeof s === 'string')
      : [];
    return { sources: [...new Set([...DEFAULT_SOURCES, ...extra])] };
  });
}

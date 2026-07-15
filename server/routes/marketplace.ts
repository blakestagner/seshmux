// Marketplace routes (Phase 2): community browse/item/sources + guarded
// install (server re-fetches and writes via fs-guard), and the claude
// plugin-marketplace probe/list/install (argv from provider.pluginCommands,
// hard rule 3). GitHub tree/raw URL construction lives entirely in this file.

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, realpath } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { parseFrontmatter } from '../lib/providers/customizations';
import type { AgentProvider } from '../lib/providers/types';
import { getProviders } from '../lib/providers/types';
import { scannedResolveRepo } from './customizations';
import { writeWithinRepo, FsGuardError } from '../lib/fs-guard';
import { execCapture } from '../lib/exec-capture';

export interface MarketplaceRouteOpts {
  fetchText?: (url: string) => Promise<string>;
  readSettings?: () => Promise<Record<string, unknown>>;
  resolveRepo?: (projectId: string) => Promise<string | null>;
  listProviders?: () => Promise<AgentProvider[]>;
  runArgv?: (argv: string[], cwd: string) => Promise<{ text: string; ok: boolean; stderr?: string }>;
}

// Thin wrapper over the shared execCapture (see server/lib/exec-capture.ts).
function defaultRunArgv(argv: string[], cwd: string): Promise<{ text: string; ok: boolean; stderr: string }> {
  const [bin, ...rest] = argv;
  return execCapture(bin, rest, { cwd, timeoutMs: 60_000, maxBuffer: 4 * 1024 * 1024 });
}

const SOURCE_RE = /^[\w.-]+\/[\w.-]+$/;
// claude-plugins-official carries 29 more Anthropic SKILL.md skills nested
// inside its plugins/ dirs — the generic */SKILL.md matcher finds them.
const DEFAULT_SOURCES = ['anthropics/skills', 'anthropics/claude-plugins-official'];
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
    if (Date.now() - hit.at < CACHE_TTL_MS) {
      // LRU: re-insert so Map insertion order tracks recency, not first-fetch.
      cache.delete(url);
      cache.set(url, hit);
      return hit.value;
    }
    cache.delete(url); // expired: evict on read, don't serve stale
  }
  const value = fetchText(url).catch((err) => {
    cache.delete(url);
    throw err;
  });
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

const SHA_RE = /^[0-9a-f]{40}$/i;

function commitsHeadUrl(owner: string, repo: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/commits/HEAD`;
}

// Resolve the source's HEAD commit sha once (browse time), so browse → preview
// → install all pin to the same immutable content (closes the preview/install
// TOCTOU where a repo push between preview and install could change bytes).
async function resolveHeadSha(
  owner: string,
  repo: string,
  fetchText: (url: string) => Promise<string>,
): Promise<string> {
  const raw = await cachedFetch(commitsHeadUrl(owner, repo), fetchText);
  const sha = (JSON.parse(raw) as { sha?: string }).sha;
  if (!sha || !SHA_RE.test(sha)) throw new Error('bad HEAD sha from github');
  return sha;
}

function treeUrl(owner: string, repo: string, sha: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`;
}
function rawUrl(owner: string, repo: string, sha: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`;
}

function parseSource(source: unknown): [string, string] | null {
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) return null;
  const [owner, repo] = source.split('/');
  return [owner, repo];
}

async function loadTree(
  owner: string,
  repo: string,
  sha: string,
  fetchText: (url: string) => Promise<string>,
): Promise<TreeEntry[]> {
  const raw = await cachedFetch(treeUrl(owner, repo, sha), fetchText);
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.tree) ? parsed.tree : [];
}

async function describeFile(
  owner: string,
  repo: string,
  sha: string,
  path: string,
  fetchText: (url: string) => Promise<string>,
): Promise<string> {
  try {
    const raw = await cachedFetch(rawUrl(owner, repo, sha, path), fetchText);
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

// Stamp `source: owner/repo` + `sourceSha: <sha>` into a SKILL.md's frontmatter,
// appended before the closing `---`, so an installed skill records where it came
// from AND the exact pinned commit (answers "what exactly did I install" later).
// No-op if the file has no (or an unterminated) frontmatter block.
function stampSource(content: string, source: string, sha: string): string {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return content;
  return `${content.slice(0, end)}\nsource: ${source}\nsourceSha: ${sha}${content.slice(end)}`;
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

    let sha: string;
    try {
      sha = await resolveHeadSha(owner, repo, fetchText);
    } catch {
      return reply.code(502).send({ error: 'fetch failed' });
    }

    let tree: TreeEntry[];
    try {
      tree = await loadTree(owner, repo, sha, fetchText);
    } catch {
      return reply.code(502).send({ error: 'fetch failed' });
    }

    // Matched first (order preserved), then every describeFile fetch runs
    // concurrently — cachedFetch is promise-keyed so concurrent requests for
    // the same URL just share one in-flight fetch.
    type Matched = { path: string; name: string; section: 'skills' | 'agents' };
    const matched: Matched[] = [];
    for (const entry of tree) {
      if (entry.type !== 'blob') continue;

      const skillMatch = /^(.+)\/SKILL\.md$/.exec(entry.path);
      if (skillMatch) {
        const parts = skillMatch[1].split('/');
        const leaf = parts[parts.length - 1];
        // Plugin-nested skills (plugins/<plugin>/skills/<leaf>/) reuse generic
        // leaf names ("access", "configure") across plugins — prefix with the
        // plugin dir so rows are distinguishable AND the install target dir
        // stays unique. Top-level skills keep their plain name.
        const name =
          parts.length >= 3 && parts[parts.length - 2] === 'skills' ? `${parts[parts.length - 3]}-${leaf}` : leaf;
        matched.push({ path: entry.path, name, section: 'skills' });
        continue;
      }

      // Top-level agents/<name>.md AND plugin-nested <plugin>/agents/<name>.md
      // (claude-plugins-official nests 27 agents inside plugins/). Nested ones
      // get the same plugin-dir prefix as nested skills.
      const agentMatch = /^(?:(.+)\/)?agents\/([^/]+)\.md$/.exec(entry.path);
      if (agentMatch) {
        const plugin = agentMatch[1]?.split('/').pop();
        const name = plugin ? `${plugin}-${agentMatch[2]}` : agentMatch[2];
        matched.push({ path: entry.path, name, section: 'agents' });
      }
    }
    const items: MarketplaceItem[] = await Promise.all(
      matched.map(async (m) => ({
        path: m.section === 'skills' ? m.path.replace(/\/SKILL\.md$/, '') : m.path,
        name: m.name,
        section: m.section,
        description: await describeFile(owner, repo, sha, m.path, fetchText),
      })),
    );
    return { items, sha, curated: DEFAULT_SOURCES.includes(`${owner}/${repo}`) };
  });

  f.get<{ Querystring: { source?: string; path?: string; sha?: string } }>('/api/marketplace/item', async (req, reply) => {
    const parsed = parseSource(req.query.source);
    if (!parsed) return reply.code(400).send({ error: 'bad source' });
    const [owner, repo] = parsed;
    const dirPath = req.query.path;
    if (typeof dirPath !== 'string' || !dirPath) return reply.code(400).send({ error: 'bad path' });
    const sha = req.query.sha;
    if (!sha || !SHA_RE.test(sha)) return reply.code(400).send({ error: 'bad sha' });

    let tree: TreeEntry[];
    try {
      tree = await loadTree(owner, repo, sha, fetchText);
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
        const content = await cachedFetch(rawUrl(owner, repo, sha, entry.path), fetchText);
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
    Body: {
      projectId?: string;
      source?: string;
      path?: string;
      section?: 'skills' | 'agents';
      name?: string;
      target?: 'project' | 'user';
      sha?: string;
    };
  }>('/api/marketplace/install', async (req, reply) => {
    const { projectId, source, path: dirPath, section, name, target = 'project', sha } = req.body ?? {};
    if (section !== 'skills' && section !== 'agents') return reply.code(400).send({ error: 'bad section' });
    if (typeof name !== 'string' || !INSTALL_NAME_RE.test(name)) return reply.code(400).send({ error: 'bad name' });
    const parsed = parseSource(source);
    if (!parsed) return reply.code(400).send({ error: 'bad source' });
    const [owner, repo] = parsed;
    if (typeof dirPath !== 'string' || !dirPath) return reply.code(400).send({ error: 'bad path' });
    if (!sha || !SHA_RE.test(sha)) return reply.code(400).send({ error: 'bad sha' });

    // target 'user' is cwd/project-independent (global modal has no projectId);
    // target 'project' (default) keeps the existing 404-on-unknown-project gate.
    let repoPath: string | null = null;
    if (target === 'user') {
      // no-op: containRoot is derived below from the provider seam's own output.
    } else {
      repoPath = projectId ? await resolveRepo(projectId) : null;
      if (!repoPath) return reply.code(404).send({ error: 'unknown project' });
    }

    const providers = await listProviders();
    const provider = providers.find((p) => p.customizationWriteTarget);
    if (!provider?.customizationWriteTarget)
      return reply.code(400).send({ error: 'provider does not support authoring' });

    // Re-fetch the item's files ourselves (never trust client-supplied contents).
    let tree: TreeEntry[];
    try {
      tree = await loadTree(owner, repo, sha, fetchText);
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
        let content = await cachedFetch(rawUrl(owner, repo, sha, entry.path), fetchText);
        if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT) {
          return reply.code(400).send({ error: 'file too large' });
        }
        if (basename(entry.path) === 'SKILL.md') content = stampSource(content, sourceLabel, sha);
        staged.push({ relPath: relPaths[i], content });
      }
    } catch {
      return reply.code(502).send({ error: 'fetch failed' });
    }

    const scope = target === 'user' ? ({ kind: 'global' } as const) : ({ kind: 'project', repoPath: repoPath! } as const);

    try {
      if (section === 'agents') {
        const agentTarget = provider.customizationWriteTarget(scope, 'agents', name);
        // Containment root: project installs stay rooted at the repo (unchanged);
        // user installs derive their root from the seam's own output (hard rule
        // 3 — this route never hardcodes ~/.claude) — the agents dir itself.
        const containRoot = target === 'user' ? dirname(agentTarget) : repoPath!;
        // writeWithinRepo realpath()s the containment root — it must already
        // exist. repoPath (project) is guaranteed to; a fresh user's
        // ~/.claude/agents may not be (first-ever global install), so create it.
        if (target === 'user') await mkdir(containRoot, { recursive: true });
        await writeWithinRepo(containRoot, agentTarget, staged[0].content);
        return { ok: true, filePaths: [agentTarget] };
      }

      // Multi-file skill install: stage every file under a temp sibling dir,
      // then rename it into place in one shot so a write-time failure partway
      // through a multi-file skill leaves nothing behind.
      const skillTarget = provider.customizationWriteTarget(scope, 'skills', name);
      const skillDir = dirname(skillTarget);
      // User installs: containment root is the global skills root (parent of
      // skillDir), so the temp sibling `<skillDir>.install-tmp-*` still lands
      // inside it. Project installs: unchanged, rooted at the repo.
      const containRoot = target === 'user' ? dirname(skillDir) : repoPath!;
      // Same first-install existence gap as the agents branch above.
      if (target === 'user') await mkdir(containRoot, { recursive: true });
      const tmpDir = `${skillDir}.install-tmp-${randomBytes(6).toString('hex')}`;
      try {
        for (const { relPath, content } of staged) {
          await writeWithinRepo(containRoot, join(tmpDir, relPath), content);
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

  // The CLI reports project-scope installs from EVERY project on disk regardless of
  // cwd, so `installed[]` is unscoped by default. Drop any project-scope entry whose
  // projectPath doesn't realpath-match the requested project — user-scope entries are
  // cwd-independent and always kept. No resolved project (global modal, or an
  // unresolvable projectId) means no project-scope entry can match, so all are dropped.
  // `any[]` matches the untyped-JSON.parse convention already used for availParsed/plugins above.
  async function filterInstalledForProject(installed: any[], repoPath: string | null): Promise<any[]> {
    let repoReal: string | null = null;
    if (repoPath) {
      try {
        repoReal = await realpath(repoPath);
      } catch {
        repoReal = null;
      }
    }
    const out: any[] = [];
    for (const entry of installed) {
      if (entry?.scope !== 'project') {
        out.push(entry);
        continue;
      }
      if (!repoReal) continue;
      if (typeof entry?.projectPath !== 'string') continue;
      try {
        if ((await realpath(entry.projectPath)) === repoReal) out.push(entry);
      } catch {
        // dangling/unreadable projectPath -> drop, fail closed
      }
    }
    return out;
  }

  // Probe endpoint, not a normal CRUD read: any failure along the way (unknown project,
  // spawn error, non-JSON output, no provider with pluginCommands) resolves to
  // `{ supported: false }` with a 200, never an error status — the client uses this to
  // decide whether to show the plugin marketplace UI at all.
  f.get<{ Querystring: { projectId?: string } }>('/api/marketplace/plugins', async (req) => {
    const { projectId } = req.query;
    // cwd fallback to process.cwd() only applies to the no-projectId (global) case —
    // a projectId that's given but doesn't resolve is a stale/unknown project, not
    // "run from the server's own cwd", or the CLI phantom-lists that project's plugins.
    let repoPath: string | null = null;
    if (projectId) {
      repoPath = await resolveRepo(projectId);
      if (!repoPath) return { supported: false };
    }
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
      const rawInstalled = Array.isArray(availParsed?.installed) ? availParsed.installed : [];
      const installed = await filterInstalledForProject(rawInstalled, repoPath);

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

  // install/uninstall are otherwise-identical: same body shape, same scope
  // gate, same provider lookup, differing only in which pluginCommands verb
  // runs and the fallback error text. Shared as one handler factory.
  function pluginAction(cmd: 'install' | 'uninstall') {
    return async (
      req: { body?: { projectId?: string; plugin?: string; scope?: string } },
      reply: import('fastify').FastifyReply,
    ) => {
      const { projectId, plugin, scope } = req.body ?? {};
      if (typeof plugin !== 'string' || !PLUGIN_NAME_RE.test(plugin))
        return reply.code(400).send({ error: 'bad plugin' });
      if (scope !== 'user' && scope !== 'project') return reply.code(400).send({ error: 'bad scope' });

      // Project-scope installs/uninstalls need a real project (the CLI writes
      // into its .claude); user-scope is cwd-independent, so the global modal
      // (no project) may run them from the server's own cwd.
      const repoPath = projectId ? await resolveRepo(projectId) : null;
      if (!repoPath && scope === 'project') return reply.code(404).send({ error: 'unknown project' });

      const provider = (await listProviders()).find((p) => p.pluginCommands);
      if (!provider?.pluginCommands) return reply.code(400).send({ error: 'provider does not support plugins' });

      const { text, ok, stderr } = await runArgv(provider.pluginCommands[cmd](plugin, scope), repoPath ?? process.cwd());
      // CLI errors land on stderr; surface it (bounded to the last 500 chars)
      // instead of a generic message when stdout is empty.
      if (!ok) return reply.code(502).send({ error: (stderr || text || '').trim().slice(-500) || `${cmd} failed` });
      return { ok: true, output: text };
    };
  }

  f.post<{ Body: { projectId?: string; plugin?: string; scope?: string } }>(
    '/api/marketplace/plugins/install',
    pluginAction('install'),
  );

  f.post<{ Body: { projectId?: string; plugin?: string; scope?: string } }>(
    '/api/marketplace/plugins/uninstall',
    pluginAction('uninstall'),
  );

  f.get('/api/marketplace/sources', async () => {
    const settings = await readSettings();
    const extra = Array.isArray(settings.marketplaceSources)
      ? settings.marketplaceSources.filter((s): s is string => typeof s === 'string')
      : [];
    const sources = [...new Set([...DEFAULT_SOURCES, ...extra])].map((source) => ({
      source,
      curated: DEFAULT_SOURCES.includes(source),
    }));
    return { sources };
  });
}

// GET/PUT /api/scratchpad/:projectId → <repo>/.seshmux/handoff.md — the shared per-repo
// scratchpad both agents read/write (the filesystem is the message bus). Create-with-template
// on first write, atomic write. TRAVERSAL SAFETY: the resolved repo must be an existing
// directory; a projectId that decodes outside a real dir is refused (404), never written.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { decodeProjectDir } from '../lib/store/scan';
import { getProviders } from '../lib/providers/types';

export interface ScratchpadDeps {
  // projectId → absolute repo path (null if it can't be resolved). Default looks the
  // project up in the providers' stores (real cwd — the dash-decode fallback mangles
  // hyphenated repo names). Injectable so tests control the mapping.
  resolveRepo?: (projectId: string) => string | null | Promise<string | null>;
  // Called when a scratchpad is opened (GET) with a valid repo — the server binds
  // this to the events hub's watchScratchpad so writes to .seshmux/handoff.md push
  // {event:'scratchpad'} for a live tab refresh (plan 16.6). Optional (tests omit).
  onOpen?: (projectId: string, repo: string) => void;
}

const TEMPLATE = `# Shared scratchpad

This file is the handoff channel between agents working in this repo. Each agent appends an
entry (provider · branch · timestamp) below. Newest entries at the bottom.

---
`;

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function scratchpadPath(repo: string): string {
  return join(repo, '.seshmux', 'handoff.md');
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const dir = join(path, '..');
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

export default async function scratchpadRoutes(f: FastifyInstance, deps: ScratchpadDeps = {}) {
  // Same rationale as bridge.ts: providers know the REAL cwd; decode mangles
  // hyphenated repo names, so it's only the last-ditch fallback.
  const defaultResolveRepo = async (id: string): Promise<string | null> => {
    const providers = await getProviders();
    for (const p of providers) {
      const projects = await p.scanProjects().catch(() => []);
      const hit = projects.find((pr) => pr.id === id);
      if (hit) return hit.path;
    }
    return decodeProjectDir(id).path;
  };
  const resolveRepo = deps.resolveRepo ?? defaultResolveRepo;

  // Resolve + validate the repo dir; reply 404 and return null if invalid (no traversal).
  async function repoOrNull(projectId: string): Promise<string | null> {
    const repo = await resolveRepo(projectId);
    if (!repo || !(await isDir(repo))) return null;
    return repo;
  }

  f.get<{ Params: { projectId: string } }>('/api/scratchpad/:projectId', async (req, reply) => {
    const repo = await repoOrNull(req.params.projectId);
    if (!repo) {
      reply.code(404);
      return { error: 'project not found' };
    }
    // Opening the scratchpad starts watching its file for live-refresh (16.6).
    deps.onOpen?.(req.params.projectId, repo);
    try {
      const content = await readFile(scratchpadPath(repo), 'utf8');
      return { content };
    } catch {
      return { content: '' }; // no scratchpad yet
    }
  });

  f.put<{ Params: { projectId: string }; Body: { content?: string } }>(
    '/api/scratchpad/:projectId',
    async (req, reply) => {
      const repo = await repoOrNull(req.params.projectId);
      if (!repo) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const path = scratchpadPath(repo);
      // Seed the template on first write so a hand-written entry isn't orphaned.
      let content = typeof req.body?.content === 'string' ? req.body.content : '';
      try {
        await stat(path);
      } catch {
        if (!content.startsWith('# ')) content = TEMPLATE + content;
      }
      await atomicWrite(path, content);
      return { ok: true, content };
    },
  );
}

// GET /api/customizations — read-only merge of every provider's customization
// scanners (agents/skills/instructions/hooks/mcp) for one scope. v1 has NO
// write endpoints; v2 editing PUTs against item.filePath (see roadmap doc).

import type { FastifyInstance } from 'fastify';
import { mkdir, writeFile, realpath, lstat } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import { execFile } from 'node:child_process';
import type { AgentProvider } from '../lib/providers/types';
import type { CustomizationItem, CustomizationScope, CustomizationScanners } from '../lib/providers/customizations';
import { getProviders } from '../lib/providers/types';

export interface CustomizationsRouteOpts {
  listProviders?: () => Promise<AgentProvider[]>;
  resolveRepo?: (projectId: string) => Promise<string | null>;
  runHeadless?: (argv: string[], cwd: string) => Promise<{ text: string; ok: boolean }>;
}

// Mirrors server/lib/bridge/mcp.ts:177-189 — execFile, never a shell string.
function defaultRunHeadless(argv: string[], cwd: string): Promise<{ text: string; ok: boolean }> {
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

const SECTIONS = ['agents', 'skills', 'instructions', 'hooks', 'mcpServers'] as const;

// Resolve a projectId to a repo path ONLY when it's a real scanned project (SEC-3/4 gate,
// same as scratchpad/subagents). Never falls back to dash-decoding an arbitrary id into a
// path: the project scope reads CLAUDE.md/.mcp.json/settings.json, so a crafted id could
// otherwise pull config (possible secrets) from any directory. A hyphenated repo that
// actually scans is still matched here by its exact scanned id.
async function scannedResolveRepo(id: string): Promise<string | null> {
  const providers = await getProviders();
  for (const p of providers) {
    const projects = await p.scanProjects().catch(() => []);
    const hit = projects.find((pr) => pr.id === id);
    if (hit) return hit.path;
  }
  return null;
}

export default async function customizationsRoutes(f: FastifyInstance, opts: CustomizationsRouteOpts = {}) {
  const listProviders = opts.listProviders ?? getProviders;
  const resolveRepo = opts.resolveRepo ?? scannedResolveRepo;
  const runHeadless = opts.runHeadless ?? defaultRunHeadless;

  f.get<{ Querystring: { scope?: string; project?: string } }>('/api/customizations', async (req, reply) => {
    let scope: CustomizationScope;
    if (req.query.scope === 'project') {
      const repoPath = req.query.project ? await resolveRepo(req.query.project) : null;
      if (!repoPath) return reply.code(404).send({ error: 'unknown project' });
      scope = { kind: 'project', repoPath };
    } else {
      scope = { kind: 'global' };
    }

    const providers = await listProviders();
    const out: Record<string, CustomizationItem[]> = { agents: [], skills: [], instructions: [], hooks: [], mcp: [] };
    await Promise.all(
      providers.flatMap((p) =>
        SECTIONS.map(async (section) => {
          const scan = p.customizations?.[section as keyof CustomizationScanners];
          if (!scan) return;
          try {
            const items = await scan(scope);
            out[section === 'mcpServers' ? 'mcp' : section].push(...items);
          } catch {
            /* one provider's scan failure never breaks the section */
          }
        }),
      ),
    );
    for (const k of Object.keys(out)) out[k].sort((a, b) => a.title.localeCompare(b.title));
    return out;
  });

  const NAME_RE = /^[a-z0-9-]{1,64}$/;
  const MAX_CONTENT = 256 * 1024;

  f.put<{ Body: { projectId?: string; provider?: string; section?: string; name?: string; content?: string } }>(
    '/api/customizations/item',
    async (req, reply) => {
      const { projectId, provider: providerId, section, name, content } = req.body ?? {};
      if (section !== 'agents' && section !== 'skills') return reply.code(400).send({ error: 'bad section' });
      if (typeof name !== 'string' || !NAME_RE.test(name)) return reply.code(400).send({ error: 'bad name' });
      if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_CONTENT)
        return reply.code(400).send({ error: 'bad content' });

      const repoPath = projectId ? await resolveRepo(projectId) : null;
      if (!repoPath) return reply.code(404).send({ error: 'unknown project' });

      const providers = await listProviders();
      const provider = providers.find((p) => p.id === providerId);
      if (!provider?.customizationWriteTarget)
        return reply.code(400).send({ error: 'provider does not support authoring' });

      const target = provider.customizationWriteTarget({ kind: 'project', repoPath }, section, name);

      // Containment, symlink-proof: walk from the leaf up, realpath-resolving each
      // EXISTING ancestor (leaf first, then parents) inside the real repo root. Fail
      // closed on any fs error. A symlink AT the leaf (even dangling, where realpath
      // ENOENTs and the loop would otherwise fall through to the parent dir check) is
      // rejected outright by lstat below — we never write through a symlink, existing
      // or dangling, since writeFile follows it regardless of where it points.
      try {
        const leafStat = await lstat(target).catch(() => null);
        if (leafStat?.isSymbolicLink()) {
          return reply.code(400).send({ error: 'target escapes project' });
        }

        const repoReal = await realpath(repoPath);
        let probe = target;
        for (;;) {
          try {
            const real = await realpath(probe);
            if (real !== repoReal && !real.startsWith(repoReal + sep)) {
              return reply.code(400).send({ error: 'target escapes project' });
            }
            break;
          } catch {
            const parent = dirname(probe);
            if (parent === probe) return reply.code(400).send({ error: 'target escapes project' });
            probe = parent;
          }
        }
        await mkdir(dirname(target), { recursive: true });
        // ponytail: check-then-write TOCTOU window remains; closing it needs O_NOFOLLOW/openat,
        // revisit if seshmux ever serves non-local users
        await writeFile(target, content, 'utf8');
      } catch {
        return reply.code(400).send({ error: 'write failed' });
      }
      return { ok: true, filePath: target };
    },
  );

  f.post<{ Body: { projectId?: string; provider?: string; section?: string; name?: string; draft?: string } }>(
    '/api/customizations/assist',
    async (req, reply) => {
      const { projectId, provider: providerId, section, name, draft } = req.body ?? {};
      if (section !== 'agents' && section !== 'skills') return reply.code(400).send({ error: 'bad section' });
      if (typeof draft !== 'string' || !draft.trim()) return reply.code(400).send({ error: 'empty draft' });
      const repoPath = projectId ? await resolveRepo(projectId) : null;
      if (!repoPath) return reply.code(404).send({ error: 'unknown project' });
      const providers = await listProviders();
      const provider = providers.find((p) => p.id === providerId);
      if (!provider?.commands?.headlessAsk) return reply.code(400).send({ error: 'unknown provider' });

      const kind = section === 'skills' ? 'a SKILL.md skill file' : 'an agent definition markdown file';
      const prompt =
        `You are polishing ${kind} named "${name ?? ''}" for a Claude Code project.\n` +
        `Rewrite the draft below into a complete, well-structured file. Requirements:\n` +
        `- Start with --- frontmatter containing name and a one-line description.\n` +
        `- Keep the author's intent; tighten wording; add missing sections a good ${section === 'skills' ? 'SKILL.md' : 'agent file'} needs.\n` +
        `- Output ONLY the file content, no commentary, no code fences.\n\nDRAFT:\n${draft}`;

      const { text, ok } = await runHeadless(provider.commands.headlessAsk(repoPath, prompt), repoPath);
      if (!ok) return reply.code(502).send({ error: text || 'agent run failed' });
      return { text };
    },
  );
}

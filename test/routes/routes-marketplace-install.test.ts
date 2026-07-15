import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import marketplaceRoutes from '../../server/routes/marketplace';
import type { AgentProvider } from '../../server/lib/providers/types';
import type { CustomizationScope } from '../../server/lib/providers/customizations';

function fakeProvider(): AgentProvider {
  return {
    id: 'claude',
    customizationWriteTarget(scope: CustomizationScope, section: 'agents' | 'skills', name: string) {
      const repoPath = scope.kind === 'project' ? scope.repoPath : '';
      const root = join(repoPath, '.claude', section);
      return section === 'skills' ? join(root, name, 'SKILL.md') : join(root, `${name}.md`);
    },
  } as AgentProvider;
}

async function app(
  fetchText: (url: string) => Promise<string>,
  opts: { repoPath?: string } = {},
) {
  const repoPath = opts.repoPath ?? (await mkdtemp(join(tmpdir(), 'seshmux-install-')));
  const f = Fastify();
  f.register(marketplaceRoutes, {
    fetchText,
    resolveRepo: async (id: string) => (id === 'proj-1' ? repoPath : null),
    listProviders: async () => [fakeProvider()],
  });
  return { f, repoPath };
}

const skillMd = (desc: string) => `---\nname: foo\ndescription: ${desc}\n---\nbody`;
const agentMd = (desc: string) => `---\ndescription: ${desc}\n---\nbody`;

describe('POST /api/marketplace/install', () => {
  it('installs a single-file agent', async () => {
    const { f, repoPath } = await app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/agent-repo/git/trees/HEAD?recursive=1') {
        return JSON.stringify({ tree: [{ path: 'agents/baz.md', type: 'blob' }] });
      }
      if (url === 'https://raw.githubusercontent.com/acme/agent-repo/HEAD/agents/baz.md') {
        return agentMd('Baz agent desc');
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { projectId: 'proj-1', source: 'acme/agent-repo', path: 'agents/baz.md', section: 'agents', name: 'baz' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.filePaths).toEqual([join(repoPath, '.claude', 'agents', 'baz.md')]);
    const written = await readFile(body.filePaths[0], 'utf8');
    expect(written).toBe(agentMd('Baz agent desc'));
  });

  it('installs a multi-file skill, lands all files under the skill dir, stamps source', async () => {
    const { f, repoPath } = await app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/skill-repo/git/trees/HEAD?recursive=1') {
        return JSON.stringify({
          tree: [
            { path: 'skills/foo/SKILL.md', type: 'blob' },
            { path: 'skills/foo/scripts/run.sh', type: 'blob' },
          ],
        });
      }
      if (url === 'https://raw.githubusercontent.com/acme/skill-repo/HEAD/skills/foo/SKILL.md') {
        return skillMd('Foo skill desc');
      }
      if (url === 'https://raw.githubusercontent.com/acme/skill-repo/HEAD/skills/foo/scripts/run.sh') {
        return '#!/bin/sh\necho hi';
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { projectId: 'proj-1', source: 'acme/skill-repo', path: 'skills/foo', section: 'skills', name: 'foo' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    const skillDir = join(repoPath, '.claude', 'skills', 'foo');
    expect(body.filePaths.sort()).toEqual(
      [join(skillDir, 'SKILL.md'), join(skillDir, 'scripts', 'run.sh')].sort(),
    );
    const skillMdOut = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
    expect(skillMdOut).toContain('source: acme/skill-repo');
    expect(skillMdOut).toMatch(/source: acme\/skill-repo\n---/);
    const scriptOut = await readFile(join(skillDir, 'scripts', 'run.sh'), 'utf8');
    expect(scriptOut).toBe('#!/bin/sh\necho hi');
  });

  it('404s for an unknown project', async () => {
    const { f } = await app(async () => {
      throw new Error('should not be called');
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { projectId: 'nope', source: 'acme/repo', path: 'agents/baz.md', section: 'agents', name: 'baz' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s a bad name', async () => {
    const { f } = await app(async () => {
      throw new Error('should not be called');
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { projectId: 'proj-1', source: 'acme/repo', path: 'agents/baz.md', section: 'agents', name: 'Bad Name!' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s a file with a ../ relative path and writes nothing', async () => {
    const { f, repoPath } = await app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/relpath-repo/git/trees/HEAD?recursive=1') {
        return JSON.stringify({
          tree: [
            { path: 'skills/foo/SKILL.md', type: 'blob' },
            { path: 'skills/foo/../../evil.md', type: 'blob' },
          ],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { projectId: 'proj-1', source: 'acme/relpath-repo', path: 'skills/foo', section: 'skills', name: 'foo' },
    });
    expect(res.statusCode).toBe(400);
    await expect(stat(join(repoPath, '.claude', 'skills', 'foo'))).rejects.toThrow();
  });

  it('502s when a fetch fails mid-set and writes nothing (temp-dir rename semantics)', async () => {
    const { f, repoPath } = await app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/fail-mid-repo/git/trees/HEAD?recursive=1') {
        return JSON.stringify({
          tree: [
            { path: 'skills/foo/SKILL.md', type: 'blob' },
            { path: 'skills/foo/scripts/run.sh', type: 'blob' },
          ],
        });
      }
      if (url === 'https://raw.githubusercontent.com/acme/fail-mid-repo/HEAD/skills/foo/SKILL.md') {
        return skillMd('Foo skill desc');
      }
      if (url === 'https://raw.githubusercontent.com/acme/fail-mid-repo/HEAD/skills/foo/scripts/run.sh') {
        throw new Error('boom');
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { projectId: 'proj-1', source: 'acme/fail-mid-repo', path: 'skills/foo', section: 'skills', name: 'foo' },
    });
    expect(res.statusCode).toBe(502);
    await expect(stat(join(repoPath, '.claude', 'skills', 'foo'))).rejects.toThrow();
  });
});

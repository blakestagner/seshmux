import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import marketplaceRoutes from '../../server/routes/marketplace';
import type { AgentProvider } from '../../server/lib/providers/types';
import type { CustomizationScope } from '../../server/lib/providers/customizations';
import { canSymlink } from '../helpers/platform';

// globalRoot mimics the real claude provider's custRoot(): global installs
// land under <globalRoot>/agents|skills, project installs under
// <repoPath>/.claude/agents|skills (unchanged).
function fakeProvider(globalRoot: string): AgentProvider {
  return {
    id: 'claude',
    customizationWriteTarget(scope: CustomizationScope, section: 'agents' | 'skills', name: string) {
      const root =
        scope.kind === 'global' ? join(globalRoot, section) : join(scope.repoPath, '.claude', section);
      return section === 'skills' ? join(root, name, 'SKILL.md') : join(root, `${name}.md`);
    },
  } as AgentProvider;
}

async function app(
  fetchText: (url: string) => Promise<string>,
  opts: { repoPath?: string; globalRoot?: string } = {},
) {
  const repoPath = opts.repoPath ?? (await mkdtemp(join(tmpdir(), 'seshmux-install-')));
  const globalRoot = opts.globalRoot ?? (await mkdtemp(join(tmpdir(), 'seshmux-install-global-')));
  const f = Fastify();
  f.register(marketplaceRoutes, {
    fetchText,
    resolveRepo: async (id: string) => (id === 'proj-1' ? repoPath : null),
    listProviders: async () => [fakeProvider(globalRoot)],
  });
  return { f, repoPath, globalRoot };
}

const skillMd = (desc: string) => `---\nname: foo\ndescription: ${desc}\n---\nbody`;
const agentMd = (desc: string) => `---\ndescription: ${desc}\n---\nbody`;
const SHA = 'a'.repeat(40);

describe('POST /api/marketplace/install', () => {
  it('installs a single-file agent', async () => {
    const { f, repoPath } = await app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/agent-repo/git/trees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?recursive=1') {
        return JSON.stringify({ tree: [{ path: 'agents/baz.md', type: 'blob' }] });
      }
      if (url === 'https://raw.githubusercontent.com/acme/agent-repo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/agents/baz.md') {
        return agentMd('Baz agent desc');
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { projectId: 'proj-1', source: 'acme/agent-repo', path: 'agents/baz.md', section: 'agents', name: 'baz', sha: SHA },
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
      if (url === 'https://api.github.com/repos/acme/skill-repo/git/trees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?recursive=1') {
        return JSON.stringify({
          tree: [
            { path: 'skills/foo/SKILL.md', type: 'blob' },
            { path: 'skills/foo/scripts/run.sh', type: 'blob' },
          ],
        });
      }
      if (url === 'https://raw.githubusercontent.com/acme/skill-repo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/skills/foo/SKILL.md') {
        return skillMd('Foo skill desc');
      }
      if (url === 'https://raw.githubusercontent.com/acme/skill-repo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/skills/foo/scripts/run.sh') {
        return '#!/bin/sh\necho hi';
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { projectId: 'proj-1', source: 'acme/skill-repo', path: 'skills/foo', section: 'skills', name: 'foo', sha: SHA },
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
    expect(skillMdOut).toContain(`sourceSha: ${SHA}`);
    expect(skillMdOut).toMatch(new RegExp(`sourceSha: ${SHA}\\n---`));
    const scriptOut = await readFile(join(skillDir, 'scripts', 'run.sh'), 'utf8');
    expect(scriptOut).toBe('#!/bin/sh\necho hi');
  });

  it('400s a malformed sha and fetches nothing', async () => {
    const { f } = await app(async () => {
      throw new Error('should not be called');
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: {
        projectId: 'proj-1',
        source: 'acme/repo',
        path: 'agents/baz.md',
        section: 'agents',
        name: 'baz',
        sha: 'nope',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad sha');
  });

  it('400s a missing sha', async () => {
    const { f } = await app(async () => {
      throw new Error('should not be called');
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { projectId: 'proj-1', source: 'acme/repo', path: 'agents/baz.md', section: 'agents', name: 'baz' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad sha');
  });

  it('fetches at the pinned sha, not HEAD', async () => {
    const fetchedUrls: string[] = [];
    const { f } = await app(async (url: string) => {
      fetchedUrls.push(url);
      if (url.includes('/git/trees/')) return JSON.stringify({ tree: [{ path: 'agents/baz.md', type: 'blob' }] });
      return agentMd('Baz agent desc');
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { projectId: 'proj-1', source: 'acme/pin-repo', path: 'agents/baz.md', section: 'agents', name: 'baz', sha: SHA },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchedUrls.every((u) => !u.includes('HEAD'))).toBe(true);
    expect(fetchedUrls.some((u) => u.includes(`/${SHA}/agents/baz.md`))).toBe(true);
  });

  it('404s for an unknown project', async () => {
    const { f } = await app(async () => {
      throw new Error('should not be called');
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { projectId: 'nope', source: 'acme/repo', path: 'agents/baz.md', section: 'agents', name: 'baz', sha: SHA },
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
      payload: { projectId: 'proj-1', source: 'acme/repo', path: 'agents/baz.md', section: 'agents', name: 'Bad Name!', sha: SHA },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s a file with a ../ relative path and writes nothing', async () => {
    const { f, repoPath } = await app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/relpath-repo/git/trees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?recursive=1') {
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
      payload: { projectId: 'proj-1', source: 'acme/relpath-repo', path: 'skills/foo', section: 'skills', name: 'foo', sha: SHA },
    });
    expect(res.statusCode).toBe(400);
    await expect(stat(join(repoPath, '.claude', 'skills', 'foo'))).rejects.toThrow();
  });

  it('400s a file with a backslash segment (win32 traversal defense-in-depth) and writes nothing', async () => {
    const { f, repoPath } = await app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/backslash-repo/git/trees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?recursive=1') {
        return JSON.stringify({
          tree: [
            { path: 'skills/foo/SKILL.md', type: 'blob' },
            { path: 'skills/foo/sub\\..\\..\\evil.md', type: 'blob' },
          ],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { projectId: 'proj-1', source: 'acme/backslash-repo', path: 'skills/foo', section: 'skills', name: 'foo', sha: SHA },
    });
    expect(res.statusCode).toBe(400);
    await expect(stat(join(repoPath, '.claude', 'skills', 'foo'))).rejects.toThrow();
  });

  it('400s an agent install whose path matches more than one blob', async () => {
    const { f } = await app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/multi-agent-repo/git/trees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?recursive=1') {
        return JSON.stringify({
          tree: [
            { path: 'agents/baz.md', type: 'blob' },
            { path: 'agents/baz.md/extra.md', type: 'blob' },
          ],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { projectId: 'proj-1', source: 'acme/multi-agent-repo', path: 'agents/baz.md', section: 'agents', name: 'baz', sha: SHA },
    });
    expect(res.statusCode).toBe(400);
  });

  it('502s when a fetch fails mid-set and writes nothing (temp-dir rename semantics)', async () => {
    const { f, repoPath } = await app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/fail-mid-repo/git/trees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?recursive=1') {
        return JSON.stringify({
          tree: [
            { path: 'skills/foo/SKILL.md', type: 'blob' },
            { path: 'skills/foo/scripts/run.sh', type: 'blob' },
          ],
        });
      }
      if (url === 'https://raw.githubusercontent.com/acme/fail-mid-repo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/skills/foo/SKILL.md') {
        return skillMd('Foo skill desc');
      }
      if (url === 'https://raw.githubusercontent.com/acme/fail-mid-repo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/skills/foo/scripts/run.sh') {
        throw new Error('boom');
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { projectId: 'proj-1', source: 'acme/fail-mid-repo', path: 'skills/foo', section: 'skills', name: 'foo', sha: SHA },
    });
    expect(res.statusCode).toBe(502);
    await expect(stat(join(repoPath, '.claude', 'skills', 'foo'))).rejects.toThrow();
  });

  it('target:user installs a skill under the injected global root, no projectId needed', async () => {
    const { f, globalRoot } = await app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/user-skill-repo/git/trees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?recursive=1') {
        return JSON.stringify({
          tree: [
            { path: 'skills/foo/SKILL.md', type: 'blob' },
            { path: 'skills/foo/scripts/run.sh', type: 'blob' },
          ],
        });
      }
      if (url === 'https://raw.githubusercontent.com/acme/user-skill-repo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/skills/foo/SKILL.md') {
        return skillMd('Foo skill desc');
      }
      if (url === 'https://raw.githubusercontent.com/acme/user-skill-repo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/skills/foo/scripts/run.sh') {
        return '#!/bin/sh\necho hi';
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { source: 'acme/user-skill-repo', path: 'skills/foo', section: 'skills', name: 'foo', target: 'user', sha: SHA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    const skillDir = join(globalRoot, 'skills', 'foo');
    expect(body.filePaths.sort()).toEqual(
      [join(skillDir, 'SKILL.md'), join(skillDir, 'scripts', 'run.sh')].sort(),
    );
    const skillMdOut = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
    expect(skillMdOut).toContain('source: acme/user-skill-repo');
  });

  it('target:user installs a single-file agent under the injected global root', async () => {
    const { f, globalRoot } = await app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/user-agent-repo/git/trees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?recursive=1') {
        return JSON.stringify({ tree: [{ path: 'agents/baz.md', type: 'blob' }] });
      }
      if (url === 'https://raw.githubusercontent.com/acme/user-agent-repo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/agents/baz.md') {
        return agentMd('Baz agent desc');
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { source: 'acme/user-agent-repo', path: 'agents/baz.md', section: 'agents', name: 'baz', target: 'user', sha: SHA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    const target = join(globalRoot, 'agents', 'baz.md');
    expect(body.filePaths).toEqual([target]);
    const written = await readFile(target, 'utf8');
    expect(written).toBe(agentMd('Baz agent desc'));
  });

  it('target:user 400s a file with a ../ relative path and writes nothing', async () => {
    const { f, globalRoot } = await app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/user-relpath-repo/git/trees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?recursive=1') {
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
      payload: { source: 'acme/user-relpath-repo', path: 'skills/foo', section: 'skills', name: 'foo', target: 'user', sha: SHA },
    });
    expect(res.statusCode).toBe(400);
    await expect(stat(join(globalRoot, 'skills', 'foo'))).rejects.toThrow();
  });

  // Creating the dangling symlink is the test's own fixture setup, but on a stock Windows box
  // (no admin/Developer Mode) fs.symlink throws EPERM before the guard under test ever runs —
  // see test/helpers/platform.ts canSymlink(). Skipping loses coverage of the symlink half of
  // this containment guard on such hosts.
  it.skipIf(!canSymlink())('target:user 400s a dangling-symlink leaf and writes nothing (containment fails closed)', async () => {
    const { f, globalRoot } = await app(async (url: string) => {
      if (url === 'https://api.github.com/repos/acme/user-symlink-repo/git/trees/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?recursive=1') {
        return JSON.stringify({ tree: [{ path: 'agents/baz.md', type: 'blob' }] });
      }
      if (url === 'https://raw.githubusercontent.com/acme/user-symlink-repo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/agents/baz.md') {
        return agentMd('Baz agent desc');
      }
      throw new Error(`unexpected url ${url}`);
    });
    const agentsDir = join(globalRoot, 'agents');
    await mkdir(agentsDir, { recursive: true });
    // Dangling symlink AT the leaf target: writeWithinRepo must reject writing
    // through it regardless of where it points (fs-guard.ts lstat check).
    await symlink(join(globalRoot, 'nowhere.md'), join(agentsDir, 'baz.md'));
    const res = await f.inject({
      method: 'POST',
      url: '/api/marketplace/install',
      payload: { source: 'acme/user-symlink-repo', path: 'agents/baz.md', section: 'agents', name: 'baz', target: 'user', sha: SHA },
    });
    expect(res.statusCode).toBe(400);
    await expect(stat(join(globalRoot, 'nowhere.md'))).rejects.toThrow();
  });
});

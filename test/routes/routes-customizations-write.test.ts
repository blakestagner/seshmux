import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import customizationsRoutes from '../../server/routes/customizations';
import { canSymlink } from '../helpers/platform';

let repo: string;
beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'cust-write-')); });
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

function app() {
  const f = Fastify();
  f.register(customizationsRoutes, {
    listProviders: async () => [
      {
        id: 'claude',
        customizations: {},
        customizationWriteTarget: (s: any, section: string, name: string) =>
          section === 'skills'
            ? join(s.repoPath, '.claude', 'skills', name, 'SKILL.md')
            : join(s.repoPath, '.claude', 'agents', `${name}.md`),
      },
      { id: 'codex', customizations: {} },
    ] as any,
    resolveRepo: async (id: string) => (id === 'known' ? repo : null),
  });
  return f;
}

const put = (f: ReturnType<typeof app>, body: object) =>
  f.inject({ method: 'PUT', url: '/api/customizations/item', payload: body });

const base = { projectId: 'known', provider: 'claude', section: 'skills', name: 'my-skill', content: '# hi' };

describe('PUT /api/customizations/item', () => {
  it('writes a skill to .claude/skills/<name>/SKILL.md and returns the path', async () => {
    const res = await put(app(), base);
    expect(res.statusCode).toBe(200);
    expect(await readFile(join(repo, '.claude', 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toBe('# hi');
  });
  it('writes an agent to .claude/agents/<name>.md', async () => {
    const res = await put(app(), { ...base, section: 'agents', name: 'my-agent' });
    expect(res.statusCode).toBe(200);
    expect(await readFile(join(repo, '.claude', 'agents', 'my-agent.md'), 'utf8')).toBe('# hi');
  });
  it('404s an unknown project', async () => {
    expect((await put(app(), { ...base, projectId: 'nope' })).statusCode).toBe(404);
  });
  it('400s a provider without the write seam (codex)', async () => {
    expect((await put(app(), { ...base, provider: 'codex' })).statusCode).toBe(400);
  });
  it('400s bad names: traversal, uppercase, empty, slash', async () => {
    for (const name of ['../evil', 'Evil', '', 'a/b', 'a'.repeat(65)]) {
      expect((await put(app(), { ...base, name })).statusCode).toBe(400);
    }
  });
  it('400s a bad section', async () => {
    expect((await put(app(), { ...base, section: 'hooks' })).statusCode).toBe(400);
  });
  it('400s content over 256KB', async () => {
    expect((await put(app(), { ...base, content: 'x'.repeat(256 * 1024 + 1) })).statusCode).toBe(400);
  });
  // Symlink-escape guards: creating the escaping symlink is the test's own fixture setup,
  // but on a stock Windows box (no admin/Developer Mode) fs.symlink throws EPERM before the
  // guard under test ever runs — see test/helpers/platform.ts canSymlink(). Skipping loses
  // coverage of the symlink half of this containment guard on such hosts.
  it.skipIf(!canSymlink())('fails closed when .claude is a symlink escaping the repo', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    await symlink(outside, join(repo, '.claude'));
    const res = await put(app(), base);
    expect(res.statusCode).toBe(400);
    await rm(outside, { recursive: true, force: true });
  });
  it.skipIf(!canSymlink())('fails closed when the target itself is an existing symlink escaping the repo', async () => {
    const outsideFile = join(await mkdtemp(join(tmpdir(), 'outside-')), 'secret.txt');
    await writeFile(outsideFile, 'do not overwrite me', 'utf8');
    await mkdir(join(repo, '.claude', 'agents'), { recursive: true });
    await symlink(outsideFile, join(repo, '.claude', 'agents', 'my-agent.md'));
    const res = await put(app(), { ...base, section: 'agents', name: 'my-agent' });
    expect(res.statusCode).toBe(400);
    expect(await readFile(outsideFile, 'utf8')).toBe('do not overwrite me');
    await rm(join(outsideFile, '..'), { recursive: true, force: true });
  });
  it.skipIf(!canSymlink())('fails closed when the target is a DANGLING symlink escaping the repo', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'outside-'));
    const outsideFile = join(outsideDir, 'evil.md'); // never created
    await mkdir(join(repo, '.claude', 'agents'), { recursive: true });
    await symlink(outsideFile, join(repo, '.claude', 'agents', 'my-agent.md'));
    const res = await put(app(), { ...base, section: 'agents', name: 'my-agent' });
    expect(res.statusCode).toBe(400);
    await expect(access(outsideFile)).rejects.toThrow();
    await rm(outsideDir, { recursive: true, force: true });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWithinRepo, FsGuardError } from '../../server/lib/fs-guard';

let repo: string;
beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'fs-guard-')); });
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

describe('writeWithinRepo', () => {
  it('writes a normal file inside the repo', async () => {
    const target = join(repo, '.claude', 'agents', 'my-agent.md');
    await writeWithinRepo(repo, target, '# hi');
    expect(await readFile(target, 'utf8')).toBe('# hi');
  });

  it('rejects a traversal ancestor symlink escaping the repo', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    await symlink(outside, join(repo, '.claude'));
    const target = join(repo, '.claude', 'agents', 'my-agent.md');
    await expect(writeWithinRepo(repo, target, '# hi')).rejects.toThrow(FsGuardError);
    await rm(outside, { recursive: true, force: true });
  });

  it('rejects an existing leaf symlink escaping the repo, outside file untouched', async () => {
    const outsideFile = join(await mkdtemp(join(tmpdir(), 'outside-')), 'secret.txt');
    await writeFile(outsideFile, 'do not overwrite me', 'utf8');
    await mkdir(join(repo, '.claude', 'agents'), { recursive: true });
    const target = join(repo, '.claude', 'agents', 'my-agent.md');
    await symlink(outsideFile, target);
    await expect(writeWithinRepo(repo, target, '# hi')).rejects.toThrow(FsGuardError);
    expect(await readFile(outsideFile, 'utf8')).toBe('do not overwrite me');
    await rm(join(outsideFile, '..'), { recursive: true, force: true });
  });

  it('rejects a DANGLING leaf symlink escaping the repo, outside file untouched', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'outside-'));
    const outsideFile = join(outsideDir, 'evil.md'); // never created
    await mkdir(join(repo, '.claude', 'agents'), { recursive: true });
    const target = join(repo, '.claude', 'agents', 'my-agent.md');
    await symlink(outsideFile, target);
    await expect(writeWithinRepo(repo, target, '# hi')).rejects.toThrow(FsGuardError);
    await expect(access(outsideFile)).rejects.toThrow();
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('FsGuardError carries statusCode 400 and the expected message', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    await symlink(outside, join(repo, '.claude'));
    const target = join(repo, '.claude', 'agents', 'my-agent.md');
    try {
      await writeWithinRepo(repo, target, '# hi');
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(FsGuardError);
      expect((err as FsGuardError).statusCode).toBe(400);
      expect((err as FsGuardError).message).toBe('target escapes project');
    }
    await rm(outside, { recursive: true, force: true });
  });
});

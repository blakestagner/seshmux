// Shared containment guard for writing files under a repo root. Symlink-proof:
// walks from the leaf up, realpath-resolving each EXISTING ancestor (leaf first,
// then parents) inside the real repo root. Fails closed on any fs error.

import { mkdir, writeFile, realpath, lstat } from 'node:fs/promises';
import { dirname, sep } from 'node:path';

export class FsGuardError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'FsGuardError';
  }
}

export async function writeWithinRepo(repoPath: string, target: string, content: string): Promise<void> {
  // A symlink AT the leaf (even dangling, where realpath ENOENTs and the loop
  // would otherwise fall through to the parent dir check) is rejected outright
  // by lstat below — we never write through a symlink, existing or dangling,
  // since writeFile follows it regardless of where it points.
  const leafStat = await lstat(target).catch(() => null);
  if (leafStat?.isSymbolicLink()) {
    throw new FsGuardError('target escapes project');
  }

  // realpath(repoPath) failing (e.g. a bogus repoPath) is not a containment-walk
  // finding — rethrow raw so the route's generic 'write failed' branch surfaces
  // it, rather than misreporting a broken repoPath as an escape attempt.
  const repoReal = await realpath(repoPath);

  // Containment walk: fail closed. Any fs error while walking target -> repo
  // root is treated as an escape attempt, not a generic write failure.
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (real !== repoReal && !real.startsWith(repoReal + sep)) {
        throw new FsGuardError('target escapes project');
      }
      break;
    } catch (err) {
      if (err instanceof FsGuardError) throw err;
      const parent = dirname(probe);
      if (parent === probe) throw new FsGuardError('target escapes project');
      probe = parent;
    }
  }

  // Write phase: containment is already proven, so let real fs errors
  // (EACCES, ENOSPC, ENOTDIR, ...) surface as-is for the route's 'write failed' branch.
  await mkdir(dirname(target), { recursive: true });
  // ponytail: check-then-write TOCTOU window remains; closing it needs O_NOFOLLOW/openat,
  // revisit if seshmux ever serves non-local users
  await writeFile(target, content, 'utf8');
}

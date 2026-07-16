// Host-capability probes and cross-platform fixtures for the test suite.
//
// The suite was written on posix and encodes three assumptions that don't hold
// on native Windows. Each has exactly one home here so the fix is shared rather
// than re-invented per file:
//   1. an unprivileged process can create a symlink        -> canSymlink()
//   2. /bin/cat and /bin/sh exist                          -> catPty() / nodeScriptPty()
//   3. an IPC endpoint is a filesystem path                -> use ipcPath() from
//      server/lib/ipc.ts (or daemon/ipc.js) at every raw net.listen()/connect(),
//      exactly as the product does. Identity on posix.

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const IS_WIN = process.platform === 'win32';

let symlinkProbe: boolean | null = null;

/**
 * Whether this host lets THIS process create a symlink.
 *
 * Windows requires SeCreateSymbolicLinkPrivilege — admin, or Developer Mode
 * enabled. A stock Windows box has neither, so fs.symlink throws EPERM and any
 * test that creates a symlink to SET UP an escape scenario dies in its own
 * fixture, before the guard under test ever runs.
 *
 * Tests that need one must skip when this is false. That is a real, reported
 * coverage loss (the symlink half of a containment guard goes unverified on such
 * a host) — never "fix" those tests by weakening the guard. Junctions, the one
 * reparse point an unprivileged Windows user CAN create, are still caught by the
 * realpath containment walk, which is verified.
 */
export function canSymlink(): boolean {
  if (symlinkProbe !== null) return symlinkProbe;
  const dir = mkdtempSync(join(tmpdir(), 'smx-symprobe-'));
  try {
    writeFileSync(join(dir, 'target'), '');
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    symlinkProbe = true;
  } catch {
    symlinkProbe = false;
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return symlinkProbe;
}

/**
 * A PTY spawn target that echoes stdin back on stdout and stays alive — the
 * cross-platform replacement for `/bin/cat`, which does not exist on Windows.
 */
export function catPty(): { file: string; args: string[] } {
  const cat = fileURLToPath(new URL('../fixtures/bin/cat.cjs', import.meta.url));
  return { file: process.execPath, args: [cat] };
}

/**
 * A PTY spawn target running `code` under node — the cross-platform replacement
 * for `/bin/sh -c '<script>'`. Keep `code` free of shell metacharacters: it is
 * passed as a single argv element, never through a shell.
 */
export function nodeScriptPty(code: string): { file: string; args: string[] } {
  return { file: process.execPath, args: ['-e', code] };
}

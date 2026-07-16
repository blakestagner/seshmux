// Cross-platform binary resolution. `which` doesn't exist on Windows —
// `where.exe` does, and it returns EVERY match (one per line, PATH order),
// including the extensionless unix-shell shim npm writes next to the .cmd one,
// and CWD matches BEFORE PATH. pickBin() picks something CreateProcess can
// actually start and drops CWD shadows. The .cmd/.bat interpreter wrap lives in
// win-args.ts (cmdInvocation) — Node refuses to execFile a .cmd directly.

import { execFile } from 'node:child_process';
import { dirname } from 'node:path';

const WIN = process.platform === 'win32';
const TIMEOUT_MS = 2_000;

export type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

const defaultRun: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });

/**
 * Pick the binary to use from a `which`/`where` stdout. Shared by whichBin and
 * detect.ts so the win32 heuristic lives in exactly one place.
 * - posix: first line (which searches PATH only, never CWD).
 * - win32: drop matches in the process CWD (where lists them first, so a binary
 *   planted in the working dir could otherwise shadow the real CLI on PATH),
 *   then require a runnable extension — a bare extensionless shim can't be
 *   CreateProcess'd, so returning it would report "found" for a tool that never
 *   launches. undefined when nothing qualifies.
 */
export function pickBin(stdout: string): string | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!WIN) return lines[0] || undefined;
  const cwd = process.cwd().toLowerCase();
  const onPath = lines.filter((l) => dirname(l).toLowerCase() !== cwd);
  return onPath.find((l) => /\.(exe|cmd|bat|com)$/i.test(l)) ?? undefined;
}

/** Absolute path of `bin` on PATH, or undefined. Never throws. */
export async function whichBin(bin: string, run: Runner = defaultRun): Promise<string | undefined> {
  try {
    const { stdout } = await run(WIN ? 'where' : 'which', [bin]);
    return pickBin(stdout);
  } catch {
    return undefined;
  }
}

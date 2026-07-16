// Cross-platform binary resolution. `which` doesn't exist on Windows —
// `where.exe` does, and it returns EVERY match (one per line, PATH order),
// including the extensionless unix-shell shim npm writes next to the .cmd one.
// Prefer something CreateProcess can actually start.
//
// runBin() exists because Node refuses to execFile a .cmd/.bat directly
// (CVE-2024-27980) — those need the command interpreter.

import { execFile } from 'node:child_process';

const WIN = process.platform === 'win32';
const TIMEOUT_MS = 2_000;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Absolute path of `bin` on PATH, or undefined. Never throws. */
export async function whichBin(bin: string): Promise<string | undefined> {
  try {
    const stdout = await run(WIN ? 'where' : 'which', [bin]);
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!WIN) return lines[0] || undefined;
    return lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) ?? lines[0] ?? undefined;
  } catch {
    return undefined;
  }
}

/** Rewrite [file, args] so .cmd/.bat run through the interpreter on win32. */
export function execArgs(file: string, args: string[]): [string, string[]] {
  if (WIN && /\.(cmd|bat)$/i.test(file)) {
    return [process.env.ComSpec || 'cmd.exe', ['/c', file, ...args]];
  }
  return [file, args];
}

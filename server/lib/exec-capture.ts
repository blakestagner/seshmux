// Shared execFile-based capture for headless CLI calls: never a shell string,
// stdin closed so an interactive prompt can't hang the child. Callers own their
// own argument validation (dash-guards etc.) and env-building; this just spawns.

import { execFile } from 'node:child_process';

export function execCapture(
  bin: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number },
): Promise<{ text: string; ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer },
      (err, stdout, stderr) =>
        resolve({ text: (stdout || '').trim(), ok: !err, stderr: (stderr || '').trim() }),
    );
    child.stdin?.end();
  });
}

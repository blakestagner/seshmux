// "Reveal in Finder" — hand a path to the OS file manager.
//
// Same shape and same caveat as lib/folder-picker.ts: this opens a window on
// the machine RUNNING seshmux, which for a local-first app is the user's. It is
// deliberately fire-and-forget — the window either appears or it doesn't, and
// there is nothing useful to report back to a browser about it.
//
// No shell anywhere: the path goes through as a single argv element, and
// callers hand us an already-contained absolute path (see routes/git.ts).

import { execFile } from 'node:child_process';

/**
 * Open `target` in the file manager. When `select` is true the parent folder is
 * opened with the item highlighted (macOS/Windows only) — that's what you want
 * for a file; a directory opens directly.
 *
 * Resolves true if a file manager was launched. Never throws.
 */
export function reveal(target: string, select = false): Promise<boolean> {
  let cmd: string;
  let args: string[];
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = select ? ['-R', target] : [target];
  } else if (process.platform === 'win32') {
    cmd = 'explorer';
    // explorer exits non-zero even on success, so the caller's result is
    // advisory here — see the `|| process.platform === 'win32'` below.
    args = select ? [`/select,${target}`] : [target];
  } else {
    cmd = 'xdg-open';
    // xdg-open cannot select an item; open the containing directory instead.
    args = [select ? target.slice(0, Math.max(target.lastIndexOf('/'), 1)) : target];
  }
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err) => resolve(!err || process.platform === 'win32'));
  });
}

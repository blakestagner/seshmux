// Native "choose a folder" dialog, opened BY THE SERVER on the machine it runs
// on. The browser has no API for this — its picker is sandboxed and hands back
// an opaque handle, never a path — but seshmux is local-first, so the server and
// the user are the same machine and the OS dialog is right there.
//
// The dialog's own "New Folder" button covers folder CREATION natively too.
//
// Caveat this deliberately does not hide: if you ever point a remote browser at
// a seshmux server, the dialog opens on the SERVER's screen, not yours. That's
// why `pickerAvailable()` is probed and the UI falls back to a typed path
// instead of assuming a dialog will appear.

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

// Long enough to actually browse for a folder, short enough that a dialog
// nobody can see (headless box) eventually releases the request.
const PICKER_TIMEOUT_MS = 180_000;

// The dialog child, while one is open. Kept so a SECOND request can dismiss a
// stale dialog instead of being refused: a dialog that opened behind the
// browser, or one whose process wedged, otherwise locks the button out for the
// whole timeout — pressing Browse again must always just work.
let child: ReturnType<typeof execFile> | null = null;

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    child = execFile(cmd, args, { timeout: PICKER_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
      child = null;
      resolve({ ok: !err, out: stdout.trim() });
    });
  });
}

/**
 * `startIn` arrives in a request body, so it is untrusted input that ends up
 * inside an AppleScript literal and as an argv element for zenity/kdialog. Anything that is not a plain absolute path is DROPPED
 * (the dialog just opens at its default location) rather than escaped — a
 * cosmetic starting directory is never worth carrying an injection risk.
 *
 * Rejects: relative paths, a leading '-' (argv flag smuggling into
 * zenity/kdialog), NUL and control characters, and shell/script metacharacters
 * that have meaning in any of the languages involved. Kept strict enough to
 * still cover a PowerShell branch if Windows support lands later.
 */
export function safeStartIn(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const p = input.trim();
  if (!p || p.startsWith('-')) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f"'`$\\;|&<>*?]/.test(process.platform === 'win32' ? p.replace(/\\/g, '/') : p)) {
    return undefined;
  }
  const absolute = process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/');
  return absolute ? p : undefined;
}

async function onPath(bin: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const d of dirs) {
    if (await access(`${d}/${bin}`, constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

/**
 * Whether a native dialog can be opened here at all.
 *
 * win32 is deliberately OFF (issue: native folder picker on Windows) — the
 * PowerShell FolderBrowserDialog path was written blind and never run on a
 * Windows machine, and a dialog that might silently hang is worse than a typed
 * path. Windows users get the typed-path flow, which works everywhere.
 */
export async function pickerAvailable(): Promise<boolean> {
  if (process.platform === 'darwin') return true;
  if (process.platform === 'win32') return false;
  // Linux: only if a GTK/KDE dialog binary AND a display are actually present.
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  return (await onPath('zenity')) || (await onPath('kdialog'));
}

/**
 * Open the folder chooser. Resolves to the chosen absolute path, or null when
 * the user cancelled / no dialog could be shown.
 *
 * One dialog at a time, but a new request WINS: the previous one is killed
 * first (its promise resolves to a cancel). Refusing the second click was
 * worse — a dialog hidden behind the browser made the button look broken.
 */
export async function pickFolder(rawStartIn?: string): Promise<{ path: string | null }> {
  if (child) {
    child.kill();
    child = null;
  }
  const startIn = safeStartIn(rawStartIn);
  try {
    if (process.platform === 'darwin') {
      // NOT `tell application "System Events"`: driving another app needs macOS
      // Automation permission, and the permission prompt itself blocks — the
      // osascript then hangs holding the dialog open forever. osascript showing
      // its OWN dialog needs no permission. A bare `activate` first (still its
      // own process, still no permission) brings it to the front.
      const defaultClause = startIn ? ` default location POSIX file ${JSON.stringify(startIn)}` : '';
      const script = `POSIX path of (choose folder with prompt "Choose or create your project folder"${defaultClause})`;
      const { ok, out } = await run('osascript', ['-e', 'activate', '-e', script]);
      // Cancel exits non-zero — indistinguishable from failure, and both mean
      // the same thing to the caller: nothing was chosen.
      return { path: ok && out ? out.replace(/\/$/, '') : null };
    }

    if (await onPath('zenity')) {
      const args = ['--file-selection', '--directory', '--title=Choose or create your project folder'];
      if (startIn) args.push(`--filename=${startIn.replace(/\/?$/, '/')}`);
      const { ok, out } = await run('zenity', args);
      return { path: ok && out ? out : null };
    }
    if (await onPath('kdialog')) {
      const { ok, out } = await run('kdialog', ['--getexistingdirectory', startIn || '.']);
      return { path: ok && out ? out : null };
    }
    return { path: null };
  } finally {
    child = null;
  }
}

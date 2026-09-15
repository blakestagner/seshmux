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

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    // windowsHide: without it the PowerShell host flashes a console window
    // behind the dialog. A no-op on every other platform.
    const opts = { timeout: PICKER_TIMEOUT_MS, maxBuffer: 1 << 20, windowsHide: true, env: env ?? process.env };
    child = execFile(cmd, args, opts, (err, stdout) => {
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

// Windows PowerShell 5.1 ships with every supported Windows; the full path avoids
// resolving a `powershell.exe` planted earlier on PATH.
function winPowerShell(): string {
  return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

// Windows: the Explorer-style folder dialog (IFileOpenDialog + FOS_PICKFOLDERS).
// NOT WinForms' FolderBrowserDialog — on Windows PowerShell 5.1 (.NET Framework)
// that is the old tree-view SHBrowseForFolder box, with no address bar to paste
// a path into. Add-Type compiles the small COM shim on every open (~1s), the
// price of needing nothing installed.
//
// Owner window: the server is a background process, which Windows will not let
// take the foreground, so a bare dialog opens BEHIND the browser. An invisible
// TopMost form as the owner keeps the owned dialog above everything, and
// CenterScreen puts the dialog in the middle of the screen (it centres on its owner).
//
// The start folder arrives via $env:SESHMUX_PICK_START, never spliced into the
// script text, so there is nothing to escape. UTF-8 stdout so a non-ASCII path
// survives the pipe (PowerShell defaults to the OEM codepage).
const WIN_PICKER_PS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SeshmuxFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  class FileOpenDialog {}

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr specs);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }

  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);

  const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
  const uint SIGDN_FILESYSPATH = 0x80058000;

  public static string Pick(IntPtr owner, string title, string startIn) {
    IFileDialog dialog = (IFileDialog)new FileOpenDialog();
    uint options;
    dialog.GetOptions(out options);
    dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    dialog.SetTitle(title);
    if (!string.IsNullOrEmpty(startIn)) {
      try {
        IShellItem folder;
        SHCreateItemFromParsingName(startIn, IntPtr.Zero, typeof(IShellItem).GUID, out folder);
        dialog.SetFolder(folder);
      } catch { } // a start folder that no longer exists just opens the default
    }
    if (dialog.Show(owner) != 0) return null; // cancelled (ERROR_CANCELLED) or failed
    IShellItem result;
    dialog.GetResult(out result);
    string path;
    result.GetDisplayName(SIGDN_FILESYSPATH, out path);
    return path;
  }
}
'@
$owner = New-Object System.Windows.Forms.Form -Property @{
  TopMost = $true; ShowInTaskbar = $false; Opacity = 0; FormBorderStyle = 'None'; StartPosition = 'CenterScreen'
}
$owner.Show()
$owner.Activate()
try {
  $path = [SeshmuxFolderPicker]::Pick($owner.Handle, 'Choose or create your project folder', $env:SESHMUX_PICK_START)
} finally {
  $owner.Close()
}
if ($path) { [Console]::Out.Write($path) }
`;

/**
 * Whether a native dialog can be opened here at all.
 *
 * win32: Windows PowerShell drives the Explorer folder dialog (WIN_PICKER_PS),
 * so it's available wherever powershell.exe is — i.e. any desktop Windows.
 */
export async function pickerAvailable(): Promise<boolean> {
  if (process.platform === 'darwin') return true;
  if (process.platform === 'win32') return access(winPowerShell(), constants.F_OK).then(() => true, () => false);
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
    if (process.platform === 'win32') {
      const script = Buffer.from(WIN_PICKER_PS, 'utf16le').toString('base64');
      const { ok, out } = await run(
        winPowerShell(),
        ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', script],
        { ...process.env, SESHMUX_PICK_START: startIn ?? '' },
      );
      // Cancel prints nothing and exits 0; a failure exits non-zero. Both: no pick.
      return { path: ok && out ? out : null };
    }

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

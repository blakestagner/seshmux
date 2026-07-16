// Platform IPC endpoint mapping — mirror of daemon/ipc.js (daemon/ is
// standalone; the server never imports it — same posture as the copied wire
// protocol in daemon-client.ts). Keep the two in sync.
//
// posix: identity (unix domain socket at a filesystem path). win32: a named
// pipe derived deterministically from the path, so every process that agrees
// on configDir agrees on the pipe. Callers keep the fs path everywhere
// (staleness unlink/exists logic no-ops naturally on win32) and wrap ONLY
// net.listen()/net.connect() arguments with ipcPath().

import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export function ipcPath(fsPath: string): string {
  if (process.platform !== 'win32') return fsPath;
  const h = createHash('sha1').update(fsPath).digest('hex').slice(0, 12);
  const base = basename(fsPath).replace(/[^\w.-]/g, '-');
  return `\\\\.\\pipe\\seshmux-${h}-${base}`;
}

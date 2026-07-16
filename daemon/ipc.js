'use strict';
/**
 * Platform IPC endpoint mapping. On posix every seshmux IPC endpoint is a unix
 * domain socket at a filesystem path; on win32 Node cannot listen on a
 * filesystem path, so the same path is mapped deterministically to a named
 * pipe. Every process that agrees on the fs path (i.e. on configDir) agrees on
 * the pipe name, so the existing "re-derive the path independently" pattern
 * keeps working.
 *
 * Callers keep the fs path everywhere (existsSync/unlink staleness logic stays
 * meaningful on posix and naturally no-ops on win32 where the file never
 * exists) and wrap ONLY net.listen()/net.connect() arguments with ipcPath().
 *
 * Mirrored in server/lib/ipc.ts (daemon/ is standalone by hard rule — the
 * server never imports it). Keep the two in sync.
 */
const crypto = require('node:crypto');
const path = require('node:path');

function ipcPath(fsPath) {
  if (process.platform !== 'win32') return fsPath;
  const h = crypto.createHash('sha1').update(fsPath).digest('hex').slice(0, 12);
  const base = path.basename(fsPath).replace(/[^\w.-]/g, '-');
  return `\\\\.\\pipe\\seshmux-${h}-${base}`;
}

module.exports = { ipcPath };

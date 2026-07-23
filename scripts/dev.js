#!/usr/bin/env node
'use strict';
/**
 * Cross-platform `npm run dev`.
 *
 * This was an inline `PORT=${PORT:-4800} tsx watch …`, which is posix sh
 * syntax. npm runs package scripts through cmd.exe on win32, and cmd parses
 * neither `VAR=value cmd` nor `${VAR:-default}`, so `npm run dev` died with
 * "'PORT' is not recognized as an internal or external command".
 *
 * Defaulting PORT here keeps the posix contract byte-identical — `PORT=4900 npm
 * run dev` still wins, because npm passes it down through the environment — and
 * needs no shell at all. tsx is launched via its resolved CLI entry rather than
 * the node_modules/.bin shim so there is no .cmd to interpreter-wrap (cf.
 * daemon/win-args.js): CreateProcess can always start process.execPath.
 *
 * The auth token is pinned HERE, once per `npm run dev`, rather than being
 * regenerated inside the server. server/index.ts mints a fresh random token per
 * PROCESS, and tsx watch restarts the process on every server/ save — which
 * silently invalidated the token embedded in an already-open browser tab, so
 * every /api call 401'd with "invalid or missing token" and the websockets
 * failed until a manual reload. Still random, still per-run, never on disk;
 * it just survives the restarts that a file save causes.
 */
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const child = spawn(
  process.execPath,
  [require.resolve('tsx/cli'), 'watch', '--clear-screen=false', 'server/index.ts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: process.env.PORT || '4800',
      SESHMUX_TOKEN: process.env.SESHMUX_TOKEN || randomBytes(32).toString('hex'),
    },
  },
);

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});

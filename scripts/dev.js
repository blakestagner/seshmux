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
 */
const { spawn } = require('node:child_process');

const child = spawn(
  process.execPath,
  [require.resolve('tsx/cli'), 'watch', '--clear-screen=false', 'server/index.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, PORT: process.env.PORT || '4800' },
  },
);

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});

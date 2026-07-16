#!/usr/bin/env node
// Windows only: npm generates seshmux.ps1 alongside seshmux.cmd, and PowerShell
// prefers the .ps1 — which the default Restricted execution policy refuses to
// run ("running scripts is disabled on this system"). Deleting the .ps1 makes
// PowerShell fall back to seshmux.cmd, which runs under any policy.
// Must NEVER fail the install: everything best-effort.
if (process.platform === 'win32') {
  const fs = require('fs');
  const path = require('path');
  const candidates = [
    // global install: %APPDATA%\npm\seshmux.ps1
    process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, 'seshmux.ps1'),
    // local install: <project>/node_modules/.bin/seshmux.ps1
    path.join(__dirname, '..', '..', '.bin', 'seshmux.ps1'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* absent or locked — fine */
    }
  }
}

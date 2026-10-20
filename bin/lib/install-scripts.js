'use strict';
// Install-script policy for the self-updater + the "can this install open a terminal?" check.
// Plain CJS with zero deps so bin/seshmux.js can `require` it unbuilt AND server/lib/update.ts
// can import it (esbuild bundles it into the standalone) — same posture as ./host.js.
//
// WHY THIS EXISTS. npm ≥12 does not run the install-time lifecycle scripts of a one-off or
// global install (`npm i -g`, `npx`, `npm exec`) unless the package is named in allow-scripts.
// That is a WARNING, not an error — npm exits 0 and prints
//   npm warn install-scripts 3 packages had install scripts blocked because they are not covered by allowScripts:
//   npm warn install-scripts   @homebridge/node-pty-prebuilt-multiarch@0.13.1 (install: node scripts/check-prebuild.js || prebuild-install …)
// node-pty's tarball ships prebuilds for linux only; on win32 and darwin that blocked `install`
// script is the ONLY thing that fetches conpty.node / pty.node. So the update "succeeded",
// seshmux booted, and every live session died the instant its holder called pty.spawn
// (MODULE_NOT_FOUND ../build/Release/conpty.node — visible only in seshmuxd.log). Shipped via
// the self-updater on 2026-10-20. Do not drop the flag, and do not trust npm's exit code alone.
//
// seshmux's own postinstall (deletes the seshmux.ps1 shim PowerShell's Restricted policy refuses
// to run) is allowed for the same reason: blocking it re-breaks every PowerShell user.

const fs = require('node:fs');
const path = require('node:path');

const NATIVE_PTY_DEP = '@homebridge/node-pty-prebuilt-multiarch';
const ALLOW_SCRIPTS = ['seshmux', NATIVE_PTY_DEP];
const ALLOW_SCRIPTS_FLAG = `--allow-scripts=${ALLOW_SCRIPTS.join(',')}`;

/**
 * argv for `npm i -g <spec>`: exact pin + fresh metadata (see applyUpdate for why not @latest)
 * + the allow-scripts list. npm ≤11 does not know allow-scripts and only warns
 * "Unknown cli config" — the install proceeds and its scripts run as they always did.
 * @param {string} spec e.g. 'seshmux@0.9.1'
 * @returns {string[]}
 */
function npmGlobalInstallArgs(spec) {
  return ['i', '-g', spec, '--prefer-online', ALLOW_SCRIPTS_FLAG];
}

// One `npm warn install-scripts   <name>@<version> (<lifecycle>: …)` line per blocked package.
// The header ("3 packages had …") and the hint ("Run `npm install -g --allow-scripts=…`") have
// no `<name>@<version> (` and do not match. Scoped names included.
const BLOCKED_LINE = /install-scripts\s+((?:@[^\s@/]+\/)?[^\s@]+)@\S+\s+\(/g;

/**
 * Package names npm reported as "install scripts blocked" in its output (stdout+stderr).
 * @param {string} npmOutput
 * @returns {string[]}
 */
function blockedInstallScripts(npmOutput) {
  const names = new Set();
  for (const m of String(npmOutput || '').matchAll(BLOCKED_LINE)) names.add(m[1]);
  return [...names];
}

/**
 * Why this install cannot open a terminal, or null when it can (or there is nothing to judge).
 * Two signals: npm's own output naming node-pty as blocked, and — when `pkgRoot` is given — the
 * native binary node-pty will try to load being absent on disk. The disk check mirrors node-pty's
 * resolution (lib/windowsPtyAgent.js, lib/unixTerminal.js, lib/prebuild-file-path.js): win32
 * wants build/Release/conpty.node (pty.node is the winpty fallback); posix takes the bundled
 * prebuild for this platform/abi or build/Release/pty.node. Unresolvable node-pty → null:
 * nothing sensible to say, and the daemon reports its own error for that.
 * @param {string | null} pkgRoot seshmux's package root (where node_modules lives); null skips the disk check
 * @param {string} npmOutput output of the npm install that produced this tree ('' when there was none)
 * @param {{ platform?: string, arch?: string, abi?: string }} [env] test seam; defaults to this process
 * @returns {string | null}
 */
function nativePtyProblem(pkgRoot, npmOutput, env = {}) {
  if (blockedInstallScripts(npmOutput).includes(NATIVE_PTY_DEP)) {
    return `npm blocked the install script of ${NATIVE_PTY_DEP}`;
  }
  if (!pkgRoot) return null;
  let dir;
  try {
    dir = path.dirname(require.resolve(`${NATIVE_PTY_DEP}/package.json`, { paths: [pkgRoot] }));
  } catch {
    return null;
  }
  const platform = env.platform ?? process.platform;
  const arch = env.arch ?? process.arch;
  const abi = env.abi ?? process.versions.modules;
  const release = path.join(dir, 'build', 'Release');
  const prebuilds = path.join(dir, 'prebuilds', `${platform}-${arch}`);
  const candidates =
    platform === 'win32'
      ? [path.join(release, 'conpty.node'), path.join(release, 'pty.node')]
      : [path.join(prebuilds, `node.abi${abi}.node`), path.join(prebuilds, `node.abi${abi}.musl.node`), path.join(release, 'pty.node')];
  if (candidates.some((p) => fs.existsSync(p))) return null;
  return `${NATIVE_PTY_DEP} has no native binary for this machine (looked for ${candidates[0]})`;
}

/**
 * The user-facing message for a nativePtyProblem, ending in the one command that fixes it.
 * @param {string} problem from nativePtyProblem
 * @param {string} version the seshmux version to (re)install, e.g. '0.9.1' or 'latest'
 * @returns {string}
 */
function nativePtyWarning(problem, version) {
  return (
    `[seshmux] live terminals cannot start: ${problem}.\n` +
    '  npm 12+ skips the install-time scripts of global and npx installs unless they are allowed,\n' +
    "  and node-pty's script is what fetches its native binary on Windows and macOS. Reinstall with:\n" +
    `    npm i -g seshmux@${version} ${ALLOW_SCRIPTS_FLAG}`
  );
}

module.exports = {
  NATIVE_PTY_DEP,
  ALLOW_SCRIPTS,
  ALLOW_SCRIPTS_FLAG,
  npmGlobalInstallArgs,
  blockedInstallScripts,
  nativePtyProblem,
  nativePtyWarning,
};

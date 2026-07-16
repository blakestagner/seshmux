#!/usr/bin/env node
'use strict';

// Runtime backstop for package.json engines (npm doesn't enforce it). ES5-only syntax.
var _nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (_nodeMajor < 20) { console.error('seshmux requires Node.js >= 20 (found ' + process.versions.node + '). Please upgrade.'); process.exit(1); }
// seshmux CLI entry. Ensures a responsive seshmuxd daemon, picks a free port
// (reusing an already-running seshmux if one answers), starts the Fastify
// server, and opens the browser to the chosen port.
//
// Daemon lifecycle lives here (and in daemon/ensure.js) — NEVER in the server.
// That split is the update-safety invariant: a server restart/update must not
// touch daemon-owned PTYs. The daemon is spawned detached + unref'd so it
// survives Ctrl-C and server restarts.
const { spawn, execFile } = require('node:child_process');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { ensureDaemon, pidAlive, paths, configDir, daemonInfo, canSafelyRestartDaemon } = require('../daemon/ensure');
const { cmdInvocation } = require('../daemon/win-args');

// The daemon's pid, from the pidfile it writes in the config dir. null when it isn't running.
function readDaemonPid() {
  try {
    const pid = Number(fs.readFileSync(paths(configDir()).pid, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

// Stop the running daemon (if any) and start a fresh one. The ONLY kill+respawn path —
// shared by --restart-daemon (explicit, may end plain PTYs) and the post-update auto-upgrade
// (which only calls this once canSafelyRestartDaemon() says every live PTY is tmux-backed).
// Returns false if the old daemon refused to die (we never start a second one).
async function restartDaemon() {
  const before = readDaemonPid();
  if (before) {
    try {
      process.kill(before, 'SIGTERM');
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 40 && pidAlive(before); i++) await new Promise((r) => setTimeout(r, 100));
    if (pidAlive(before)) {
      console.error(`[seshmux] daemon ${before} did not stop; not starting a second one`);
      return false;
    }
  }
  const { spawned } = await ensureDaemon();
  console.log(`[seshmux] daemon ${spawned ? 'restarted' : 'already up'} (pid ${readDaemonPid() ?? '?'})`);
  return true;
}

// Read the version FRESH every time, never once. `require` caches, and this supervisor
// deliberately survives a self-update (it is what relaunches the server child) — so a cached
// read meant the updated server was told it was still the OLD version, and the "update
// available" banner stayed up forever. readFileSync, not require, precisely to dodge the cache.
function currentVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

// Latest published version, or null (offline, 404, timeout — never throws, never blocks).
function latestVersion(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = require('node:https').get(
      'https://registry.npmjs.org/seshmux/latest',
      { timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).version || null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

// `seshmux update` / `seshmux update --check`.
//
// Installs the EXACT version the registry reported, with --prefer-online. Never `@latest`:
// npm re-resolves that tag through its CACHED packument, so anyone whose cache predates the
// release resolves latest -> X from the network and then dies with
// "ETARGET: No matching version found for seshmux@X" from the cache. That bug shipped once
// already (the in-app button announced updates it could not install); do not reintroduce it.
async function runUpdate(checkOnly) {
  const current = currentVersion();
  const latest = await latestVersion();
  if (!latest) {
    console.error("[seshmux] couldn't reach the npm registry (offline?) — nothing changed");
    process.exit(1);
  }
  if (!versionLess(current, latest)) {
    console.log(`[seshmux] already on the latest version (v${current})`);
    return;
  }
  console.log(`[seshmux] update available: v${current} -> v${latest}`);
  if (checkOnly) return;

  // win32: npm is npm.cmd, which spawn can't start directly — route through the
  // interpreter with args quoted (cmdInvocation), NOT shell:true, which would let
  // cmd re-parse the version spec. `latest` is npm's own published version, but
  // guard it as semver before it reaches a command line regardless.
  if (!/^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/.test(latest)) {
    console.error(`[seshmux] refusing to install unexpected version string "${latest}"`);
    process.exit(1);
  }
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // spawnOpts carries windowsVerbatimArguments on the .cmd path: cmdInvocation has
  // already escaped the line and node must not re-escape it. Still not shell:true.
  const [file, spawnArgs, spawnOpts] = cmdInvocation(npmBin, ['i', '-g', `seshmux@${latest}`, '--prefer-online']);
  const code = await new Promise((resolve) => {
    const child = spawn(file, spawnArgs, { stdio: 'inherit', ...spawnOpts });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });
  if (code !== 0) {
    console.error(`[seshmux] install failed (npm exited ${code}) — still on v${current}`);
    process.exit(code);
  }

  // The package on disk is new; the daemon still runs the old code. Upgrade it too, but only
  // when nothing dies (holder- and tmux-tier PTYs re-attach; a pre-holder plain PTY would not).
  await autoUpgradeDaemon(currentVersion()).catch(() => {});

  console.log(`[seshmux] updated to v${latest}`);
  if (await probeHealth(4700)) console.log('[seshmux] a seshmux is running — restart it to use the new version');
}

// Numeric-segment version compare ("0.10.0" > "0.9.0"). Mirror of server/lib/update.ts's
// compareVersions — this file is plain CJS and cannot import the TS module.
function versionLess(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

// After a self-update the server is new but the daemon still runs the OLD code forever
// (ensureDaemon reuses any daemon that answers hello). Upgrade it here — but ONLY when no live
// session would die: tmux-tier PTYs rehydrate in the fresh daemon, plain-tier PTYs do not.
// Unreachable daemon / unknown versions (dev) → do nothing.
// Returns 'upgraded' | 'blocked' | 'noop'. quiet=true suppresses the blocked log (the retry
// loop below would otherwise repeat it forever).
async function autoUpgradeDaemon(ourVersion, quiet) {
  const info = await daemonInfo(paths(configDir()).sock).catch(() => null);
  if (!info || !info.version || !ourVersion || ourVersion === '0.0.0') return 'noop';
  if (!versionLess(info.version, ourVersion)) return 'noop';

  const { safe, plainCount } = canSafelyRestartDaemon(info.ptys);
  if (!safe) {
    if (!quiet) {
      console.log(
        `[seshmux] daemon stays on v${info.version} for now — ${plainCount} running session(s) are not tmux-backed ` +
          'and a restart would end them. It will upgrade itself as soon as they finish.',
      );
    }
    return 'blocked';
  }
  const tmuxCount = info.ptys.filter((p) => p.tmuxName && p.alive !== false).length;
  console.log(
    `[seshmux] upgrading daemon v${info.version} -> v${ourVersion}` +
      (tmuxCount ? ` (${tmuxCount} tmux session(s) will re-attach)` : ''),
  );
  await restartDaemon();
  return 'upgraded';
}

// A blocked upgrade must not stay blocked forever. Without tmux a PTY simply cannot outlive the
// daemon that owns its master fd — that is the OS, not a bug we can fix — so the answer is NOT to
// demand the user install tmux, it is to never need the restart at a bad moment. The daemon is
// harmless while stale (protocol frozen at 1; newer RPCs degrade, they don't fail), so it can
// simply WAIT for a safe moment: every live session ended, or all remaining ones are tmux-backed.
// Then it upgrades itself, with nothing killed and nothing for the user to type.
const UPGRADE_RETRY_MS = Number(process.env.SESHMUX_UPGRADE_RETRY_MS) || 60_000;
function scheduleDaemonUpgrade(getVersion) {
  let announced = false;
  const tick = async () => {
    const result = await autoUpgradeDaemon(getVersion(), announced).catch(() => 'noop');
    if (result === 'blocked') {
      announced = true; // say it once, then wait quietly
      return;
    }
    clearInterval(timer); // upgraded, or nothing to do — stop checking
  };
  const timer = setInterval(tick, UPGRADE_RETRY_MS);
  if (timer.unref) timer.unref(); // never hold the process open on this alone
  tick();
}

// Absolute path to THIS cli entry, inherited by the server child. The MCP
// bridge registration writes it into agent configs (`node <bin> mcp-bridge`) —
// `npx seshmux` only resolves once the package is published to a registry.
process.env.SESHMUX_BIN = __filename;

// GET /api/health on a port; resolves the JSON body if a seshmux answers, else null.
function probeHealth(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve(json && json.ok ? json : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

const net = require('node:net');

// Is a TCP port free to bind on 127.0.0.1? EACCES (privileged/blocked port) is reported
// distinctly so resolvePort can explain why a low port failed rather than masking it as
// "busy" (R2-5) — a plain busy port is EADDRINUSE.
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve({ free: false, code: err.code }));
    srv.once('listening', () => srv.close(() => resolve({ free: true })));
    srv.listen(port, '127.0.0.1');
  });
}

// Find a usable port in [start, start+span). Returns { port, existing }:
//  - existing:true  → a healthy seshmux already owns this port; just open browser.
//  - existing:false → a free port to bind our new server to.
async function resolvePort(start, span = 10) {
  let sawEacces = false;
  for (let port = start; port < start + span; port++) {
    const health = await probeHealth(port);
    if (health) return { port, existing: true }; // reuse the running seshmux
    const bind = await portFree(port);
    if (bind.free) return { port, existing: false };
    if (bind.code === 'EACCES') sawEacces = true;
    // Port held by something else (not a seshmux) — try the next one.
  }
  // Every port in range busy and none is a seshmux: fail loudly rather than
  // return a known-busy port (which would EADDRINUSE-crash the server child).
  const hint = sawEacces ? ' (some required elevated privileges — EACCES; try a higher --port)' : '';
  throw new Error(`no free port in ${start}-${start + span - 1}${hint}`);
}

function parseArgs(argv) {
  // $PORT is honoured because server/index.ts already does — without this the CLI
  // silently ignored it and booted on 4700 anyway. --port still wins over the env.
  const envPort = Number(process.env.PORT);
  const args = {
    port: Number.isInteger(envPort) && envPort > 0 ? envPort : 4700,
    noOpen: false,
    restartDaemon: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') args.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) args.port = Number(a.slice(7));
    else if (a === '--no-open') args.noOpen = true;
    else if (a === '--restart-daemon') args.restartDaemon = true;
  }
  if (!Number.isInteger(args.port) || args.port <= 0) args.port = 4700;
  return args;
}

function openBrowser(url) {
  // Shell-free: pass the URL as an argument, never interpolate into a shell string.
  const [cmd, cmdArgs] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  execFile(cmd, cmdArgs, (err) => {
    if (err) console.log(`[seshmux] open your browser to ${url}`);
  });
}

// tsx's real CLI entry, for the dev (unbuilt) paths below.
//
// These used to hand node `<root>/node_modules/.bin/tsx`. On posix that is a
// SYMLINK to tsx's entry, so node runs the real JS. On win32 npm instead writes
// a POSIX SHELL SHIM at that name (alongside tsx.cmd/tsx.ps1), so node parsed
// `basedir=$(dirname "$(echo "$0" | ...)")` as JavaScript and the whole app died
// with "SyntaxError: missing ) after argument list" — no hint that a build was
// missing. Resolving the package entry yields the exact file .bin/tsx points at
// on posix, so behavior there is unchanged, and it needs no interpreter wrap
// (cf. daemon/win-args.js) because node runs it directly.
function tsxEntry(root) {
  try {
    return require.resolve('tsx/cli', { paths: [root] });
  } catch {
    console.error(
      '[seshmux] no built server found (.next/standalone) and tsx is not installed.\n' +
        '  Run `npm run build` first — on Windows, stop any running seshmux before\n' +
        '  building: it holds .next/standalone open and the clean step then fails.',
    );
    process.exit(1);
  }
}

// `seshmux mcp-bridge` — run the MCP stdio bridge server (ask_codex/ask_claude).
// Invoked by claude/codex as a registered MCP server; it speaks stdio, so it must
// NOT start the web server. Runs the TS module via tsx in dev, compiled in prod.
function runMcpBridge(root) {
  const standalone = path.join(root, '.next', 'standalone', 'seshmux-mcp-bridge.js');
  const isProd = fs.existsSync(standalone);
  const child = isProd
    ? spawn(process.execPath, [standalone], { stdio: 'inherit', env: process.env })
    : spawn(
        process.execPath,
        [
          tsxEntry(root),
          '-e',
          "import('./server/lib/bridge/mcp.ts').then(m => m.startMcpBridge())",
        ],
        { cwd: root, stdio: 'inherit', env: process.env },
      );
  child.on('exit', (code) => process.exit(code ?? 0));
}

// Is a binary on PATH? Shell-free. (`which` is posix-only; win32 has where.exe.)
function have(bin) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(probe, [bin], (err, stdout) => resolve(!err && !!String(stdout).trim()));
  });
}

// The package manager we can offer to install tmux with, or null when there is nothing to offer.
async function tmuxInstaller() {
  if (process.platform === 'darwin' && (await have('brew'))) return { cmd: 'brew', args: ['install', 'tmux'] };
  if (await have('apt-get')) return { cmd: 'sudo', args: ['apt-get', 'install', '-y', 'tmux'] };
  if (await have('dnf')) return { cmd: 'sudo', args: ['dnf', 'install', '-y', 'tmux'] };
  return null;
}

// Resolves 'yes' | 'no' | 'none'. 'none' = the user never actually answered (stdin hit EOF, or
// the terminal went away): rl.question's callback then NEVER fires, which would hang startup
// forever. Booting the app matters more than this prompt, so no answer means "skip it, ask again
// next time" — never a silent decline the user did not make.
function askYesNo(question) {
  return new Promise((resolve) => {
    const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(v);
    };
    rl.on('close', () => finish('none')); // EOF / ^D / stdin closed
    rl.question(question, (answer) => finish(/^n/i.test(String(answer).trim()) ? 'no' : 'yes'));
  });
}

// tmux is an OPTIONAL extra persistence tier — not required for durable sessions. The daemon's
// holder tier already keeps agent PTYs alive across browser refreshes, server restarts, and
// updates (a detached holder owns the PTY, so even a daemon crash on posix re-adopts them). What
// tmux adds on top: surviving a full daemon restart, and `tmux attach` from any plain terminal.
// So this is a soft, informational offer, not a "you'll lose everything" warning.
//
// Windows has no native tmux, and the named-pipe holder tier covers it there anyway — so the
// offer is posix-only (skipped below).
//
// NOT an npm postinstall: that needs a package manager we can't assume, is skipped entirely under
// `npm ci --ignore-scripts` (standard in CI), would run in Docker images where tmux is pointless,
// and shelling out to a system installer from an install hook is exactly what supply-chain
// scanners flag. A first-run prompt asks the person who is actually there.
async function offerTmux() {
  if (process.platform === 'win32') return; // no native tmux; holder tier already keeps sessions durable
  if (await have('tmux')) return;
  const ackFile = path.join(configDir(), 'tmux-declined');
  if (fs.existsSync(ackFile)) return;

  const durability =
    '[seshmux] tmux is not installed (optional).\n' +
    '  Your sessions already survive browser refreshes, server restarts, and updates.\n' +
    '  tmux adds one more tier: surviving a full daemon restart, plus `tmux attach` from any terminal.';

  // Non-interactive (piped, CI, launched by a GUI): state it, never block on a prompt nobody
  // can answer, and do not record a decline the user never made.
  if (!process.stdin.isTTY) {
    console.log(`${durability}\n  Install tmux for the extra tier.`);
    return;
  }

  const installer = await tmuxInstaller();
  if (!installer) {
    console.log(`${durability}\n  Install tmux with your package manager to add it.`);
    return;
  }

  console.log(durability);
  const answer = await askYesNo(`\n  Install tmux now with ${installer.cmd}? [Y/n] `);
  if (answer === 'none') return; // no answer given — boot anyway, ask again next launch
  if (answer === 'no') {
    try {
      fs.mkdirSync(path.dirname(ackFile), { recursive: true });
      fs.writeFileSync(ackFile, 'declined\n');
    } catch {
      /* best effort — worst case we ask again next launch */
    }
    console.log('[seshmux] continuing without tmux (sessions still survive restarts/updates via the holder tier). Not asking again.');
    return;
  }

  console.log(`[seshmux] ${installer.cmd} ${installer.args.join(' ')}…`);
  await new Promise((resolve) => {
    const child = spawn(installer.cmd, installer.args, { stdio: 'inherit' });
    child.on('exit', resolve);
    child.on('error', resolve);
  });
  console.log(
    (await have('tmux'))
      ? '[seshmux] tmux installed — new sessions will survive restarts and crashes.'
      : '[seshmux] tmux install did not complete; continuing without it.',
  );
}

async function main() {
  // Subcommand dispatch (before arg parsing / server flow).
  const argv = process.argv.slice(2);
  const root = path.resolve(__dirname, '..');
  if (argv[0] === 'mcp-bridge') {
    runMcpBridge(root);
    return;
  }
  if (argv[0] === 'update') {
    await runUpdate(argv.includes('--check'));
    return;
  }
  if (argv[0] === 'version' || argv.includes('--version') || argv.includes('-v')) {
    console.log(currentVersion());
    return;
  }

  const args = parseArgs(argv);

  // --restart-daemon: the manual escape hatch for upgrading the daemon (the update flow does it
  // automatically, but ONLY when no plain PTY would die — see autoUpgradeDaemon). ensureDaemon()
  // treats any daemon that answers hello as 'ok' and reuses it (daemon/ensure.js classify()),
  // which is what keeps your sessions alive across server updates — restarting seshmux does NOT
  // replace the daemon. This does.
  //
  // Destructive on purpose: tmux-tier sessions rehydrate from `tmux ls` and survive, PLAIN-tier
  // PTYs die with the daemon. The automatic path refuses to run in that case; this flag is the
  // explicit "do it anyway, I accept losing them".
  if (args.restartDaemon) {
    const before = readDaemonPid();
    if (before) {
      console.log(`[seshmux] stopping daemon ${before} — tmux-backed sessions survive; any non-tmux PTYs will end`);
    } else {
      console.log('[seshmux] no daemon running');
    }
    if (!(await restartDaemon())) process.exit(1);
  }

  // If a healthy seshmux already runs on the requested port range, just open the
  // browser to it — no duplicate server, no port fight.
  const reuse = await resolvePort(args.port);
  if (reuse.existing) {
    const reuseUrl = `http://127.0.0.1:${reuse.port}`;
    console.log(`[seshmux] already running at ${reuseUrl}`);
    if (!args.noOpen) openBrowser(reuseUrl);
    return;
  }

  // Ask about tmux BEFORE the daemon starts, so a yes takes effect for the very first session
  // (session-start.ts picks the tmux tier only if tmux is on PATH at spawn time). Only reached
  // when we are actually starting seshmux — never when we just hand off to a running instance.
  await offerTmux().catch(() => {}); // never block startup on this

  // Ensure a responsive daemon BEFORE the server comes up. Spawns detached +
  // unref'd if needed; recovers a stale socket. Non-fatal if it can't start —
  // the app degrades to browse-only (no live terminals) rather than refusing.
  try {
    await ensureDaemon();
  } catch (e) {
    console.error(`[seshmux] daemon unavailable (${e.message}); terminals disabled`);
  }

  // Re-resolve the port RIGHT before spawning the server child, so the free-check
  // → bind window (TOCTOU) is as small as possible (the ensureDaemon await above
  // no longer sits inside it). ponytail: a local single-user app; a residual
  // sub-ms race is acceptable — the server child will simply exit if it loses it.
  let port;
  try {
    ({ port } = await resolvePort(args.port));
  } catch (e) {
    console.error(`[seshmux] ${e.message}`);
    process.exit(1);
  }
  const url = `http://127.0.0.1:${port}`;

  // Prefer the built standalone launcher when present (production install);
  // otherwise run the TypeScript server directly via tsx (local dev).
  const standalone = path.join(root, '.next', 'standalone', 'seshmux-server.js');
  const isProd = fs.existsSync(standalone);

  // Per-process auth token (Task 6.5): 32 random bytes generated ONCE here and
  // held in this supervisor. CRITICAL (Task 18): the relaunch loop reuses the
  // SAME token on every respawn — if it rotated, the auto-reconnecting browser
  // WS (carrying the old page's token) would 401 and the terminal couldn't
  // reattach after a server-only update. Never regenerate per iteration.
  const token = process.env.SESHMUX_TOKEN || randomBytes(32).toString('hex');
  // The server's update check needs OUR version, and $npm_package_version is only set when
  // node is launched by an npm script — never for `npx seshmux` or the global bin, i.e. never
  // for a real user. It fell back to "0.0.0", which would report an update as available
  // forever (0.0.0 < any published version) and never clear after applying one. The supervisor
  // is the one process that can always read its own package.json, so it passes the version down.
  const env = {
    ...process.env,
    PORT: String(port),
    SESHMUX_TOKEN: token,
  };
  if (isProd) env.NODE_ENV = 'production';

  function spawnServer() {
    env.SESHMUX_VERSION = currentVersion();
    return isProd
      ? spawn(process.execPath, [standalone], { cwd: path.dirname(standalone), stdio: 'inherit', env })
      : spawn(
          process.execPath,
          [tsxEntry(root), path.join(root, 'server', 'index.ts')],
          { cwd: root, stdio: 'inherit', env },
        );
  }

  let child = spawnServer();
  if (!args.noOpen) setTimeout(() => openBrowser(url), 1500);

  // Also on plain startup, not just after an update: a previous run may have deferred the upgrade
  // (sessions were running), or the user updated and quit before it could finish. Without this, a
  // daemon that was stale once could stay stale forever.
  scheduleDaemonUpgrade(currentVersion);

  // NOTE: shutdown kills the SERVER child only — never the daemon. The daemon is
  // detached and holds live PTYs across this process's death (update-safety).
  let shuttingDown = false;
  const shutdown = () => {
    shuttingDown = true;
    if (child && !child.killed) child.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Relaunch loop (Task 18): the server exits 75 to request a session-safe
  // restart (self-update). Respawn the NEW version — the daemon + PTYs are
  // untouched, so live sessions survive. Crash-loop guard: >3 respawns within
  // 60s → stop, print rollback instructions, exit non-zero (never an infinite
  // silent loop). The previous version for rollback is captured by applyUpdate
  // and printed by the server before it exits.
  const RESTART_CODE = 75;
  let restartTimes = [];
  const onExit = async (code) => {
    if (shuttingDown) return;
    if (code === RESTART_CODE) {
      const now = Date.now();
      restartTimes = restartTimes.filter((t) => now - t < 60_000);
      restartTimes.push(now);
      if (restartTimes.length > 3) {
        console.error(
          '[seshmux] update relaunch crash-looped (>3 restarts in 60s). Stopping.\n' +
            '[seshmux] roll back with:  npm i -g seshmux@<previous>  (see the update log above)',
        );
        process.exit(1);
      }
      console.log('[seshmux] server restarting for update (session-safe)…');
      // One-click means one click: the new package is on disk now, so upgrade the daemon too —
      // but only if every live PTY is tmux-backed (it re-attaches). If a plain session would die,
      // this defers and the retry loop finishes the job the moment that session ends.
      scheduleDaemonUpgrade(currentVersion);
      child = spawnServer();
      child.on('exit', onExit);
      return;
    }
    process.exit(code ?? 0);
  };
  child.on('exit', onExit);
}

// Guard the whole flow: resolvePort() throws when every port in range is busy (R2-5) —
// without this the first call site's rejection was unhandled (a bare stack trace, no exit
// code). Fail loudly with the reason and a non-zero exit.
main().catch((err) => {
  console.error(`[seshmux] ${err.message}`);
  process.exit(1);
});

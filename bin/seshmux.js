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
const { ensureDaemon } = require('../daemon/ensure');

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

// Is a TCP port free to bind on 127.0.0.1?
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

// Find a usable port in [start, start+span). Returns { port, existing }:
//  - existing:true  → a healthy seshmux already owns this port; just open browser.
//  - existing:false → a free port to bind our new server to.
async function resolvePort(start, span = 10) {
  for (let port = start; port < start + span; port++) {
    const health = await probeHealth(port);
    if (health) return { port, existing: true }; // reuse the running seshmux
    if (await portFree(port)) return { port, existing: false };
    // Port held by something else (not a seshmux) — try the next one.
  }
  // Every port in range busy and none is a seshmux: fail loudly rather than
  // return a known-busy port (which would EADDRINUSE-crash the server child).
  throw new Error(`no free port in ${start}-${start + span - 1}`);
}

function parseArgs(argv) {
  const args = { port: 4700, noOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') args.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) args.port = Number(a.slice(7));
    else if (a === '--no-open') args.noOpen = true;
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
          path.join(root, 'node_modules', '.bin', 'tsx'),
          '-e',
          "import('./server/lib/bridge/mcp.ts').then(m => m.startMcpBridge())",
        ],
        { cwd: root, stdio: 'inherit', env: process.env },
      );
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function main() {
  // Subcommand dispatch (before arg parsing / server flow).
  const argv = process.argv.slice(2);
  const root = path.resolve(__dirname, '..');
  if (argv[0] === 'mcp-bridge') {
    runMcpBridge(root);
    return;
  }

  const args = parseArgs(argv);

  // If a healthy seshmux already runs on the requested port range, just open the
  // browser to it — no duplicate server, no port fight.
  const reuse = await resolvePort(args.port);
  if (reuse.existing) {
    const reuseUrl = `http://127.0.0.1:${reuse.port}`;
    console.log(`[seshmux] already running at ${reuseUrl}`);
    if (!args.noOpen) openBrowser(reuseUrl);
    return;
  }

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
  const env = { ...process.env, PORT: String(port), SESHMUX_TOKEN: token };
  if (isProd) env.NODE_ENV = 'production';

  function spawnServer() {
    return isProd
      ? spawn(process.execPath, [standalone], { cwd: path.dirname(standalone), stdio: 'inherit', env })
      : spawn(
          process.execPath,
          [path.join(root, 'node_modules', '.bin', 'tsx'), path.join(root, 'server', 'index.ts')],
          { cwd: root, stdio: 'inherit', env },
        );
  }

  let child = spawnServer();
  if (!args.noOpen) setTimeout(() => openBrowser(url), 1500);

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
  const onExit = (code) => {
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
      console.log('[seshmux] server restarting for update (session-safe; daemon untouched)…');
      child = spawnServer();
      child.on('exit', onExit);
      return;
    }
    process.exit(code ?? 0);
  };
  child.on('exit', onExit);
}

main();

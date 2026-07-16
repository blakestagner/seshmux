import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import next from 'next';
import { AuthError, requireAuth } from './lib/auth';

export async function startServer({ port = 4700, dev = false } = {}) {
  // Safety net: one missed rejection anywhere (a fire-and-forget `.then` body
  // throwing, a watcher callback rejecting) must not take down the whole control
  // plane — PTYs survive in the daemon, but every open UI dies with the server.
  // Log-and-continue is the deliberate choice: this server is stateless and
  // local-only, so a crashed request is strictly worse than a logged one.
  if (process.listenerCount('unhandledRejection') === 0) {
    process.on('unhandledRejection', (reason) => {
      console.error('[seshmux] unhandled rejection:', reason);
    });
  }
  // Per-process auth token: prefer the one bin/seshmux.js generated (shared via env so the
  // Next-rendered HTML can embed it); otherwise mint one here so `tsx server/index.ts` dev
  // runs are still guarded. Never written to disk.
  const token = process.env.SESHMUX_TOKEN || randomBytes(32).toString('hex');
  process.env.SESHMUX_TOKEN = token; // ensure the Next layout reads the same value

  const app = next({ dev });
  await app.prepare();
  const handle = app.getRequestHandler();

  const f = Fastify();
  await f.register(import('@fastify/websocket'));

  // Security boundary (Task 6.5): guard every /api/* request and /ws/* upgrade with an
  // Origin check (mutating + WS) and the per-process token. Next asset/page routes
  // (/, /_next/*, favicon) are served by the Next handler and are not guarded here.
  f.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    const guarded = url.startsWith('/api/') || url.startsWith('/ws/');
    if (!guarded) return;
    if (url === '/api/health') return; // liveness probe: no secrets, used for port detection
    const isWebSocket = url.startsWith('/ws/');
    try {
      requireAuth(
        {
          method: req.method,
          headers: req.headers as Record<string, string | string[] | undefined>,
          query: req.query as Record<string, unknown>,
          url: req.url,
        },
        { token, port, isWebSocket },
      );
    } catch (e) {
      const err = e as AuthError;
      reply.code(err.statusCode ?? 403).send({ error: err.message });
    }
  });

  f.get('/api/health', async () => ({
    ok: true,
    version: process.env.npm_package_version,
  }));

  // Events hub (Task 15/16): owns needs-input status, ctx/session watch fan-out,
  // and the monitor daemon connection. One per server process.
  const { createEventsHub } = await import('./events-hub');
  const hub = await createEventsHub();
  // Let the shared session-start machinery attach the monitor on every spawn.
  const { setSpawnListener, startSession } = await import('./session-start');
  setSpawnListener((ptyId) => hub.trackPty(ptyId));

  // Events WS — one connection per browser, multiplexes status/ctx/session/*.
  // Guarded by the auth hook (it's under /ws/). Replay-on-connect handled in hub.
  f.get('/ws/events', { websocket: true }, (socket) => {
    hub.addClient(socket);
  });

  // MCP approval listener (16.7): the mcp-bridge process connects over
  // <configDir>/approval.sock per request; we bind onRequest to the hub so the
  // UI gets an {event:'approval'} toast and its reply resolves the call. The
  // listener owns the 120s deadline (fail-closed → deny). Non-fatal if it can't
  // bind — bridge calls then fail-closed (deny), which is the safe default.
  try {
    const { startApprovalListener } = await import('./lib/bridge/approval-socket');
    const { join } = await import('node:path');
    const os = await import('node:os');
    const configDir = process.env.SESHMUX_CONFIG_DIR || join(os.homedir(), '.config', 'seshmux');
    await startApprovalListener({
      socketPath: join(configDir, 'approval.sock'),
      onRequest: (info) => hub.requestApproval(info),
    });
  } catch (e) {
    console.error('[seshmux] approval listener unavailable:', (e as Error).message);
  }

  // MCP wait_for_status listener (Spec 5): the mcp-bridge process (separate
  // process from the hub — see wait-socket.ts) connects over
  // <configDir>/wait.sock per request. onRequest resolves {project, session} to
  // a live ptyId (same repo-resolution + cwd-match as REST /api/bridge/wait)
  // then calls hub.waitForStatus, which is already fail-safe (never throws,
  // resolves 'timeout' at its own cap). Non-fatal if it can't bind — the MCP
  // wait tool's own client-side backstop degrades to a timeout result.
  try {
    const { startWaitListener } = await import('./lib/bridge/wait-socket');
    const { defaultResolveRepo, defaultListLivePtys } = await import('./routes/bridge');
    const { join } = await import('node:path');
    const os = await import('node:os');
    const configDir = process.env.SESHMUX_CONFIG_DIR || join(os.homedir(), '.config', 'seshmux');
    await startWaitListener({
      socketPath: join(configDir, 'wait.sock'),
      onRequest: async (req) => {
        const repo = await defaultResolveRepo(req.project);
        if (!repo) return { status: 'timeout', error: 'project not found' };
        const live = await defaultListLivePtys();
        const hit = live.find((p) => p.cwd === repo);
        if (!hit) return { status: 'timeout', error: 'no live session found for this project' };
        return hub.waitForStatus(hit.ptyId, req.status, req.timeoutSec);
      },
    });
  } catch (e) {
    console.error('[seshmux] wait listener unavailable:', (e as Error).message);
  }

  // Test hook (Task 18 gate): SIGUSR2 triggers the SAME session-safe restart
  // choreography as a real update — broadcast server-restarting, flush, exit 75 —
  // WITHOUT running npm. Lets the update-safety gate exercise the real bin
  // relaunch loop + ws reconnect without a published package.
  process.on('SIGUSR2', () => {
    hub.broadcastRestarting();
    setTimeout(() => process.exit(75), 250);
  });

  // REST API (Task 7) — all guarded by the onRequest auth hook above.
  await f.register((await import('./routes/projects')).default);
  // Read config ONCE at boot for the transcript LRU size (never on the hot path).
  const { readConfig } = await import('./routes/config');
  const bootConfig = await readConfig().catch(() => null);
  const rawCacheSize = bootConfig?.settings?.transcriptCacheSize;
  const transcriptCacheSize = typeof rawCacheSize === 'number' && rawCacheSize > 0 ? rawCacheSize : 10;
  await f.register((await import('./routes/transcript')).default, { cacheSize: transcriptCacheSize });
  await f.register((await import('./routes/search')).default);
  await f.register((await import('./routes/env')).default);
  await f.register((await import('./routes/usage')).default);
  await f.register((await import('./routes/config')).default);
  await f.register((await import('./routes/customizations')).default);
  await f.register((await import('./routes/marketplace')).default);
  // Status-hook install (Spec 2 — Settings "Deep agent integration" toggle).
  await f.register((await import('./routes/hooks')).default);

  // Terminal bridge (Task 13): WS /ws/term/:ptyId + POST /api/sessions/start
  // + GET /api/sessions/live. Also guarded by the auth hook.
  // getStatusExplain (Spec 6): GET /api/term/:ptyId/status-explain reads the
  // hub's latest classify evidence — injected like bridge's startSession.
  await f.register((await import('./routes/term')).default, {
    getStatusExplain: (ptyId: string) => hub.getStatusExplain(ptyId),
  });

  // Workspaces (v1.x Spec 1): one-click isolated git worktree + branch per
  // session. Boot reconcile first (crash between `git worktree add` and the
  // json write, or vice versa, can orphan either side) so the rail never
  // shows a ghost workspace.
  await (await import('./lib/workspaces')).reconcile().catch(() => {});
  await f.register((await import('./routes/workspaces')).default);

  // Read-only branch line stats (+N/-N chip + changes panel).
  await f.register((await import('./routes/git')).default);

  // Teams v1 (Task 3): template CRUD + team start via the SHARED startSession.
  // onTeamWatch (Task 4): first /api/teams/members request for a team arms the
  // hub's lazy config.json watch → live {event:'team'} pushes for the roster panel.
  await f.register((await import('./routes/teams')).default, {
    onTeamWatch: (teamName: string, leadSessionId: string, configPath: string) =>
      hub.watchTeam(teamName, leadSessionId, configPath),
  });

  // Agent bridge (Task 16.5+): handoff / review / plan-off. Its spawn seam binds
  // to the SHARED startSession (opts shape already matches — bridge passes the
  // linkSrc OBJECT, startSession flattens it into tabMeta).
  // waitForStatus (Spec 5): the REST /api/bridge/wait route runs in THIS process
  // (same as the hub), so it calls hub.waitForStatus directly — no socket needed
  // here (only the MCP tool, a separate process, needs the wait-socket below).
  await f.register((await import('./routes/bridge')).default, {
    startSession: (opts) => startSession({ ...opts, mode: 'new' }),
    waitForStatus: (ptyId, status, timeoutSec) => hub.waitForStatus(ptyId, status, timeoutSec),
  });
  // Scratchpad (16.6): opening a scratchpad tab starts a file watch on its
  // .seshmux/handoff.md so either agent's write pushes {event:'scratchpad'}.
  await f.register((await import('./routes/scratchpad')).default, {
    onOpen: (projectId: string, repo: string) => hub.watchScratchpad(projectId, repo),
  });
  // Read-only subagent-transcript viewer. onOpen starts the lazy per-session chokidar
  // watch → {event:'subagents'} pings drive live-refetch.
  await f.register((await import('./routes/subagents')).default, {
    onOpen: (projectId: string, sessionId: string) => hub.watchSubagents(projectId, sessionId),
  });
  // macOS notification relay (osascript can't run client-side). Darwin-only,
  // config-gated. Feeds the Toast's native-notification path (Task 15).
  await f.register((await import('./routes/notify')).default);
  // MCP approval reply (16.7): the UI POSTs {approved} here to resolve a pending
  // hub.requestApproval(). The approval LISTENER (lead-data's socket lib) binds
  // hub.requestApproval as its onRequest — wired below once that lib lands.
  await f.register((await import('./routes/approval')).default, {
    resolveApproval: (requestId: string, approved: boolean) => hub.resolveApproval(requestId, approved),
  });
  // Update (Task 18): after a successful `npm i -g`, run the SERVER-ONLY restart
  // choreography — broadcast server-restarting, let the frame flush, exit 75.
  // bin/seshmux.js's relaunch loop respawns the new version; the daemon + PTYs
  // are untouched (update-safety invariant).
  await f.register((await import('./routes/update')).default, {
    onApplied: async () => {
      hub.broadcastRestarting();
      // Flush the ws frame + the HTTP response, then exit for the relaunch loop.
      setTimeout(() => process.exit(75), 250);
    },
  });

  // Next passthrough via NotFoundHandler — NOT a '/*' catch-all ('/*' is invalid
  // find-my-way syntax and a wildcard route fights @fastify/websocket registration order).
  // WS upgrades for non-/ws/ paths (dev HMR at /_next/webpack-hmr) land here too via
  // @fastify/websocket's router dispatch. Handing those to Next's REQUEST handler
  // double-writes the socket (101 + HMR frames, then a raw 404 page) → browser
  // "Invalid frame header". Route them to Next's UPGRADE handler instead.
  // ponytail: head bytes buffered by @fastify/websocket are behind a private symbol;
  // an empty head is correct for browser handshakes.
  const nextUpgrade = app.getUpgradeHandler();
  f.setNotFoundHandler((req, reply) => {
    reply.hijack();
    if ((req.raw.headers.upgrade ?? '').toLowerCase() === 'websocket') {
      nextUpgrade(req.raw, req.raw.socket, Buffer.alloc(0));
      return;
    }
    handle(req.raw, reply.raw);
  });

  await f.listen({ port, host: '127.0.0.1' });
  return f;
}

// Allow direct execution: `tsx server/index.ts` (dev spike) or compiled JS in prod.
// argv[1] is an OS-native path — on win32 that's backslash-separated, so compare
// against a slash-normalized copy or this never matches and the server silently
// exits 0 without listening. Normalizing is a no-op for posix separators.
const entryPath = (process.argv[1] ?? '').replace(/\\/g, '/');
const isMain = entryPath.endsWith('server/index.ts') || entryPath.endsWith('server/index.js');
if (isMain) {
  const dev = process.env.NODE_ENV !== 'production';
  const port = Number(process.env.PORT) || 4700;
  startServer({ port, dev }).then(() => {
    console.log(`[seshmux] server on http://127.0.0.1:${port} (dev=${dev})`);
  });
}

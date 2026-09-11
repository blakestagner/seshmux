// Embedded-browser (preview panel) routes.
//
//   GET  /api/preview/ports?project&pty   -> { ports, dir }
//   GET  /api/preview/scripts?project&pty -> { groups, dir }
//   POST /api/preview/run                 -> { ptyId, command }
//   GET  /api/preview/frame?url           -> { reachable, blocked, status }
//   POST /api/preview/proxy  { port }       -> { proxyPort }
//
// Kept out of routes/git.ts even though /api/git/ports is its neighbour: that
// file's ports endpoint answers "which process owns a port in this repo" (lsof,
// posix-only, has a kill button behind it), while these answer "what can the
// browser panel show for THIS SESSION" — a different source of truth (PTY
// scrollback, see lib/preview.ts) with a different platform story.
//
// Guarded by the onRequest auth hook in server/index.ts (under /api/).

import type { FastifyInstance } from 'fastify';
import { dial } from '../daemon-client';
import { readEntries } from '../lib/live-ledger';
import { readScratchMap, type ScratchMap } from '../lib/scratch-store';
import { startScratchTerminal } from '../lib/scratch';
import { listeningPorts } from '../lib/ports';
import {
  discoverPorts,
  filterHttp,
  frameBlock,
  isLoopbackUrl,
  winListeners,
  type PreviewPort,
} from '../lib/preview';
import { findScriptGroups, resolveRunLine } from '../lib/dev-script';
import { ensureProxy } from '../lib/preview-proxy';
import { defaultResolveRepo } from './bridge';

// How much scrollback to scan per PTY. A dev server's banner is near the top of
// its own output but can be a long way up an agent PTY's, and history is
// text — 4k lines is cheap to scan and covers a busy session.
const HISTORY_LINES = 4000;

// The frame check must not become a way to hang a request: a loopback host that
// accepts the connection and then says nothing would otherwise stall until the
// platform's default socket timeout.
const FRAME_TIMEOUT_MS = 3000;

// Enough for the usual one-or-two-hop local auth bounce, small enough that a
// redirect loop costs a couple of requests rather than the whole timeout.
const MAX_FRAME_REDIRECTS = 3;

export interface PreviewRouteDeps {
  resolveRepo?: (projectId: string) => string | null | Promise<string | null>;
  dialFn?: typeof dial;
  listPortsFn?: typeof listeningPorts;
  // Injected so a test can assert the panel's states without a live listener.
  probeFn?: (port: number) => Promise<boolean>;
  fetchFn?: typeof fetch;
  // win32 machine-wide listeners (netstat). Injected so tests never shell out.
  machinePortsFn?: typeof winListeners;
}

export default async function previewRoutes(f: FastifyInstance, deps: PreviewRouteDeps = {}) {
  const resolveRepo = deps.resolveRepo ?? defaultResolveRepo;
  const listPorts = deps.listPortsFn ?? listeningPorts;
  const dialFn = deps.dialFn ?? dial;

  // Same preference order as routes/git.ts portsDir: the live ledger knows the
  // PTY's REAL spawn cwd, which is the only thing that's right for a worktree
  // session. resolveRepo is the fallback for a tab with no live PTY.
  async function targetDir(project: string | undefined, pty: string | undefined): Promise<string | null> {
    if (pty) {
      const entry = (await readEntries().catch(() => [])).find((e) => e.ptyId === pty);
      if (entry?.cwd) return entry.cwd;
    }
    return project ? await resolveRepo(project) : null;
  }

  // Scrollback for the session's own PTYs: the agent plus every scratch shell
  // it owns. The scratch shells matter MORE than the agent here — `npm run dev`
  // started from the browser panel runs in one of them — and events-hub
  // deliberately never attaches to a scratch, so this is a pull, not a tap.
  async function sessionHistories(ptyId: string | undefined): Promise<string[]> {
    if (!ptyId) return [];
    const map: ScratchMap = await readScratchMap().catch(() => ({}));
    const ids = [ptyId, ...Object.keys(map).filter((id) => map[id]?.ownerPtyId === ptyId)];
    let conn = null;
    try {
      conn = await dialFn();
      const out = await Promise.all(
        // An older daemon has no `history` method and errors; a dead PTY errors
        // too. Neither is a reason to fail the whole request — degrade to the
        // process-derived ports (or, on win32, to the empty state).
        ids.map((id) =>
          conn!
            .history(id, HISTORY_LINES)
            .then((r: { data: string }) => r.data ?? '')
            .catch(() => ''),
        ),
      );
      return out.filter(Boolean);
    } catch {
      return []; // daemon down — the panel still renders, just with nothing found
    } finally {
      conn?.close();
    }
  }

  f.get<{ Querystring: { project?: string; pty?: string } }>('/api/preview/ports', async (req, reply) => {
    const { project, pty } = req.query;
    const dir = await targetDir(project, pty);
    if (!dir) {
      reply.code(404);
      return { error: 'project not found' };
    }
    // machinePorts is the win32 answer to "my dev server was started in VSCode":
    // the scrollback scrape only ever sees servers started inside a seshmux
    // session, which is not how most people run their app. [] off win32, where
    // lsof already answers a strictly better question.
    const [processPorts, histories, listeners] = await Promise.all([
      listPorts(dir).catch(() => []),
      sessionHistories(pty),
      (deps.machinePortsFn ?? winListeners)().catch(() => []),
    ]);
    // Two filters before these reach the chooser. HTTP, because a netstat sweep
    // is mostly Postgres/SSH/language servers and this is a browser. And our own
    // port, because seshmux rendered inside seshmux is a funhouse mirror, not a
    // preview — it is the one port guaranteed to be listening and guaranteed to
    // be wrong.
    const selfPort = Number(process.env.PORT) || 0;
    const machinePorts = (await filterHttp(listeners.filter((l) => l.port !== selfPort)).catch(() => [])).slice();
    const ports: PreviewPort[] = await discoverPorts({
      processPorts,
      histories,
      machinePorts,
      probe: deps.probeFn,
    });
    return { ports, dir };
  });

  f.get<{ Querystring: { project?: string; pty?: string } }>('/api/preview/scripts', async (req, reply) => {
    const { project, pty } = req.query;
    const dir = await targetDir(project, pty);
    if (!dir) {
      reply.code(404);
      return { error: 'project not found' };
    }
    return { groups: await findScriptGroups(dir).catch(() => []), dir };
  });

  /**
   * Start a dev server: spawn a scratch shell in the session's cwd and type the
   * command into it.
   *
   * Deliberately a REAL terminal rather than a detached child. The shell shows
   * up in the same right-pane strip as the browser panel, so its output, its
   * errors and its ^C are all where the user can reach them — a dev server the
   * user cannot see or stop is a worse outcome than one that failed to start.
   * `fresh: true` for the same reason: this must never hijack the shell someone
   * already has a command running in.
   *
   * The command is built server-side from the repo's own package.json
   * (resolveRunLine, fail-closed) — the request names a script, never a
   * command line. See lib/dev-script.ts.
   */
  f.post('/api/preview/run', async (req, reply) => {
    const b = (req.body ?? {}) as { ownerPtyId?: unknown; subdir?: unknown; script?: unknown };
    const ownerPtyId = typeof b.ownerPtyId === 'string' ? b.ownerPtyId : '';
    const script = typeof b.script === 'string' ? b.script : '';
    const subdir = typeof b.subdir === 'string' ? b.subdir : '';
    if (!ownerPtyId || !script) return reply.code(400).send({ error: 'ownerPtyId and script are required' });

    const dir = await targetDir(undefined, ownerPtyId);
    if (!dir) return reply.code(400).send({ error: 'no live session for ' + ownerPtyId });

    const resolved = await resolveRunLine(dir, subdir, script);
    if (!resolved) {
      // Not "forbidden": from the client's side the pick simply is not a script
      // this repo declares (stale panel, edited package.json, bad subdir).
      return reply.code(400).send({ error: `no such dev script: ${subdir ? subdir + '/' : ''}${script}` });
    }

    let conn = null;
    try {
      // fresh:true never re-adopts, so `existing` from startScratchTerminal is
      // always false here — not worth returning a field that cannot vary.
      const { ptyId } = await startScratchTerminal(ownerPtyId, { dialFn, fresh: true });
      conn = await dialFn();
      await conn.write(ptyId, resolved.command + '\r');
      return { ptyId, command: resolved.command };
    } catch (e) {
      const msg = (e as Error).message;
      const client = msg.includes('owner session not found') || msg.includes('cwd no longer exists');
      return reply.code(client ? 400 : 500).send({ error: msg });
    } finally {
      conn?.close();
    }
  });

  /**
   * A loopback origin that serves `port`'s app without its framing headers.
   *
   * The panel calls this only after /frame reports the app blocks embedding.
   * Idempotent per target port, so re-loading a blocked app reuses the same
   * proxy and the iframe is not torn down.
   *
   * The port is bounded to something actually listening for this session (the
   * same discovery the panel renders), so this cannot be pointed at an
   * arbitrary port to have seshmux relay it.
   */
  f.post('/api/preview/proxy', async (req, reply) => {
    const body = (req.body ?? {}) as { port?: unknown };
    const port = typeof body.port === 'number' ? body.port : Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return reply.code(400).send({ error: 'a valid port is required' });
    }
    if (port === (Number(process.env.PORT) || 0)) {
      return reply.code(400).send({ error: 'refusing to proxy seshmux itself' });
    }
    try {
      return await ensureProxy(port);
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  /**
   * Does this URL answer, and will it render in an iframe?
   *
   * Loopback-only (isLoopbackUrl): this endpoint makes the server fetch a
   * client-supplied URL, so without that guard it is an SSRF hole pointed at
   * whatever the user's machine can reach.
   */
  f.get<{ Querystring: { url?: string } }>('/api/preview/frame', async (req, reply) => {
    const url = req.query.url ?? '';
    if (!isLoopbackUrl(url)) return reply.code(400).send({ error: 'loopback http(s) urls only' });
    const doFetch = deps.fetchFn ?? fetch;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FRAME_TIMEOUT_MS);
    try {
      // Follow redirects BY HAND rather than with redirect:'follow'. The headers
      // that matter belong to the document the iframe ends up rendering, and a
      // local app that bounces / -> /login (Next middleware, Rails, Django)
      // almost never puts XFO on the 302 itself — reading the redirect's headers
      // would report "not blocked" for a page that blanks. Manual so every hop
      // stays loopback-checked: redirect:'follow' would let the first response
      // send the server anywhere, reopening the SSRF hole isLoopbackUrl closes.
      let target = url;
      let res: Response | null = null;
      for (let hop = 0; hop <= MAX_FRAME_REDIRECTS; hop++) {
        // GET, not HEAD: plenty of dev servers 405 a HEAD and would read as dead.
        // The body is never consumed — abort() in `finally` drops it.
        res = await doFetch(target, { signal: ac.signal, redirect: 'manual' });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!location) break;
        const next = new URL(location, target).toString();
        // A redirect off loopback is not something we chase, and not something
        // the panel can show. Report the redirect itself and let the iframe try.
        if (!isLoopbackUrl(next)) break;
        target = next;
      }
      return { reachable: true, status: res!.status, blocked: frameBlock(res!.headers) };
    } catch {
      return { reachable: false, status: 0, blocked: null };
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
  });
}

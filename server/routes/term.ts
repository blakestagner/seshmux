// Terminal bridge: browser xterm.js <-> seshmuxd PTYs.
//
//   WS   /ws/term/:ptyId                    binary/text passthrough to one PTY
//   POST /api/sessions/start                spawn an agent session, returns {ptyId, tabMeta}
//   GET  /api/sessions/live                 daemon list() mapped for rail live dots
//   GET  /api/term/:ptyId/status-explain    needs-input classify evidence (Spec 6)
//
// All are guarded by the onRequest auth hook in server/index.ts (they live under
// /api/ and /ws/). argv comes ONLY from provider.commands (hard rule 3) — no
// agent binary names here.

import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { DaemonConnection, dial, withTimeout } from '../daemon-client';
import { getProviders, type ProviderId } from '../lib/providers/types';
import { startSession } from '../session-start';
import type { StatusExplain } from '../events-hub';

// Spec 6: injected like bridge's startSession — keeps this route hermetically
// testable (fake getStatusExplain) without standing up the real events-hub.
export interface TermRouteDeps {
  getStatusExplain?: (ptyId: string) => StatusExplain | null;
  // Injected for hermetic WS tests (fake daemon); defaults to the real dial.
  dialFn?: typeof dial;
  // BUG A part 2 (reload enrichment): cwd -> newest session id, so a rehydrated
  // live tab can arm the subagent chip immediately instead of waiting on a
  // session-new/touch event. Injectable for hermetic tests (mirrors bridge.ts's
  // defaultResolveLatest injection pattern); defaults to the real provider scan.
  resolveSessionForCwd?: (cwd: string) => Promise<string | undefined>;
}

// cwd -> projectId (match against scanned providers' project.path, same join
// key session-new/touch events carry) -> newest session id (bridge.ts's
// defaultResolveLatest logic, reused rather than re-invented). Never throws —
// callers treat "no match" as "omit sessionId", not a route failure.
export async function defaultResolveSessionForCwd(cwd: string): Promise<string | undefined> {
  try {
    const providers = await getProviders();
    for (const p of providers) {
      const projects = await p.scanProjects().catch(() => []);
      const proj = projects.find((pr) => pr.path === cwd);
      if (!proj) continue;
      const sessions = await p.listSessions(proj.id).catch(() => []);
      let best: { id: string; mtime: number } | null = null;
      for (const s of sessions) {
        if (!best || s.mtime > best.mtime) best = { id: s.id, mtime: s.mtime };
      }
      if (best) return best.id;
    }
  } catch {
    /* omit sessionId — never fail the live route over enrichment */
  }
  return undefined;
}

type Mode = 'new' | 'continue' | 'plan';

interface StartBody {
  projectPath: string;
  provider: ProviderId;
  mode: Mode;
  resumeId?: string;
  firstPrompt?: string;
}

// SECURITY (argv injection): projectPath + resumeId are client-supplied and end up as
// positional argv values passed to the agent CLI via provider.commands. A value whose
// FIRST char is `-` would be parsed as a FLAG — e.g. resumeId `--dangerously-skip-permissions`.
// node-pty spawns without a shell and argv is an array, so leading-dash is the ONLY vector
// (a mid-string `-x` stays a harmless positional). Reject it at this boundary; the `--`
// end-of-options shield is defense-in-depth and belongs in provider.commands (providers/),
// not here (hard rule 3). Pure + unit-tested (mirrors ensure.classify).
export async function validateStart(body: {
  projectPath?: unknown;
  provider?: unknown;
  resumeId?: unknown;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { projectPath, provider, resumeId } = body;
  if (typeof provider !== 'string' || !provider) return { ok: false, error: 'provider is required' };
  if (typeof projectPath !== 'string' || !projectPath) {
    return { ok: false, error: 'projectPath is required' };
  }
  // Absolute + existing dir: kills the path flag-vector (absolute paths can't start with `-`)
  // and rejects a bogus cwd early. Also the cwd codex passes as `-C <cwd>` is covered.
  if (!path.isAbsolute(projectPath)) {
    return { ok: false, error: 'projectPath must be an absolute path' };
  }
  let st;
  try {
    st = await stat(projectPath);
  } catch {
    return { ok: false, error: `repo folder no longer exists: ${projectPath}` };
  }
  if (!st.isDirectory()) return { ok: false, error: 'projectPath must be a directory' };
  if (resumeId !== undefined) {
    if (typeof resumeId !== 'string') return { ok: false, error: 'resumeId must be a string' };
    if (/^-/.test(resumeId)) return { ok: false, error: 'resumeId may not start with "-"' };
  }
  return { ok: true };
}

export default async function termRoutes(f: FastifyInstance, deps: TermRouteDeps = {}) {
  // POST /api/sessions/start
  f.post('/api/sessions/start', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<StartBody>;
    const valid = await validateStart(body);
    if (!valid.ok) return reply.code(400).send({ error: valid.error });
    // validateStart guarantees these are non-empty strings.
    const projectPath = body.projectPath as string;
    const providerId = body.provider as ProviderId;
    const mode = (body.mode ?? 'new') as Mode;
    const resumeId = typeof body.resumeId === 'string' ? body.resumeId : undefined;
    const firstPrompt = typeof body.firstPrompt === 'string' && body.firstPrompt.trim() ? body.firstPrompt : undefined;

    // Shared spawn path (argv-from-provider, tmux tier, monitor tracking).
    try {
      return await startSession({ projectPath, provider: providerId, mode, resumeId, firstPrompt });
    } catch (e) {
      const msg = (e as Error).message;
      // provider/plan-mode errors are client faults; daemon errors are 500.
      const client = msg.startsWith('unknown provider') || msg.includes('no plan mode');
      return reply.code(client ? 400 : 500).send({ error: msg });
    }
  });

  // GET /api/sessions/live -> live PTYs mapped by cwd (feeds rail live dots).
  f.get('/api/sessions/live', async (_req, reply) => {
    const resolveSessionForCwd = deps.resolveSessionForCwd ?? defaultResolveSessionForCwd;
    let conn: DaemonConnection | null = null;
    try {
      conn = await (deps.dialFn ?? dial)();
      const { ptys } = await conn.list();
      const alive = ptys.filter((p) => p.alive);
      const live = await Promise.all(
        alive.map(async (p) => ({
          ptyId: p.ptyId,
          cwd: p.cwd,
          tmuxName: p.tmuxName,
          sessionId: await resolveSessionForCwd(p.cwd),
        })),
      );
      return { live };
    } catch {
      // Daemon not up yet → no live sessions, not an error for the rail.
      return reply.send({ live: [] });
    } finally {
      if (conn) conn.close();
    }
  });

  // GET /api/term/:ptyId/status-explain — Spec 6: "why is the dot this color."
  // Latest classify evidence for the PTY (no history — see StatusExplain doc).
  // No injected getStatusExplain (e.g. hub not wired) → 501, distinct from the
  // 404 an unknown/never-classified ptyId gets.
  f.get<{ Params: { ptyId: string } }>('/api/term/:ptyId/status-explain', async (req, reply) => {
    if (!deps.getStatusExplain) return reply.code(501).send({ error: 'status-explain unavailable' });
    const { ptyId } = req.params;
    const explain = deps.getStatusExplain(ptyId);
    if (!explain) return reply.code(404).send({ error: `no classify evidence for ptyId ${ptyId}` });
    return reply.send(explain);
  });

  // GET /api/term/:ptyId/history — "fetch history": deep width-correct
  // scrollback via the daemon's additive history RPC (tmux capture-pane;
  // ring-buffer fallback). Older daemons without the method → 501, so the UI
  // can hide the affordance instead of erroring.
  f.get<{ Params: { ptyId: string }; Querystring: { lines?: string } }>(
    '/api/term/:ptyId/history',
    async (req, reply) => {
      const lines = Number(req.query.lines) || 2000;
      let conn: DaemonConnection | null = null;
      try {
        conn = await (deps.dialFn ?? dial)();
        const { data } = await withTimeout(conn.history(req.params.ptyId, lines), 5000, 'history timed out');
        return reply.send({ data });
      } catch (e) {
        const msg = (e as Error).message || String(e);
        return reply.code(msg.includes('unknown method') ? 501 : 500).send({ error: msg });
      } finally {
        conn?.close();
      }
    },
  );

  // WS /ws/term/:ptyId — one daemon connection per browser socket.
  // ?replay=0 → attach WITHOUT the raw ring-buffer replay: the client fetches
  // a width-correct capture-pane snapshot via /history instead (raw bytes
  // recorded at other widths are what garbled reattaches).
  f.get<{ Params: { ptyId: string }; Querystring: { replay?: string } }>(
    '/ws/term/:ptyId',
    { websocket: true },
    async (socket: WebSocket, req) => {
      const { ptyId } = req.params as { ptyId: string };
      const wantReplay = (req.query as { replay?: string }).replay !== '0';

      // EXIT-FRAME SEMANTICS: {t:'exit'} means THE PTY DIED — the client
      // permanently stops reconnecting on it (ws-term sawExit). Transport
      // failures (daemon unreachable, attach timeout under a grid-mount burst
      // of N concurrent attaches, daemon connection drop) must close BARE so
      // the client's reconnect/backoff path retries against a live PTY.
      let daemon: DaemonConnection;
      try {
        // dial() bounds connect + hello with a 1500ms timeout and cleans up on
        // failure, so a daemon that accepts the socket but never replies can't
        // hang this WS connection open forever.
        daemon = await (deps.dialFn ?? dial)();
      } catch {
        socket.close(); // transport — no exit frame
        return;
      }

      // The daemon BROADCASTS events to every connection — filter to our ptyId,
      // else another PTY's output bleeds into this terminal.
      daemon.onEvent((e) => {
        if (e.ptyId !== ptyId) return;
        if (socket.readyState !== socket.OPEN) return;
        if (e.event === 'data') socket.send(JSON.stringify({ t: 'out', data: e.data }));
        else if (e.event === 'exit') socket.send(JSON.stringify({ t: 'exit', code: e.code }));
      });
      daemon.onClose(() => {
        // Daemon connection dropped (daemon restart) — the PTY may well still
        // be alive (tmux tier). Transport: close bare, let the client retry.
        if (socket.readyState === socket.OPEN) socket.close();
      });

      // Tell the browser the PTY's CURRENT geometry before the scrollback
      // replay: if the pane's fitted size differs, it resets + re-sizes for a
      // clean tmux redraw instead of painting replayed lines at the wrong width.
      try {
        const { ptys } = await withTimeout(daemon.list(), 1500, 'daemon list timed out');
        const me = ptys.find((p) => p.ptyId === ptyId) as { cols?: number; rows?: number } | undefined;
        if (me?.cols && me?.rows && socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ t: 'size', cols: me.cols, rows: me.rows }));
        }
      } catch {
        /* geometry is best-effort — attach still works without it */
      }

      // Attach subscribes this connection + replays scrollback to it alone.
      // Bounded so a non-responsive daemon can't hang the handler.
      try {
        await withTimeout(daemon.attach(ptyId, wantReplay), 1500, 'daemon attach timed out');
      } catch (err) {
        // Timeout = transport (a busy daemon replaying N scrollbacks) — close
        // bare, client retries. Anything else is the daemon REJECTING the
        // attach (unknown/dead ptyId) — that PTY is genuinely gone: send exit.
        if (!String(err).includes('timed out')) {
          try {
            socket.send(JSON.stringify({ t: 'exit', code: -1 }));
          } catch {
            /* ignore */
          }
        }
        socket.close();
        daemon.close();
        return;
      }

      socket.on('message', (raw: Buffer) => {
        let msg: { t?: string; data?: string; cols?: number; rows?: number };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.t === 'in' && typeof msg.data === 'string') {
          daemon.write(ptyId, msg.data).catch(() => {});
        } else if (msg.t === 'resize' && msg.cols && msg.rows) {
          daemon.resize(ptyId, msg.cols, msg.rows).catch(() => {});
        }
      });

      socket.on('close', () => daemon.close());
    },
  );
}

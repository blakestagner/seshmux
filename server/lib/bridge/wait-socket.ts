// Transport for the MCP bridge `wait_for_status` verb (Spec 5). Mirrors
// approval-socket.ts exactly: the mcp-bridge process (spawned by claude/codex,
// no web token — see approval-socket.ts) cannot call events-hub.waitForStatus
// in-process, because the hub lives in the WEB SERVER process. So this is a
// second server-owned unix socket the mcp-bridge process dials as a plain
// client, same fail-safe posture as approval.
//
// Transport: a unix socket (`wait.sock` in the config dir), newline-delimited JSON.
//   - The WEB SERVER owns the LISTENER — `onRequest` resolves {project, session}
//     to a live ptyId (same repo-resolution + cwd-match the REST /api/bridge/wait
//     route uses) and calls hub.waitForStatus, which is already fail-safe
//     (never throws, resolves 'timeout' at the cap — see events-hub.ts).
//   - The mcp-bridge is the CLIENT: one connection per request. FAIL-SAFE: any
//     transport error (no listener, EOF, malformed reply) resolves as a timeout
//     result rather than throwing — wait_for_status's own contract is "never
//     throws, agents handle it as data" (Spec 5 design), so a transport hiccup
//     degrades to the same shape a real timeout would.
//
// Protocol (v:1):
//   request  (client → server): {v:1, project, session, status, timeoutSec}
//   response (server → client): {status: 'working'|'waiting'|'idle'|'timeout', error?: string}

import { createServer, createConnection, type Server } from 'node:net';
import type { NIStatus } from '../needs-input';
import { listenWithStaleRecovery } from './socket-listen';
import { ipcPath } from '../ipc';

export interface WaitRequest {
  project: string;
  session?: string; // 'latest' sentinel or a real sessionId; omitted = the caller's own project default
  status: NIStatus;
  timeoutSec?: number;
}

export interface WaitResult {
  status: NIStatus | 'timeout';
  error?: string;
}

export interface WaitListener {
  close(): Promise<void>;
}

export interface WaitListenerOpts {
  socketPath: string;
  // Injection point: server binds this to "resolve project/session -> ptyId,
  // then hub.waitForStatus(ptyId, status, timeoutSec)".
  onRequest: (req: WaitRequest) => Promise<WaitResult>;
}

export async function startWaitListener(opts: WaitListenerOpts): Promise<WaitListener> {
  const server: Server = createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', async (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return; // wait for a full line
      const line = buf.slice(0, nl);
      conn.removeAllListeners('data'); // one request per connection

      let req: (WaitRequest & { v?: number }) | null = null;
      try {
        req = JSON.parse(line);
      } catch {
        req = null;
      }
      if (!req || typeof req.project !== 'string' || typeof req.status !== 'string') {
        conn.end(JSON.stringify({ status: 'timeout', error: 'malformed request' } as WaitResult) + '\n');
        return;
      }

      let result: WaitResult;
      try {
        result = await opts.onRequest(req);
      } catch (err) {
        result = { status: 'timeout', error: err instanceof Error ? err.message : String(err) };
      }
      try {
        conn.end(JSON.stringify(result) + '\n');
      } catch {
        /* client already gone */
      }
    });
    conn.on('error', () => conn.destroy());
  });

  await listenWithStaleRecovery(server, opts.socketPath);

  return {
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// Client: send one wait request, await the reply. FAIL-SAFE on every error path —
// resolves {status:'timeout'} rather than throwing (matches wait_for_status's own
// "never throws" contract).
export function requestWaitOverSocket(socketPath: string, req: WaitRequest): Promise<WaitResult> {
  return new Promise<WaitResult>((resolve) => {
    let settled = false;
    const done = (result: WaitResult) => {
      if (settled) return;
      settled = true;
      try {
        conn.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const conn = createConnection(ipcPath(socketPath));
    let buf = '';

    // Backstop: cap the client's own wait so a hung/absent server can't stall the
    // MCP process forever. A little above the request's own cap (events-hub caps
    // waitForStatus at 600s) so the server's own timeout resolution wins normally.
    const capMs = Math.min(Math.max(1, req.timeoutSec ?? 120), 600) * 1000 + 5_000;
    const backstop = setTimeout(() => done({ status: 'timeout' }), capMs);
    conn.setEncoding('utf8');

    conn.on('connect', () => {
      conn.write(JSON.stringify({ v: 1, ...req }) + '\n');
    });
    conn.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(backstop);
      try {
        const reply = JSON.parse(buf.slice(0, nl));
        done(reply && typeof reply.status === 'string' ? reply : { status: 'timeout' });
      } catch {
        done({ status: 'timeout' });
      }
    });
    conn.on('error', () => {
      clearTimeout(backstop);
      done({ status: 'timeout' });
    });
    conn.on('close', () => {
      clearTimeout(backstop);
      done({ status: 'timeout' });
    });
  });
}

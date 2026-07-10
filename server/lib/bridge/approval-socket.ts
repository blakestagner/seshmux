// Approval transport for the MCP bridge (Task 16.7 approval flow). The mcp-bridge stdio
// process — spawned by claude/codex, with NO web token (token never touches disk, rule 6.5)
// — must block an ask_codex/ask_claude call until a human approves it in the seshmux UI.
//
// Transport: a unix socket (`approval.sock` in the config dir), newline-delimited JSON.
//   - The WEB SERVER owns the LISTENER (it restarts on update; a mid-approval failure is a
//     clean deny, since bridged calls are retryable). lead-daemon wires `onRequest` to the
//     events hub (broadcast an approval toast, await the UI's reply).
//   - The mcp-bridge is the CLIENT: one connection per request, and FAIL-CLOSED — ANY error
//     (no listener, EOF, malformed reply, timeout) resolves to DENY. Fail-closed is the
//     security property: a silent approve on an error path would defeat the whole guardrail.
//
// Protocol (v:1):
//   request  (client → server): {v:1, requestId, tool, question, cwd, hop}
//   response (server → client): {requestId, approved: boolean}

import { createServer, createConnection, type Server } from 'node:net';
import { listenWithStaleRecovery } from './socket-listen';

// Spec 5: wait_for_status / read_terminal reuse this SAME approval flow (reading
// or blocking on another agent's session is a cross-agent action too) — the
// union widens accordingly, no new transport.
export interface ApprovalRequest {
  requestId: string;
  tool: 'ask_codex' | 'ask_claude' | 'wait_for_status' | 'read_terminal';
  question: string;
  cwd: string;
  hop: number;
}

export interface ApprovalListener {
  close(): Promise<void>;
}

// What the listener hands to onRequest: the request plus the deadline it will enforce, so
// the UI toast can show a countdown / auto-dismiss. `expiresAt` is epoch ms.
export interface ApprovalDecisionInfo extends ApprovalRequest {
  expiresAt: number;
}

export interface ApprovalListenerOpts {
  socketPath: string;
  // Injection point: lead-daemon binds this to "broadcast on events-ws + await UI reply".
  // Resolves true=approve / false=deny. May never resolve — the timeout below denies.
  onRequest: (info: ApprovalDecisionInfo) => Promise<boolean>;
  timeoutMs?: number; // default 120s — server-side deadline → deny
  now?: () => number; // clock for expiresAt (defaults to Date.now — plain server code)
}

const DEFAULT_TIMEOUT_MS = 120_000;
const CLIENT_BACKSTOP_MS = 125_000; // slightly > server timeout, so the server's deny wins

export async function startApprovalListener(opts: ApprovalListenerOpts): Promise<ApprovalListener> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const server: Server = createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', async (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return; // wait for a full line
      const line = buf.slice(0, nl);
      conn.removeAllListeners('data'); // one request per connection

      let req: ApprovalRequest | null = null;
      try {
        req = JSON.parse(line);
      } catch {
        req = null;
      }
      if (!req || typeof req.requestId !== 'string') {
        conn.end(); // malformed → drop; client's own error path denies
        return;
      }

      // Race the human decision against the server-side timeout → deny on timeout.
      // expiresAt tells the UI when this window closes (for the toast countdown). Only the
      // contract fields are forwarded (drop the wire-level `v` + any extras), so the
      // events-ws broadcast gets exactly the documented shape.
      const now = opts.now ? opts.now() : Date.now();
      const info: ApprovalDecisionInfo = {
        requestId: req.requestId,
        tool: req.tool,
        question: req.question,
        cwd: req.cwd,
        hop: req.hop,
        expiresAt: now + timeoutMs,
      };
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<boolean>((res) => {
        timer = setTimeout(() => res(false), timeoutMs);
      });
      let approved = false;
      try {
        approved = await Promise.race([opts.onRequest(info), timeout]);
      } catch {
        approved = false; // onRequest threw → deny
      } finally {
        clearTimeout(timer!);
      }

      try {
        conn.end(JSON.stringify({ requestId: req.requestId, approved }) + '\n');
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

// Client: send one approval request, await the reply. FAIL-CLOSED on every error path.
export function requestApprovalOverSocket(
  socketPath: string,
  info: ApprovalRequest,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (approved: boolean) => {
      if (settled) return;
      settled = true;
      try {
        conn.destroy();
      } catch {
        /* ignore */
      }
      resolve(approved);
    };

    const conn = createConnection(socketPath);
    let buf = '';

    // Backstop: if the server never replies (and never EOFs), deny after a hard deadline.
    const backstop = setTimeout(() => done(false), CLIENT_BACKSTOP_MS);
    conn.setEncoding('utf8');

    conn.on('connect', () => {
      conn.write(JSON.stringify({ v: 1, ...info }) + '\n');
    });
    conn.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(backstop);
      try {
        const reply = JSON.parse(buf.slice(0, nl));
        done(reply && reply.approved === true); // only an explicit true approves
      } catch {
        done(false); // malformed reply → deny
      }
    });
    conn.on('error', () => {
      clearTimeout(backstop);
      done(false); // connection refused / reset → deny
    });
    conn.on('close', () => {
      clearTimeout(backstop);
      done(false); // EOF before a valid reply → deny
    });
  });
}

// Unix-socket client to seshmuxd. DIAL + RECONNECT ONLY — this module never
// spawns or kills the daemon. That split is the update-safety invariant: a
// server restart (update) just drops its daemon sockets; the daemon keeps every
// PTY alive and the new server re-dials + re-attaches. Daemon lifecycle
// (spawn / stale-socket recovery) lives solely in bin/seshmux.js (Task 12/13),
// which runs once per launch, not on server restart.
//
// The wire protocol is COPIED here, never imported from daemon/ (HARD RULE:
// daemon/ is standalone; protocol.js is copied by the server). Keep in sync with
// daemon/protocol.js — protocol is FROZEN at 1 for v1.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const PROTOCOL = 1;

export function configDir(): string {
  return process.env.SESHMUX_CONFIG_DIR || path.join(os.homedir(), '.config', 'seshmux');
}
export function socketPath(): string {
  return path.join(configDir(), 'seshmuxd.sock');
}

/** Encode a message as one NDJSON frame. JSON.stringify escapes embedded '\n'. */
function encode(msg: unknown): string {
  return JSON.stringify(msg) + '\n';
}

/** Stateful line-buffered NDJSON decoder (copy of daemon/protocol.js). */
function createDecoder() {
  let buffer = '';
  return {
    push(chunk: string): unknown[] {
      buffer += chunk;
      const out: unknown[] = [];
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length === 0) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          /* tolerate malformed line */
        }
      }
      return out;
    },
  };
}

export interface DaemonEvent {
  event: 'data' | 'exit';
  ptyId: string;
  data?: string;
  code?: number;
}

type RpcResponse = { id: number; result?: unknown; error?: { message: string } };

/**
 * A single connection to seshmuxd. One instance per consumer:
 *   - one per /ws/term browser socket (so attach() scrollback replays to just
 *     that client), OR
 *   - a short-lived one for a control-plane RPC (spawn / list).
 *
 * NOTE: the daemon BROADCASTS data/exit events to every subscribed connection.
 * Consumers that attach to a specific PTY MUST filter events by ptyId — see
 * onEvent(). This client does not filter for you.
 */
export class DaemonConnection {
  private sock: net.Socket;
  private decoder = createDecoder();
  private nextId = 1;
  private pending = new Map<number, (r: RpcResponse) => void>();
  private eventHandler: ((e: DaemonEvent) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  constructor(sockPath: string = socketPath()) {
    this.sock = net.connect(sockPath);
    this.sock.setEncoding('utf8');
    this.sock.on('data', (chunk: string) => this.onData(chunk));
    this.sock.on('close', () => {
      // Reject every in-flight RPC: a daemon that dies mid-call otherwise hangs
      // its awaiter FOREVER (spawn/list/attach in session-start, bridge wait/
      // peek, mcp read_terminal all bare-await rpc() — the Fastify request never
      // responds and the pending entry leaks). A hang is not a rejection; make
      // it one, here, where every caller routes.
      const pending = [...this.pending.values()];
      this.pending.clear();
      for (const settle of pending) settle({ id: -1, error: { message: 'daemon connection closed' } });
      if (this.closeHandler) this.closeHandler();
    });
    // Swallow socket errors — callers observe failure via connect()/rpc rejection.
    this.sock.on('error', () => {});
  }

  /** Resolves once connected, rejects on the first connect error. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Already connected (readyState 'open')? resolve immediately.
      if ((this.sock as unknown as { readyState: string }).readyState === 'open') {
        resolve();
        return;
      }
      const onConnect = () => {
        this.sock.removeListener('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        this.sock.removeListener('connect', onConnect);
        reject(err);
      };
      this.sock.once('connect', onConnect);
      this.sock.once('error', onError);
    });
  }

  private onData(chunk: string) {
    for (const msg of this.decoder.push(chunk)) {
      const m = msg as RpcResponse & Partial<DaemonEvent>;
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
        const resolve = this.pending.get(m.id);
        if (resolve) {
          this.pending.delete(m.id);
          resolve(m as RpcResponse);
        }
      } else if (m.event !== undefined) {
        if (this.eventHandler) this.eventHandler(m as DaemonEvent);
      }
    }
  }

  /** Register the pushed-event sink. Caller MUST filter by ptyId. */
  onEvent(fn: (e: DaemonEvent) => void) {
    this.eventHandler = fn;
  }
  onClose(fn: () => void) {
    this.closeHandler = fn;
  }

  /** Send a JSON-RPC request and await the matching response. */
  rpc(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // A destroyed socket's close event already flushed pending — an entry
      // added now would never settle. Reject up front.
      if (this.sock.destroyed) {
        reject(new Error('daemon connection closed'));
        return;
      }
      this.pending.set(id, (r) => {
        if (r.error) reject(new Error(r.error.message));
        else resolve(r.result);
      });
      this.sock.write(encode({ id, method, params }));
    });
  }

  hello() {
    return this.rpc('hello') as Promise<{ protocol: number; version: string; ptyCount: number }>;
  }
  spawn(params: { cwd?: string; args: string[]; cols?: number; rows?: number; tmuxName?: string }) {
    return this.rpc('spawn', params) as Promise<{ ptyId: string }>;
  }
  attach(ptyId: string, fromScrollback = true) {
    return this.rpc('attach', { ptyId, fromScrollback }) as Promise<{ ptyId: string }>;
  }
  write(ptyId: string, data: string) {
    return this.rpc('write', { ptyId, data });
  }
  resize(ptyId: string, cols: number, rows: number) {
    return this.rpc('resize', { ptyId, cols, rows });
  }
  kill(ptyId: string) {
    return this.rpc('kill', { ptyId });
  }
  list() {
    return this.rpc('list') as Promise<{
      // cols/rows: additive daemon fields (older daemons omit them).
      ptys: { ptyId: string; cwd: string; args: string[]; tmuxName: string | null; alive: boolean; cols?: number; rows?: number }[];
    }>;
  }
  /** Additive daemon method ("fetch history"): deep width-correct history via
   *  tmux capture-pane (ring-buffer fallback). Older daemons reply with an
   *  unknown-method error — callers must degrade gracefully. */
  history(ptyId: string, lines?: number) {
    return this.rpc('history', { ptyId, lines }) as Promise<{ data: string }>;
  }

  close() {
    this.sock.destroy();
  }
}

/** Open a connection, await connect, hello-handshake within `timeoutMs`. */
export async function dial(
  sockPath: string = socketPath(),
  timeoutMs = 1500,
): Promise<DaemonConnection> {
  const conn = new DaemonConnection(sockPath);
  try {
    await withTimeout(conn.connect(), timeoutMs, 'daemon connect timed out');
    await withTimeout(conn.hello(), timeoutMs, 'daemon hello timed out');
  } catch (e) {
    conn.close(); // don't leak the socket on a timeout/refusal
    throw e;
  }
  return conn;
}

export { withTimeout };

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

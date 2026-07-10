// Minimal terminal WebSocket client: xterm.js <-> /ws/term/:ptyId.
// Terminal-only. Reconnect/backoff and events-ws (status/ctx) belong to
// Tasks 15/16 — not built here.
//
// Wire (matches server/routes/term.ts):
//   client -> {t:'in',data} | {t:'resize',cols,rows}
//   server -> {t:'out',data} | {t:'exit',code}
'use client';

import { authToken } from './api';

export interface TermSocket {
  send(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface TermHandlers {
  onData: (data: string) => void;
  onExit: (code: number) => void;
  onOpen?: () => void;
  // Called just before a RECONNECT re-attaches (server restarted, PTY still
  // alive). The caller should term.reset() so the scrollback replay repaints
  // clean instead of doubling the buffer.
  onReconnect?: () => void;
  // PTY's current geometry, sent by the server before the scrollback replay.
  // Lets the pane detect a width mismatch (replay would paint garbled) and
  // reset + re-size for a clean redraw instead.
  onSize?: (cols: number, rows: number) => void;
}

/**
 * Open a terminal socket that AUTO-RECONNECTS across a server restart (Task 18
 * update-safety at the UI layer). We distinguish two close causes:
 *   • an {t:'exit'} frame arrived  → the PTY actually died → onExit, no reconnect.
 *   • a raw socket close with NO prior exit frame → transport drop (server
 *     restart) → reconnect with backoff; the daemon still holds the PTY, so
 *     attach replays its scrollback.
 */
export function openTermSocket(ptyId: string, handlers: TermHandlers): TermSocket {
  let ws: WebSocket | null = null;
  let closed = false; // caller invoked close()
  let sawExit = false; // an {t:'exit'} frame arrived → real PTY death
  let backoff = 250;
  let firstConnect = true;

  function connect() {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Token as a query param — the auth hook reads it there for WS upgrades. Read
    // it fresh each connect so a token that changed across restart is picked up.
    // replay=0: skip the raw ring-buffer replay — the pane paints a
    // width-correct capture-pane snapshot via /history instead (TerminalPane's
    // attach flow). Raw mixed-width replay bytes are what garbled reattaches.
    const url = `${proto}//${location.host}/ws/term/${encodeURIComponent(ptyId)}?token=${encodeURIComponent(authToken())}&replay=0`;
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      backoff = 250;
      if (firstConnect) {
        firstConnect = false;
        handlers.onOpen?.();
      } else {
        // Reconnect: reset the terminal so scrollback replay doesn't double.
        handlers.onReconnect?.();
      }
    });
    ws.addEventListener('message', (ev) => {
      let msg: { t?: string; data?: string; code?: number; cols?: number; rows?: number };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (msg.t === 'out' && typeof msg.data === 'string') handlers.onData(msg.data);
      else if (msg.t === 'exit') {
        sawExit = true;
        handlers.onExit(msg.code ?? 0);
      } else if (msg.t === 'size' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        handlers.onSize?.(msg.cols, msg.rows);
      }
    });
    ws.addEventListener('close', () => {
      if (closed || sawExit) return; // real death or caller closed → no reconnect
      ws = null;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5000);
    });
    ws.addEventListener('error', () => ws?.close());
  }

  connect();

  const sendJSON = (obj: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  return {
    send: (data) => sendJSON({ t: 'in', data }),
    resize: (cols, rows) => sendJSON({ t: 'resize', cols, rows }),
    close: () => {
      closed = true;
      ws?.close();
    },
  };
}

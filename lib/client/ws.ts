'use client';
// Events WebSocket client — ONE connection multiplexing all live app events
// (status, ctx, session-new/touch, server-restarting). Terminal I/O is a
// SEPARATE per-PTY socket (ws-term.ts); this is the app-wide event bus that
// feeds rail dots, ctx badges, needs-input toasts, and the update flow.
//
// Auto-reconnects with backoff so a server restart (update) is transparent:
// on every (re)connect the server REPLAYS current status for all live PTYs, so
// the UI re-syncs without a page reload.

import { authToken } from './api';

// ── Event shapes (server → client). Published for lead-ui's consumers. ──────────
export type ProviderId = 'claude' | 'codex';
export type NIStatus = 'working' | 'waiting' | 'idle';
export type Ctx = { tokens: number; window: number; pct: number; model: string } | null;

export type EventMessage =
  // needs-input state for a PTY (rail/tab/tile dots, toast). Replayed for ALL
  // live PTYs on every (re)connect, not only on transition.
  | { event: 'status'; ptyId: string; status: NIStatus }
  // live context-window update for a session (rail ctx badge, statusbar meter).
  | { event: 'ctx'; provider: ProviderId; sessionId: string; projectId: string; ctx: Ctx }
  // a new / touched session file appeared (rail live insert + reorder).
  | { event: 'session-new'; provider: ProviderId; sessionId: string; projectId: string }
  | { event: 'session-touch'; provider: ProviderId; sessionId: string; projectId: string }
  // <repo>/.seshmux/handoff.md changed → refetch the open scratchpad tab (16.6).
  | { event: 'scratchpad'; projectId: string }
  // a session's subagent tree changed (new agent file, or an agent progressed).
  // Ping-only — the client refetches GET /api/subagents. Lazily watched once a
  // viewer opens the session (spec: docs/todo/2026-07-10-subagent-viewer.md).
  | { event: 'subagents'; projectId: string; sessionId: string }
  // A team's config.json changed (member joined / isActive flipped) or the team
  // ended (lead exited, config.json removed) — summary only, the client
  // refetches GET /api/teams/members (Task 4). Lazily watched once a client
  // first requests the team's roster.
  | { event: 'team'; teamName: string; leadSessionId: string }
  // Plan-off progress (16.8). The plan RESULT comes from the blocking POST
  // /api/bridge/planoff response; these are lightweight liveness pings so the
  // Planoff tab isn't dead during the minutes-long run. No token streaming
  // (headless jsonl output isn't token-streamable).
  | { event: 'planoff'; planoffId: string; provider: ProviderId; phase: 'started' | 'done' | 'error' }
  // MCP bridge cross-agent call awaiting approval (Task 16.7; wait_for_status /
  // read_terminal added Spec 5 — same approval flow, reading/blocking on
  // another agent's session is a cross-agent action too). The UI shows an
  // approval toast (Allow/Deny → POST /api/bridge/approval/:requestId), auto-
  // dismissing at expiresAt (server denies on the 120s timeout regardless).
  | {
      event: 'approval';
      requestId: string;
      tool: 'ask_codex' | 'ask_claude' | 'wait_for_status' | 'read_terminal';
      question: string;
      cwd: string;
      hop: number;
      expiresAt: number;
    }
  // the server is about to restart for an update (Task 18). The daemon + PTYs
  // survive; the client should show a brief "updating" state and let the
  // auto-reconnect below bring it back.
  | { event: 'server-restarting' };

export interface EventsClient {
  close(): void;
}

/**
 * Open the events WS. `onEvent` receives each decoded EventMessage. Reconnects
 * automatically (250ms→5s backoff) until close() is called. `onOpen` fires on
 * every successful (re)connect — the reliable "server is back" signal: with
 * zero live PTYs the reconnect replays no status events, so an event-based
 * "restarting" reset would never fire and the banner stuck forever.
 */
export function openEventsSocket(onEvent: (e: EventMessage) => void, onOpen?: () => void): EventsClient {
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 250;

  function connect() {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/events?token=${encodeURIComponent(authToken())}`;
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      backoff = 250; // reset on a successful connect
      onOpen?.();
    });
    ws.addEventListener('message', (ev) => {
      let msg: EventMessage;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (msg && typeof (msg as { event?: unknown }).event === 'string') onEvent(msg);
    });
    const reconnect = () => {
      if (closed) return;
      ws = null;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5000);
    };
    ws.addEventListener('close', reconnect);
    ws.addEventListener('error', () => ws?.close());
  }

  connect();
  return {
    close() {
      closed = true;
      ws?.close();
    },
  };
}

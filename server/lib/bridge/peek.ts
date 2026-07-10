// Spec 5 task 2: scrollback peek for the bridge `read_terminal` verb.
//
// Design note (hard rule 4 — daemon protocol frozen at 1, additive only): the
// existing attach RPC already exposes a PTY's full scrollback synchronously on
// attach (daemon/index.js `case 'attach'`, `fromScrollback !== false` branch) —
// it pushes the ring buffer as one `{event:'data',...}` frame before the RPC
// reply. That is exactly "read the last N lines of scrollback." No dedicated
// peek RPC is needed; a short-lived attach + close is the additive-free path.
// (If a future need arises for a peek that does NOT want to also subscribe to
// live output, add a dedicated read-only RPC then — additive method, protocol
// stays 1.)
//
// One wrinkle: the daemon pushes the scrollback replay as an ASYNC event after
// the `attach` RPC resolves (not embedded in the RPC response) — so this must
// register the event handler BEFORE calling attach, then settle briefly before
// reading what arrived (the replay is one synchronous enqueue on the daemon
// side, so a short fixed wait after attach resolves is sufficient — no polling
// loop needed for a single local unix-socket hop).

import { DaemonConnection, dial } from '../../daemon-client';
import { stripAnsi } from '../needs-input';

export const MAX_PEEK_LINES = 500;
const SETTLE_MS = 150;

export interface PeekResult {
  ptyId: string;
  lines: string[];
}

export type DialFn = (sockPath?: string) => Promise<DaemonConnection>;

// Injectable dial + settle delay so tests can run against a real (but fast)
// in-process daemon without a real timer wait, and so callers can point at a
// non-default socket path.
export async function peekTerminal(
  ptyId: string,
  lines = 80,
  deps: { dial?: DialFn; settleMs?: number } = {},
): Promise<PeekResult> {
  const dialFn = deps.dial ?? dial;
  const settleMs = deps.settleMs ?? SETTLE_MS;
  const capped = Math.min(Math.max(1, lines), MAX_PEEK_LINES);

  const conn = await dialFn();
  try {
    let raw = '';
    conn.onEvent((e) => {
      if (e.event === 'data' && e.ptyId === ptyId && typeof e.data === 'string') raw += e.data;
    });
    await conn.attach(ptyId, true);
    // The replay is a single synchronous enqueue on the daemon side (see note
    // above) — a short fixed settle is enough to observe it over the socket.
    await new Promise((r) => setTimeout(r, settleMs));
    return { ptyId, lines: splitLines(raw).slice(-capped) };
  } finally {
    conn.close();
  }
}

// stripAnsi collapses ALL whitespace (including newlines) into single spaces
// (see server/lib/needs-input.ts), so line-splitting must happen on the RAW
// chunk first, THEN strip each line individually — same pattern events-hub
// recordExplain() uses for lastLines.
function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => stripAnsi(l))
    .filter((l) => l.length > 0);
}

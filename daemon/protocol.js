'use strict';
/**
 * seshmuxd JSON-RPC protocol — plain Node JS, ZERO dependencies.
 *
 * This file is COPIED by the server (server/daemon-client.ts), never imported
 * across the daemon/server boundary (plan Task 12 + CLAUDE.md hard rule).
 * Keep it dependency-free and self-contained so a copy stays in sync trivially.
 *
 * Wire format: newline-delimited JSON ("NDJSON"), UTF-8, one message per line,
 * in BOTH directions.
 *
 * Requests  (server -> daemon):  { id, method, params }
 * Responses (daemon -> server):  { id, result }  |  { id, error: { message } }
 * Events    (daemon -> server):  { event, ... }   (no id — pushed, unsolicited)
 *
 * Methods:
 *   hello()                                      -> { protocol, version, ptyCount }
 *   spawn({ cwd, args, cols, rows, tmuxName? })  -> { ptyId }
 *   attach({ ptyId, fromScrollback? })           -> { ptyId }   (+ replays ring buffer as data events)
 *   write({ ptyId, data })                       -> { ok: true }
 *   resize({ ptyId, cols, rows })                -> { ok: true }
 *   kill({ ptyId })                              -> { ok: true }
 *   list()                                       -> { ptys: [{ ptyId, cwd, args, tmuxName, alive }] }
 *   shutdown({ force? })                         -> { ptyCount } (refuses while PTYs alive unless force)
 *
 * Events:
 *   { event: 'data', ptyId, data }
 *   { event: 'exit', ptyId, code }
 */

// Protocol version is FROZEN at 1 for v1. Update-safety depends on this:
// a new server must handshake this exact number against an old daemon.
const PROTOCOL = 1;

// tmux session-name prefix the daemon owns. Callers pass a BARE name; the
// daemon forms `seshmux-<name>`. Rehydration on startup filters on this prefix.
const TMUX_PREFIX = 'seshmux-';

// Per-PTY scrollback ring buffer cap, counted in newlines.
const RING_BUFFER_LINES = 5000;

/**
 * Encode a message object as a single NDJSON frame (trailing newline).
 * JSON.stringify escapes any embedded '\n' (e.g. inside PTY `data`), so a
 * message body can never break framing.
 */
function encode(msg) {
  return JSON.stringify(msg) + '\n';
}

/**
 * Stateful line-buffered decoder. Feed it arbitrary chunks; it returns an
 * array of parsed messages for every COMPLETE line seen so far and retains
 * any partial trailing line for the next feed.
 *
 * This is the #1 correctness point for NDJSON sockets: a single 'data' event
 * may carry a partial message, exactly one, or several.
 */
function createDecoder() {
  let buffer = '';
  return {
    /** @returns {Array<object>} parsed messages (bad lines are skipped) */
    push(chunk) {
      buffer += chunk;
      const out = [];
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length === 0) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // Tolerate malformed lines rather than crash the connection.
        }
      }
      return out;
    },
  };
}

module.exports = {
  PROTOCOL,
  TMUX_PREFIX,
  RING_BUFFER_LINES,
  encode,
  createDecoder,
};

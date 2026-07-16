'use strict';
/**
 * Strip stale terminal QUERY sequences from replayed scrollback.
 *
 * Reattach-correctness (general ANSI/DEC, not an emulator quirk): when a PTY's
 * raw ring buffer is replayed to a freshly-attached terminal, any Device
 * Attributes / Device Status Report queries the agent emitted earlier are still
 * in those bytes. A conformant terminal emulator that SEES such a query AUTO-
 * REPLIES to it (DA1 `ESC[c` -> `ESC[?1;2c`, CPR `ESC[6n` -> cursor report,
 * DA2 `ESC[>c`, ...). During replay that reply is stale — the agent has long
 * since moved on — so it lands as junk typed into the current prompt
 * (`> ?1;2c`). Removing the QUERY from the replayed bytes means the emulator is
 * never provoked, so no stale reply is ever generated. Timing-independent, and
 * it touches only replay/output bytes: live queries still flow untouched, and
 * real user keystrokes are never in scope here.
 *
 * We remove ONLY query sequences (terminators `c` = DA, `n` = DSR). Everything
 * else — cursor show/hide (`h`/`l`), SGR (`m`), erase (`J`/`K`), cursor move
 * (`H`/`A`..), bracketed paste, alt-screen — is left byte-identical.
 */

// CSI queries: ESC [ [private-prefix?] [params] (c|n)
//   DA1  ESC[c / ESC[0c   DA2 ESC[>c   DA3 ESC[=c
//   DSR  ESC[5n / ESC[6n  DEC-DSR ESC[?6n
// The optional [?>=] prefix + digits/semicolons before a `c`/`n` terminator is
// what makes this a query; response-bearing sequences never end in c/n.
const QUERY_RE = /\x1b\[[?>=]?[0-9;]*[cn]/g;

/**
 * @param {string} buf raw scrollback (already joined across ring chunks)
 * @returns {string} buf with stale query sequences removed
 */
function stripTerminalQueries(buf) {
  if (typeof buf !== 'string' || buf.length === 0) return buf;
  return buf.replace(QUERY_RE, '');
}

module.exports = { stripTerminalQueries, QUERY_RE };

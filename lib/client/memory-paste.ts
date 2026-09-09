// Composing a memory pack for delivery into a live PTY.
//
// drop-paths.ts's pasteText is NOT reusable here: it shell-quotes file paths for a command
// line. A memory pack is a multi-line prose block, which brings a problem of its own —
// typing raw newlines at a TUI submits each line as its own message, so a pack sent naively
// would fire N half-messages instead of one.
//
// BRACKETED PASTE solves that. `ESC [ 200 ~` … `ESC [ 201 ~` is how a terminal tells an
// application "everything between these markers is pasted text, not typing", which is
// exactly what happens when a human pastes into Claude Code or Codex today.
//
// It does NOT press Enter. The block is staged in the agent's input for you to read and
// send, which keeps a person between "load memory" and "the agent acts on it" for the cost
// of one keystroke. `submit` is the opt-out for anyone who would rather it just fire.

const ESC = String.fromCharCode(27);
export const PASTE_START = `${ESC}[200~`;
export const PASTE_END = `${ESC}[201~`;
const CR = String.fromCharCode(13);

export interface MemoryPasteOpts {
  /** Press Enter after the block. Default false — see the note above. */
  submit?: boolean;
}

/**
 * Wrap a pack for `sendRef`.
 *
 * Any stray bracketed-paste markers already inside the text are stripped first: a record
 * carrying an END marker would otherwise close the paste early and turn the remainder into
 * live keystrokes. Record text is control-stripped at write time (memory/store.ts), so this
 * is defence in depth rather than the primary guard.
 */
export function memoryPaste(text: string, opts: MemoryPasteOpts = {}): string {
  const body = text.split(PASTE_START).join('').split(PASTE_END).join('').replace(/\s+$/, '');
  if (!body) return '';
  return PASTE_START + body + PASTE_END + (opts.submit ? CR : '');
}

/** Human-readable summary for the dropdown footer: "~420 tok of 1500". */
export function budgetLabel(used: number, budget: number): string {
  return `~${used} tok of ${budget}`;
}

/**
 * Rough token cost of a set of rows, for the live counter.
 *
 * Same ~4-chars-per-token estimate the server's packer uses. The two must agree on the unit
 * or the count you watch while selecting would not predict the block you get.
 */
export function estimateRowTokens(rows: { tokens: number }[]): number {
  return rows.reduce((sum, r) => sum + r.tokens, 0);
}

'use client';

// Lets a right-pane panel write into a terminal it does not own.
//
// A PTY write goes over that terminal's own /ws/term socket, which TerminalPane holds and
// there is no REST equivalent. MemoryPanel renders in the right pane — a sibling of the
// terminal, not a child — so the choice was to lift the socket into page state (which
// would re-render the app around every keystroke) or let the pane publish its writer.
// This is the second: TerminalPane registers while its socket is up, and the panel looks
// the writer up when the user actually clicks Load.
//
// Keyed by ptyId, which is what identifies a live PTY to everything else in the client
// (tab ids are stable across a resume that swaps the PTY underneath, which is the wrong
// lifetime here — a writer belongs to a socket, and a new PTY means a new socket).

type Send = (data: string) => void;

const senders = new Map<string, Send>();

/**
 * Publish this PTY's writer. Returns the unregister function — call it when the socket
 * goes away, which is what makes "is there a sender?" mean "is this terminal writable?".
 */
export function registerTermSend(ptyId: string, send: Send): () => void {
  senders.set(ptyId, send);
  return () => {
    // Only clear if the entry is still OURS. React can mount the replacement before the
    // outgoing effect's cleanup runs (StrictMode does exactly this in dev), and a blind
    // delete would then drop the live writer and leave the panel unable to load.
    if (senders.get(ptyId) === send) senders.delete(ptyId);
  };
}

export function getTermSend(ptyId: string | undefined): Send | undefined {
  return ptyId ? senders.get(ptyId) : undefined;
}

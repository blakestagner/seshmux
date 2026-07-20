'use client';

// Scratch-terminal Stage 5: a thin wrapper over TerminalPane for a plain shell.
// It passes ONLY ptyId + visible — no projectId/sessionId/provider — so every
// piece of agent chrome (bridge menu, subagent/team/changes chips, ctx meter,
// workspace finish) self-gates off: each of those gates on a project or session
// this shell doesn't have. The statusbar collapses to just the live/exited dot,
// which is acceptable for v1. The /ws/term/<ptyId> bridge is reused untouched.
// `visible` drives TerminalPane's fit-on-reveal so the shell re-fits when the
// right-pane tab strip switches back to it (it stays mounted-hidden otherwise).

import TerminalPane from '../TerminalPane/TerminalPane';

export default function ScratchTerminal({ ptyId, visible }: { ptyId: string; visible: boolean }) {
  return <TerminalPane ptyId={ptyId} visible={visible} />;
}

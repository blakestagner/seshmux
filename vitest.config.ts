// Test isolation for tmux: daemon-booting tests (daemon, term-bridge,
// events-hub, peek) run rehydrateTmux at startup. tmux servers are per-user,
// so WITHOUT isolation a test daemon sees the developer's LIVE seshmux-*
// sessions — and since rehydrate ADOPTS unstamped/own sessions (stamping them
// with the test's throwaway config dir), a bare `npm test` could re-own the
// developer's live sessions and orphan them from the real daemon on its next
// restart. TMUX_TMPDIR points every tmux invocation in the test process (and
// the in-process daemons it boots) at a private tmux server instead.
// globalSetup kills that server after the run.
import { defineConfig } from 'vitest/config';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Short path — macOS unix-socket paths (tmux's included) cap ~104 bytes.
const tmuxDir = mkdtempSync(join(tmpdir(), 'smxt-'));
process.env.SESHMUX_TEST_TMUX_TMPDIR = tmuxDir;

export default defineConfig({
  test: {
    globalSetup: './test/global-tmux-isolation.ts',
    env: { TMUX_TMPDIR: tmuxDir },
    // Agent worktrees carry a full copy of test/ — without this exclude a
    // bare `npm test` runs both copies concurrently against the shared real
    // ~/.config/seshmux and they clobber each other.
    exclude: ['**/node_modules/**', '.claude/worktrees/**'],
  },
});

// Teardown for the per-run private tmux server (see vitest.config.ts).
// The isolated server dies with its last session normally; this catches the
// case where a failed test leaks sessions, so /tmp doesn't accumulate live
// tmux servers across runs.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

export function setup() {
  /* TMUX_TMPDIR already set via vitest env — nothing to do */
}

export function teardown() {
  const dir = process.env.SESHMUX_TEST_TMUX_TMPDIR;
  if (!dir) return;
  try {
    execFileSync('tmux', ['kill-server'], {
      stdio: 'ignore',
      env: { ...process.env, TMUX_TMPDIR: dir, TMUX: '', TMUX_PANE: '' },
    });
  } catch {
    /* no server started — fine */
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

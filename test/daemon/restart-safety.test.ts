import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// daemon/ is plain CJS (zero build) — require it.
const require = createRequire(import.meta.url);
const { canSafelyRestartDaemon } = require('../../daemon/ensure.js');

// The update flow restarts the daemon automatically, but a daemon restart KILLS plain-tier PTYs
// (tmux-tier ones rehydrate from `tmux ls`). This predicate is the guard on hard rule 4.
describe('canSafelyRestartDaemon', () => {
  const tmux = (n: string) => ({ ptyId: n, tmuxName: `seshmux-${n}`, alive: true });
  const plain = (n: string) => ({ ptyId: n, tmuxName: null, alive: true });

  it('is safe with no PTYs at all', () => {
    expect(canSafelyRestartDaemon([])).toEqual({ safe: true, plainCount: 0 });
  });

  it('is safe when every live PTY is tmux-backed', () => {
    expect(canSafelyRestartDaemon([tmux('a'), tmux('b')])).toEqual({ safe: true, plainCount: 0 });
  });

  it('is UNSAFE when any live PTY is plain, and counts them', () => {
    expect(canSafelyRestartDaemon([tmux('a'), plain('b'), plain('c')])).toEqual({ safe: false, plainCount: 2 });
  });

  it('ignores dead plain PTYs — they cannot be killed twice', () => {
    expect(canSafelyRestartDaemon([{ ptyId: 'x', tmuxName: null, alive: false }, tmux('a')])).toEqual({
      safe: true,
      plainCount: 0,
    });
  });

  it('treats a missing/undefined list as safe (unreachable daemon reports nothing)', () => {
    expect(canSafelyRestartDaemon(undefined).safe).toBe(true);
  });
});

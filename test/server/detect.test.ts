import { describe, it, expect } from 'vitest';
import { detectEnv } from '../../server/lib/detect';

// Fake runner stubs child_process execFile calls so tests don't depend on the
// machine actually having claude/codex/tmux/rg installed. Store scan (projects)
// is left to the real (empty-in-CI) provider stores, so we only assert on the
// binary-detection fields (found/version) and tmux/rg, never on store.projects.

// server/lib/which.ts's whichBin() runs `where` (not `which`) on win32, and its pickBin()
// requires a runnable extension there (.exe/.cmd/.bat/.com) — a bare extensionless posix-style
// path never qualifies. So the fake `run` stub must branch on the lookup command AND return
// win32-shaped paths on win32, keeping the version-probe re-invocation keyed to whatever path
// the stub returned (mirrors detect.ts calling `version(run, path, ...)` with the resolved path).
// .exe (not .cmd/.bat) so the version probe's cmdInvocation() is identity on win32 too —
// a .cmd/.bat path would get re-wrapped to run under comspec, which is win-args.ts's own
// concern (covered by test/lib/win-args.test.ts), not detectEnv's.
const LOOKUP_CMD = process.platform === 'win32' ? 'where' : 'which';
const CLAUDE_PATH = process.platform === 'win32' ? 'C:\\fake\\bin\\claude.exe' : '/usr/local/bin/claude';
const TMUX_PATH = process.platform === 'win32' ? 'C:\\fake\\bin\\tmux.exe' : '/usr/bin/tmux';

describe('detectEnv', () => {
  it('reports found+version for present binaries, found:false for absent ones', async () => {
    const run = async (cmd: string, args: string[]): Promise<{ stdout: string }> => {
      if (cmd === LOOKUP_CMD && args[0] === 'claude') return { stdout: `${CLAUDE_PATH}\n` };
      if (cmd === LOOKUP_CMD && args[0] === 'codex') throw new Error('not found');
      if (cmd === LOOKUP_CMD && args[0] === 'tmux') return { stdout: `${TMUX_PATH}\n` };
      if (cmd === LOOKUP_CMD && args[0] === 'rg') throw new Error('not found');
      // version probes run the RESOLVED path (a bare .cmd name can't be
      // execFile'd on win32), not the bare binary name.
      if (cmd === CLAUDE_PATH && args[0] === '--version') return { stdout: '1.2.3\n' };
      if (cmd === TMUX_PATH && args[0] === '-V') return { stdout: 'tmux 3.4\n' };
      throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
    };

    const env = await detectEnv({ run });

    expect(env.claude.found).toBe(true);
    expect(env.claude.version).toBe('1.2.3');
    expect(env.codex.found).toBe(false);
    expect(env.tmux.found).toBe(true);
    expect(env.rg.found).toBe(false);
  });

  it('never throws even when every lookup fails', async () => {
    const run = async (): Promise<{ stdout: string }> => {
      throw new Error('command not found');
    };

    const env = await detectEnv({ run });

    expect(env.claude.found).toBe(false);
    expect(env.codex.found).toBe(false);
    expect(env.tmux.found).toBe(false);
    expect(env.rg.found).toBe(false);
  });
});

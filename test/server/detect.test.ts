import { describe, it, expect } from 'vitest';
import { detectEnv } from '../../server/lib/detect';

// Fake runner stubs child_process execFile calls so tests don't depend on the
// machine actually having claude/codex/tmux/rg installed. Store scan (projects)
// is left to the real (empty-in-CI) provider stores, so we only assert on the
// binary-detection fields (found/version) and tmux/rg, never on store.projects.

describe('detectEnv', () => {
  it('reports found+version for present binaries, found:false for absent ones', async () => {
    const run = async (cmd: string, args: string[]): Promise<{ stdout: string }> => {
      if (cmd === 'which' && args[0] === 'claude') return { stdout: '/usr/local/bin/claude\n' };
      if (cmd === 'which' && args[0] === 'codex') throw new Error('not found');
      if (cmd === 'which' && args[0] === 'tmux') return { stdout: '/usr/bin/tmux\n' };
      if (cmd === 'which' && args[0] === 'rg') throw new Error('not found');
      // version probes run the RESOLVED path (a bare .cmd name can't be
      // execFile'd on win32), not the bare binary name.
      if (cmd === '/usr/local/bin/claude' && args[0] === '--version') return { stdout: '1.2.3\n' };
      if (cmd === '/usr/bin/tmux' && args[0] === '-V') return { stdout: 'tmux 3.4\n' };
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

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { ClaudeProvider } from '../../server/lib/providers/claude';

// customizationWriteTarget builds real fs write paths with path.join(), which is
// separator-native (backslash on win32) — so the expected values here must be built
// with join() too, not hardcoded POSIX strings, or this fails on every Windows host.
describe('claude customizationWriteTarget', () => {
  const p = new ClaudeProvider({ homeDir: '/home/u' });
  it('project agent → .claude/agents/<name>.md', () => {
    expect(p.customizationWriteTarget({ kind: 'project', repoPath: '/repo' }, 'agents', 'my-agent'))
      .toBe(join('/repo', '.claude', 'agents', 'my-agent.md'));
  });
  it('project skill → .claude/skills/<name>/SKILL.md', () => {
    expect(p.customizationWriteTarget({ kind: 'project', repoPath: '/repo' }, 'skills', 'my-skill'))
      .toBe(join('/repo', '.claude', 'skills', 'my-skill', 'SKILL.md'));
  });
  it('global skill → ~/.claude/skills/<name>/SKILL.md', () => {
    expect(p.customizationWriteTarget({ kind: 'global' }, 'skills', 's'))
      .toBe(join('/home/u', '.claude', 'skills', 's', 'SKILL.md'));
  });
});

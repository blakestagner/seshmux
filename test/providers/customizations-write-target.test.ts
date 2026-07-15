import { describe, it, expect } from 'vitest';
import { ClaudeProvider } from '../../server/lib/providers/claude';

describe('claude customizationWriteTarget', () => {
  const p = new ClaudeProvider({ homeDir: '/home/u' });
  it('project agent → .claude/agents/<name>.md', () => {
    expect(p.customizationWriteTarget({ kind: 'project', repoPath: '/repo' }, 'agents', 'my-agent'))
      .toBe('/repo/.claude/agents/my-agent.md');
  });
  it('project skill → .claude/skills/<name>/SKILL.md', () => {
    expect(p.customizationWriteTarget({ kind: 'project', repoPath: '/repo' }, 'skills', 'my-skill'))
      .toBe('/repo/.claude/skills/my-skill/SKILL.md');
  });
  it('global skill → ~/.claude/skills/<name>/SKILL.md', () => {
    expect(p.customizationWriteTarget({ kind: 'global' }, 'skills', 's'))
      .toBe('/home/u/.claude/skills/s/SKILL.md');
  });
});

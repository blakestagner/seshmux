import { describe, it, expect } from 'vitest';
import { teamsAllowed, buildInlinePayload, buildPredefinedPayload } from '../../components/TeamModal/TeamModal';
import type { TeamTemplate } from '../../lib/client/api';

describe('teamsAllowed', () => {
  it('allows tmux and iterm2', () => {
    expect(teamsAllowed('tmux')).toBe(true);
    expect(teamsAllowed('iterm2')).toBe(true);
  });
  it('rejects in-process, auto, and undefined', () => {
    expect(teamsAllowed('in-process')).toBe(false);
    expect(teamsAllowed('auto')).toBe(false);
    expect(teamsAllowed(undefined)).toBe(false);
  });
});

describe('buildInlinePayload', () => {
  it('trims whitespace and drops rows missing a name or role', () => {
    const payload = buildInlinePayload(
      '  Recon  ',
      [
        { name: ' scout ', role: ' map ', model: 'sonnet' },
        { name: '', role: 'no name' },
        { name: 'ghost', role: '' },
      ],
      '  audit auth  ',
      false,
    );
    expect(payload).toEqual({
      inline: { name: 'Recon', members: [{ name: 'scout', role: 'map', model: 'sonnet' }] },
      task: 'audit auth',
      saveTemplate: false,
    });
  });

  it('carries saveTemplate through', () => {
    const payload = buildInlinePayload('Recon', [{ name: 'scout', role: 'map' }], 'audit auth', true);
    expect(payload.saveTemplate).toBe(true);
  });
});

describe('buildPredefinedPayload', () => {
  it('builds a template payload from a saved TeamTemplate + task', () => {
    const template: TeamTemplate = {
      name: 'Recon',
      members: [{ name: 'scout', role: 'map', model: 'sonnet' }],
      createdAt: 1,
    };
    expect(buildPredefinedPayload(template, '  audit auth  ')).toEqual({
      template: { name: 'Recon', members: [{ name: 'scout', role: 'map', model: 'sonnet' }] },
      task: 'audit auth',
    });
  });
});

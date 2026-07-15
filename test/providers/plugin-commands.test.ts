import { describe, it, expect } from 'vitest';
import { ClaudeProvider } from '../../server/lib/providers/claude';

describe('claude pluginCommands argv', () => {
  const p = new ClaudeProvider({ homeDir: '/home/u' });

  it('listAvailable', () => {
    expect(p.pluginCommands?.listAvailable()).toEqual(['claude', 'plugin', 'list', '--available', '--json']);
  });

  it('listMarketplaces', () => {
    expect(p.pluginCommands?.listMarketplaces()).toEqual(['claude', 'plugin', 'marketplace', 'list', '--json']);
  });

  it('install: scope flag before -- so it is parsed as an option, plugin shielded after --', () => {
    expect(p.pluginCommands?.install('my-plugin', 'user')).toEqual([
      'claude',
      'plugin',
      'install',
      '-s',
      'user',
      '--',
      'my-plugin',
    ]);
  });

  it('install: project scope', () => {
    expect(p.pluginCommands?.install('foo', 'project')).toEqual([
      'claude',
      'plugin',
      'install',
      '-s',
      'project',
      '--',
      'foo',
    ]);
  });

  it('uninstall: scope flag before -- so it is parsed as an option, plugin shielded after --', () => {
    expect(p.pluginCommands?.uninstall('my-plugin', 'user')).toEqual([
      'claude',
      'plugin',
      'uninstall',
      '-s',
      'user',
      '--',
      'my-plugin',
    ]);
  });

  it('uninstall: project scope', () => {
    expect(p.pluginCommands?.uninstall('foo', 'project')).toEqual([
      'claude',
      'plugin',
      'uninstall',
      '-s',
      'project',
      '--',
      'foo',
    ]);
  });
});

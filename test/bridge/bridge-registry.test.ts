import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBridge, bridgeStatus, type RegistryDeps } from '../../server/lib/bridge/registry';

// Temp dir per test — NEVER touch real ~/.claude.json or ~/.codex/config.toml.
function makeDeps(): { deps: RegistryDeps; claudePath: string; codexPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'seshmux-registry-'));
  const claudePath = join(dir, '.claude.json');
  const codexPath = join(dir, '.codex', 'config.toml');
  return { deps: { targets: { claudeConfigPath: claudePath, codexConfigPath: codexPath } }, claudePath, codexPath };
}

describe('bridgeStatus — before registration', () => {
  it('reports both unregistered when files do not exist', async () => {
    const { deps } = makeDeps();
    expect(await bridgeStatus(deps)).toEqual({ claude: false, codex: false });
  });
});

describe('registerBridge — claude json', () => {
  it('writes mcpServers.seshmux-bridge into a fresh file', async () => {
    const { deps, claudePath } = makeDeps();
    await registerBridge(deps);
    const cfg = JSON.parse(readFileSync(claudePath, 'utf8'));
    expect(cfg.mcpServers['seshmux-bridge']).toEqual({ command: 'npx', args: ['seshmux', 'mcp-bridge'] });
  });

  it('preserves existing unrelated config and other mcpServers entries', async () => {
    const { deps, claudePath } = makeDeps();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(claudePath, '..'), { recursive: true });
    writeFileSync(
      claudePath,
      JSON.stringify({ someOtherSetting: true, mcpServers: { other: { command: 'foo' } } }),
    );
    await registerBridge(deps);
    const cfg = JSON.parse(readFileSync(claudePath, 'utf8'));
    expect(cfg.someOtherSetting).toBe(true);
    expect(cfg.mcpServers.other).toEqual({ command: 'foo' });
    expect(cfg.mcpServers['seshmux-bridge']).toEqual({ command: 'npx', args: ['seshmux', 'mcp-bridge'] });
  });

  it('aborts (never clobbers) when the file exists but is not valid JSON (R2-2)', async () => {
    const { deps, claudePath } = makeDeps();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(claudePath, '..'), { recursive: true });
    const garbage = '{ this is not valid json, and holds the user\'s real settings ';
    writeFileSync(claudePath, garbage);
    await expect(registerBridge(deps)).rejects.toThrow(/not valid JSON/i);
    // The original file is untouched — no {} written over it.
    expect(readFileSync(claudePath, 'utf8')).toBe(garbage);
  });

  it('is idempotent: second call produces identical content, no duplicate entries', async () => {
    const { deps, claudePath } = makeDeps();
    await registerBridge(deps);
    const first = readFileSync(claudePath, 'utf8');
    await registerBridge(deps);
    const second = readFileSync(claudePath, 'utf8');
    expect(second).toBe(first);
    const cfg = JSON.parse(second);
    expect(Object.keys(cfg.mcpServers).filter((k) => k === 'seshmux-bridge')).toHaveLength(1);
  });
});

describe('registerBridge — codex toml', () => {
  it('writes a [mcp_servers.seshmux-bridge] block into a fresh file', async () => {
    const { deps, codexPath } = makeDeps();
    await registerBridge(deps);
    const raw = readFileSync(codexPath, 'utf8');
    expect(raw).toContain('[mcp_servers.seshmux-bridge]');
    expect(raw).toContain('command = "npx"');
    expect(raw).toContain('args = ["seshmux", "mcp-bridge"]');
  });

  it('preserves existing toml content when appending', async () => {
    const { deps, codexPath } = makeDeps();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(codexPath, '..'), { recursive: true });
    writeFileSync(codexPath, '[some_other_section]\nfoo = "bar"\n');
    await registerBridge(deps);
    const raw = readFileSync(codexPath, 'utf8');
    expect(raw).toContain('[some_other_section]');
    expect(raw).toContain('foo = "bar"');
    expect(raw).toContain('[mcp_servers.seshmux-bridge]');
  });

  it('is idempotent: leaves existing block untouched on second call, no duplicate block', async () => {
    const { deps, codexPath } = makeDeps();
    await registerBridge(deps);
    const first = readFileSync(codexPath, 'utf8');
    await registerBridge(deps);
    const second = readFileSync(codexPath, 'utf8');
    expect(second).toBe(first);
    const matches = second.match(/\[mcp_servers\.seshmux-bridge\]/g) || [];
    expect(matches).toHaveLength(1);
  });
});

describe('bridgeStatus — after registration', () => {
  it('reports both registered', async () => {
    const { deps } = makeDeps();
    await registerBridge(deps);
    expect(await bridgeStatus(deps)).toEqual({ claude: true, codex: true });
  });

  it('reports only claude when only claude file has the entry', async () => {
    const { deps, claudePath } = makeDeps();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(claudePath, '..'), { recursive: true });
    writeFileSync(claudePath, JSON.stringify({ mcpServers: { 'seshmux-bridge': { command: 'npx' } } }));
    expect(await bridgeStatus(deps)).toEqual({ claude: true, codex: false });
  });
});

describe('real config paths never touched', () => {
  it('defaultTargets is not invoked by any test in this file', () => {
    // Sanity: every test above passes explicit temp-file deps. This test just documents intent.
    expect(true).toBe(true);
  });
});

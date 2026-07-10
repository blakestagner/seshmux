// Idempotent MCP bridge registration (Task 16.7): writes the seshmux-bridge MCP server
// entry into both agents' own config files. Explicit-button only — never called silently.
//
// Config-target seam: real ~/.claude.json / ~/.codex/config.toml paths appear ONLY in
// defaultTargets() below, same pattern as providers/claude.ts's defaultRoot(). All logic
// takes deps.targets so tests (and any future caller) can point at temp files instead.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface RegistryTargets {
  claudeConfigPath: string;
  codexConfigPath: string;
}

export interface RegistryDeps {
  targets: RegistryTargets;
}

export function defaultTargets(): RegistryTargets {
  return {
    claudeConfigPath: join(homedir(), '.claude.json'),
    codexConfigPath: join(homedir(), '.codex', 'config.toml'),
  };
}

function defaultDeps(): RegistryDeps {
  return { targets: defaultTargets() };
}

// The MCP entry. If a custom SESHMUX_CONFIG_DIR is set, propagate it via `env` so the
// spawned mcp-bridge resolves the SAME approval socket path as the web server (otherwise
// the two processes use different dirs → approval silently fail-closes). The default dir
// (~/.config/seshmux) is already shared, so env is only added when explicitly overridden.
// Resolve the command agents should run for the bridge. Prefer this install's
// absolute bin path (SESHMUX_BIN, set by bin/seshmux.js) — `npx seshmux` only
// works once the package is published, and agents spawn MCP servers from
// arbitrary repo cwds where npx can't resolve a local seshmux.
function bridgeCommand(): { command: string; args: string[] } {
  if (process.env.SESHMUX_BIN) {
    return { command: process.execPath, args: [process.env.SESHMUX_BIN, 'mcp-bridge'] };
  }
  return { command: 'npx', args: ['seshmux', 'mcp-bridge'] };
}

function bridgeServerConfig(): { command: string; args: string[]; env?: Record<string, string> } {
  const cfg: { command: string; args: string[]; env?: Record<string, string> } = bridgeCommand();
  if (process.env.SESHMUX_CONFIG_DIR) cfg.env = { SESHMUX_CONFIG_DIR: process.env.SESHMUX_CONFIG_DIR };
  return cfg;
}

// Atomic write: tmp file + rename, same pattern as server/routes/config.ts.
async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function registerClaude(path: string): Promise<void> {
  const cfg = await readJson(path);
  const mcpServers = (cfg.mcpServers && typeof cfg.mcpServers === 'object'
    ? (cfg.mcpServers as Record<string, unknown>)
    : {});
  mcpServers['seshmux-bridge'] = bridgeServerConfig();
  cfg.mcpServers = mcpServers;
  await atomicWrite(path, JSON.stringify(cfg, null, 2) + '\n');
}

async function isClaudeRegistered(path: string): Promise<boolean> {
  const cfg = await readJson(path);
  const mcpServers = cfg.mcpServers;
  return !!(
    mcpServers &&
    typeof mcpServers === 'object' &&
    'seshmux-bridge' in (mcpServers as Record<string, unknown>)
  );
}

// Minimal hand-written TOML block (no TOML writer dep installed). Idempotent: if the
// block already exists anywhere in the file, leave the file untouched. Carries the
// SESHMUX_CONFIG_DIR env only when explicitly overridden (see bridgeServerConfig).
function codexTomlBlock(): string {
  const { command, args } = bridgeCommand();
  const lines = [
    '[mcp_servers.seshmux-bridge]',
    `command = ${JSON.stringify(command)}`,
    `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
  ];
  if (process.env.SESHMUX_CONFIG_DIR) {
    lines.push(`env = { SESHMUX_CONFIG_DIR = ${JSON.stringify(process.env.SESHMUX_CONFIG_DIR)} }`);
  }
  lines.push('');
  return lines.join('\n');
}

function codexHasBridgeBlock(raw: string): boolean {
  return /^\[mcp_servers\.seshmux-bridge\]/m.test(raw);
}

async function registerCodex(path: string): Promise<void> {
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    raw = '';
  }
  if (codexHasBridgeBlock(raw)) {
    // Re-register REPLACES the existing block (an older registration may carry
    // a stale command — e.g. `npx seshmux` before the absolute-bin fix). The
    // block runs from its header to the next table header or EOF.
    const replaced = raw.replace(
      /\[mcp_servers\.seshmux-bridge\][\s\S]*?(?=\n\[|$)/,
      codexTomlBlock().trimEnd() + '\n',
    );
    if (replaced !== raw) await atomicWrite(path, replaced);
    return;
  }
  const needsSep = raw.length > 0 && !raw.endsWith('\n\n');
  const sep = raw.length === 0 ? '' : needsSep ? (raw.endsWith('\n') ? '\n' : '\n\n') : '';
  const next = raw + sep + codexTomlBlock();
  await atomicWrite(path, next);
}

async function isCodexRegistered(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, 'utf8');
    return codexHasBridgeBlock(raw);
  } catch {
    return false;
  }
}

// Writes the seshmux-bridge MCP server config into both agents' config files.
// Idempotent: calling twice produces the same content, no duplicate entries.
export async function registerBridge(deps: RegistryDeps = defaultDeps()): Promise<void> {
  await registerClaude(deps.targets.claudeConfigPath);
  await registerCodex(deps.targets.codexConfigPath);
}

// Reports whether each agent currently has the bridge registered.
export async function bridgeStatus(
  deps: RegistryDeps = defaultDeps(),
): Promise<{ claude: boolean; codex: boolean }> {
  const [claude, codex] = await Promise.all([
    isClaudeRegistered(deps.targets.claudeConfigPath),
    isCodexRegistered(deps.targets.codexConfigPath),
  ]);
  return { claude, codex };
}

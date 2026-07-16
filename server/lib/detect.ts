// Environment detection: which agent CLIs + generic tools are on this machine.
// HARD RULE 3: no `~/.claude`/`~/.codex` path or agent binary name literal here —
// agent binary names + store info come from providers/ via getProviders(). tmux
// and rg are generic tools (not agent providers), so their names may live here.

import { execFile } from 'node:child_process';
import type { AgentProvider } from './providers/types';
import { execArgs } from './which';

const TIMEOUT_MS = 2_000;

export type AgentEnv = {
  found: boolean;
  path?: string;
  version?: string;
  store: { found: boolean; projects: number; bytes: number };
};

export type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

function defaultRun(cmd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });
}

async function which(run: Runner, bin: string): Promise<string | undefined> {
  try {
    // `which` is posix-only; `where` returns every PATH match (one per line),
    // including npm's extensionless unix shim — prefer what CreateProcess can start.
    const win = process.platform === 'win32';
    const { stdout } = await run(win ? 'where' : 'which', [bin]);
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!win) return lines[0] || undefined;
    return lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) ?? lines[0] ?? undefined;
  } catch {
    return undefined;
  }
}

async function version(run: Runner, bin: string, flag = '--version'): Promise<string | undefined> {
  try {
    // execArgs: a resolved .cmd/.bat can't be execFile'd directly on win32.
    const [file, args] = execArgs(bin, [flag]);
    const { stdout } = await run(file, args);
    return stdout.trim().split('\n')[0] || undefined;
  } catch {
    return undefined;
  }
}

async function detectTool(run: Runner, bin: string, versionFlag = '--version') {
  const path = await which(run, bin);
  if (!path) return { found: false };
  const v = await version(run, path, versionFlag);
  return { found: true, path, ...(v ? { version: v } : {}) };
}

export async function detectEnv(deps?: { run?: Runner }): Promise<{
  claude: AgentEnv;
  codex: AgentEnv;
  tmux: { found: boolean; version?: string };
  rg: { found: boolean };
}> {
  const run = deps?.run ?? defaultRun;

  // Always build both providers for binary/version lookup (getProviders() omits codex
  // when its store is absent, but we still want to detect its CLI). This keeps the
  // agent binary-name literals inside providers/ — hard rule 3.
  const { ClaudeProvider } = await import('./providers/claude');
  const { CodexProvider } = await import('./providers/codex');
  const byId = new Map<'claude' | 'codex', AgentProvider>([
    ['claude', new ClaudeProvider()],
    ['codex', new CodexProvider()],
  ]);

  async function agentEnv(id: 'claude' | 'codex'): Promise<AgentEnv> {
    const provider = byId.get(id)!;
    const bin = provider.commands.fresh('')[0];
    const path = await which(run, bin);
    const v = path ? await version(run, path) : undefined;

    let store = { found: false, projects: 0, bytes: 0 };
    try {
      const d = await provider.detect();
      const projects = d.store?.projects ?? 0;
      store = { found: projects > 0, projects, bytes: d.store?.bytes ?? 0 };
    } catch {
      /* no store — leave default */
    }

    return { found: !!path, ...(path ? { path } : {}), ...(v ? { version: v } : {}), store };
  }

  const [claude, codex, tmux, rg] = await Promise.all([
    agentEnv('claude'),
    agentEnv('codex'),
    detectTool(run, 'tmux', '-V'),
    detectTool(run, 'rg', '--version'),
  ]);

  return { claude, codex, tmux, rg };
}

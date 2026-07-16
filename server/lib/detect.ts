// Environment detection: which agent CLIs + generic tools are on this machine.
// HARD RULE 3: no `~/.claude`/`~/.codex` path or agent binary name literal here —
// agent binary names + store info come from providers/ via getProviders(). tmux
// and rg are generic tools (not agent providers), so their names may live here.

import { execFile } from 'node:child_process';
import type { AgentProvider } from './providers/types';
import { whichBin, type Runner as WhichRunner } from './which';
import { cmdInvocation } from './win-args';

const TIMEOUT_MS = 2_000;

export type AgentEnv = {
  found: boolean;
  path?: string;
  version?: string;
  store: { found: boolean; projects: number; bytes: number };
};

// `opts` is optional and additive: cmdInvocation returns spawn options the caller
// must apply (windowsVerbatimArguments on the .cmd path — its command line is
// already escaped and node must not re-escape it). Stub runners in tests simply
// ignore the extra argument.
export type Runner = (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string }>;

function defaultRun(cmd: string, args: string[], opts: object = {}): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, ...opts }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });
}

// Resolution heuristic (where.exe parsing, CWD-shadow drop, extension preference)
// lives in which.ts — share it so detection and the spawn path never disagree.
function which(run: Runner, bin: string): Promise<string | undefined> {
  return whichBin(bin, run as WhichRunner);
}

async function version(run: Runner, bin: string, flag = '--version'): Promise<string | undefined> {
  try {
    // cmdInvocation: a resolved .cmd/.bat can't be execFile'd directly on win32.
    // spawnOpts must reach the runner — without it node re-escapes the command
    // line and a .cmd under a spaced path (C:\Program Files\...) never runs, so
    // its version would silently read as undefined.
    const [file, args, spawnOpts] = cmdInvocation(bin, [flag]);
    const { stdout } = await run(file, args, spawnOpts);
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

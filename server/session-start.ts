// Shared session-start machinery — the ONE place a PTY is spawned for an agent
// session. Both POST /api/sessions/start (routes/term.ts) and the agent-bridge
// routes (routes/bridge.ts, via its injected StartSession seam) call this, so
// argv-from-provider, tmux-tier selection, first-prompt injection, and monitor
// tracking live in a single code path.
//
// argv comes ONLY from provider.commands (hard rule 3). No agent binary names here.

import path from 'node:path';
import { dial } from './daemon-client';
import { whichBin } from './lib/which';
import { getProviders } from './lib/providers/types';
import type { ProviderId } from './lib/providers/types';
import { detectEnv } from './lib/detect';

export type SessionMode = 'new' | 'continue' | 'plan';

export interface StartSessionInput {
  projectPath: string;
  provider: ProviderId;
  mode?: SessionMode;
  resumeId?: string;
  // Bridge/plan-off seed: the agent TUI's first input. Passed as a real argv element
  // via provider.commands.freshPrompt when available (new session, no resumeId);
  // otherwise written into the PTY after a post-spawn settle (agreed seam with
  // lead-data) as a best-effort fallback.
  firstPrompt?: string;
  // Bridge pairing metadata (lead-data passes an OBJECT; we flatten into tabMeta).
  linkSrc?: { sessionId: string; kind: 'handoff' | 'review' };
}

export interface TabMeta {
  ptyId: string;
  provider: ProviderId;
  projectPath: string;
  mode: string;
  tmux: boolean;
  linked?: boolean;
  linkedKind?: 'handoff' | 'review';
  linkSrc?: string;
}

export interface StartSessionResult {
  ptyId: string;
  tabMeta: TabMeta;
}

// Optional hook so the events hub can attach its monitor to a freshly spawned
// PTY. Injected by the server at wire time (avoids a hub↔session-start cycle).
let onSpawned: ((ptyId: string) => void) | null = null;
export function setSpawnListener(fn: (ptyId: string) => void): void {
  onSpawned = fn;
}

// Time to let a TUI settle before writing firstPrompt to its input box. Fallback path
// only (providers without freshPrompt, or resume/continue modes) — 1200ms proved too
// short live (a Claude session printing MCP setup warnings swallowed the write).
const FIRST_PROMPT_SETTLE_MS = 3000;

const tmuxCounters = new Map<string, number>();
// BARE name — the daemon adds the `seshmux-` prefix (Task 12 convention).
// MUST dedupe against the daemon's live tmux names, not just the in-memory
// counter: the counter resets on every server restart, and the daemon spawns
// with `tmux new-session -A`, so a reused name silently ATTACHES to the old
// session instead of creating a new one (a "codex" spawn lands inside an
// existing claude session).
function nextTmuxName(projectPath: string, taken: Set<string>): string {
  const repo =
    path
      .basename(projectPath || 'repo')
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/^[-.]+/, '') || 'repo';
  let n = (tmuxCounters.get(repo) ?? 0) + 1;
  while (taken.has(`${repo}-${n}`)) n++;
  tmuxCounters.set(repo, n);
  return `${repo}-${n}`;
}

// tmux runs a SINGLE-arg command through the user's login shell, and a
// ~/.zshenv that overwrites PATH can lose the agent binary (seen live: fresh
// codex spawn = argv ['codex'] died `zsh:1: command not found: codex`).
// Multi-arg commands are exec'd directly with the tmux server's env, which is
// also not guaranteed to match ours. Resolve argv[0] against THIS server's
// PATH so the spawn is shell- and tmux-env-proof. Best effort: unresolved
// names pass through unchanged.
async function resolveBin(bin: string): Promise<string | null> {
  if (bin.includes('/') || bin.includes('\\')) return null; // already a path
  return (await whichBin(bin)) ?? null;
}

function argvFor(
  provider: { id: ProviderId; commands: import('./lib/providers/types').ProviderCommands },
  mode: SessionMode,
  cwd: string,
  resumeId?: string,
): string[] {
  if (resumeId) return provider.commands.resume(cwd, resumeId);
  if (mode === 'continue') return provider.commands.continue(cwd);
  if (mode === 'plan') {
    if (!provider.commands.plan) throw new Error(`provider ${provider.id} has no plan mode`);
    return provider.commands.plan(cwd);
  }
  return provider.commands.fresh(cwd);
}

/**
 * Spawn an agent session PTY. Throws on unknown provider / no-plan-mode
 * (callers map to 400). Caller is responsible for validating projectPath
 * (routes/term.ts validateStart) — bridge callers pass server-derived paths.
 */
export async function startSession(input: StartSessionInput): Promise<StartSessionResult> {
  const { projectPath, provider: providerId, mode = 'new', resumeId, firstPrompt, linkSrc } = input;

  const providers = await getProviders();
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) throw new Error(`unknown provider: ${providerId}`);

  // Seed firstPrompt as a real argv element when possible — no race, no delayed write.
  // Only for a genuinely fresh session (new mode, no resumeId) on a provider that
  // implements freshPrompt; every other case (resume/continue/plan, or a provider that
  // doesn't support it) keeps the delayed-write fallback below.
  const seedViaArgv = !!(firstPrompt && mode === 'new' && !resumeId && provider.commands.freshPrompt);
  const args = seedViaArgv
    ? provider.commands.freshPrompt!(projectPath, firstPrompt!)
    : argvFor(provider, mode, projectPath, resumeId);
  const resolved = await resolveBin(args[0]);
  if (resolved) args[0] = resolved;

  // Auto tmux tier when tmux is present (tier-2 persistence).
  const env = await detectEnv().catch(() => null);

  const conn = await dial();
  try {
    let tmuxName: string | undefined;
    if (env?.tmux.found) {
      // Live tmux names (sans prefix) so the new name can't collide-attach.
      const taken = new Set<string>();
      try {
        const { ptys } = await conn.list();
        for (const p of ptys) if (p.tmuxName) taken.add(p.tmuxName.replace(/^seshmux-/, ''));
      } catch {
        /* daemon list unavailable — counter alone, same as before */
      }
      tmuxName = nextTmuxName(projectPath, taken);
    }
    const { ptyId } = await conn.spawn({ cwd: projectPath, args, tmuxName });

    if (firstPrompt && !seedViaArgv) {
      // Fallback: write after a settle so the TUI's input box is ready. A separate
      // short-lived connection issues the write; the daemon owns delivery thereafter.
      setTimeout(() => {
        void (async () => {
          try {
            const w = await dial();
            await w.write(ptyId, firstPrompt.endsWith('\n') ? firstPrompt : firstPrompt + '\n');
            w.close();
          } catch {
            /* best-effort seed; the session is still usable */
          }
        })();
      }, FIRST_PROMPT_SETTLE_MS);
    }

    // Let the events hub attach its monitor to this PTY (needs-input/status).
    if (onSpawned) onSpawned(ptyId);

    const tabMeta: TabMeta = {
      ptyId,
      provider: providerId,
      projectPath,
      mode: resumeId ? 'resume' : mode,
      tmux: !!tmuxName,
    };
    if (linkSrc) {
      tabMeta.linked = true;
      tabMeta.linkedKind = linkSrc.kind;
      tabMeta.linkSrc = linkSrc.sessionId;
    }
    return { ptyId, tabMeta };
  } finally {
    conn.close();
  }
}

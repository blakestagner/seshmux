// Scratch-terminal spawn + lifecycle. A scratch terminal is a bare login SHELL
// (run a dev server, git, poke around) spawned in an owner agent session's cwd.
//
// The shell is a GENERIC tool, NOT an agent binary, so its resolution lives here
// rather than in providers/ (hard rule 3 is not engaged — no ~/.claude/~/.codex
// path or agent binary name). Spawn goes through the SAME daemon `spawn` RPC as
// agents (protocol frozen at 1, rule 4), but never through session-start.ts:
// there is no provider, no tmux tier, no ledger entry, no monitor tracking.
//
// Env leakage (accepted + documented): the daemon's holder inherits the daemon
// process.env, including SESHMUX_CONFIG_DIR (daemon/holder.js), so a scratch
// shell sees it too. Harmless for a bare interactive shell; strip SESHMUX_* only
// if it ever bites.

import { stat } from 'node:fs/promises';
import { dial, type DaemonConnection } from '../daemon-client';
import {
  addScratch,
  findByOwner,
  readScratchMap,
  removeScratch,
  updateScratch,
} from './scratch-store';

/** The user's login shell — a generic tool, resolved outside providers/. */
export function defaultShell(): string {
  return process.platform === 'win32'
    ? process.env.ComSpec || 'cmd.exe'
    : process.env.SHELL || '/bin/bash';
}

// Hermetic-test injection, mirrors TermRouteDeps: a fake daemon dial + a fixed
// shell so the spawn is deterministic without a real login shell.
export interface ScratchDeps {
  dialFn?: typeof dial;
  shell?: () => string;
  // Skip the one-per-owner re-adoption below and always spawn another shell.
  // This is what ⌘T in the right-pane strip asks for; every OTHER caller wants
  // the idempotent path, so it stays opt-in.
  fresh?: boolean;
}

/**
 * Spawn (or re-adopt) the scratch shell for an owner agent PTY.
 *
 * One-per-owner by default (decision 4): a live existing scratch is returned
 * as-is (`existing: true`) — the POST route is idempotent, which is what lets a
 * reopened owner tab re-adopt its live shell. `fresh` opts out and always
 * spawns another shell, so one owner can hold several (⌘T). A dead hit is
 * pruned and we spawn fresh.
 *
 * Fail-closed on a removed cwd (decision 1): a shell in the wrong
 * checkout is a footgun, so a missing/non-dir cwd throws rather than falling
 * back to the parent repo or home.
 */
export async function startScratchTerminal(
  ownerPtyId: string,
  deps: ScratchDeps = {},
): Promise<{ ptyId: string; existing: boolean }> {
  const conn = await (deps.dialFn ?? dial)();
  try {
    const { ptys } = await conn.list();
    const owner = ptys.find((p) => p.ptyId === ownerPtyId && p.alive);
    // Client fault (route → 400). The found record supplies the worktree-correct
    // cwd + tmux name in one step (spec cwd correction — never the projectPath).
    if (!owner) throw new Error('owner session not found: ' + ownerPtyId);

    // Idempotency: return the owner's existing LIVE scratch without spawning.
    const existingId = deps.fresh ? null : await findByOwner(ownerPtyId, owner.tmuxName);
    if (existingId) {
      if (ptys.some((p) => p.ptyId === existingId && p.alive)) {
        return { ptyId: existingId, existing: true };
      }
      await removeScratch(existingId); // dead hit — prune + fall through to spawn.
    }

    // Fail closed on a gone cwd (rule-7-adjacent): stat before spawning.
    let st;
    try {
      st = await stat(owner.cwd);
    } catch {
      throw new Error('session cwd no longer exists: ' + owner.cwd);
    }
    if (!st.isDirectory()) throw new Error('session cwd no longer exists: ' + owner.cwd);

    // Bare shell → holder tier (no tmuxName). argv is a single generic tool, not
    // a .cmd, so no win-args path is engaged. Protocol untouched (spawn is
    // already args-generic).
    const shell = deps.shell?.() ?? defaultShell();
    const { ptyId } = await conn.spawn({ cwd: owner.cwd, args: [shell] });

    // Map-written-BEFORE-return is the "this pty is a scratch" signal (edge C):
    // once this resolves, getLive()/the hub skip-set both see it. Never call
    // session-start's onSpawned/trackPty — scratch is never classified.
    await addScratch(ptyId, {
      ownerPtyId,
      ownerTmuxName: owner.tmuxName,
      cwd: owner.cwd,
      createdAt: Date.now(),
    });
    return { ptyId, existing: false };
  } finally {
    conn.close();
  }
}

/**
 * Startup orphan sweep (server boot, before any client can rehydrate). For each
 * recorded scratch: kill+prune if its owner is gone; prune if the scratch pty
 * itself is dead; refresh the owner ptyId if a tmux owner came back under a new
 * id (rehydrateTmux). Never throws (mirrors workspaces.reconcile().catch()).
 */
export async function sweepOrphanScratch(
  deps: ScratchDeps = {},
): Promise<{ killed: string[]; pruned: string[] }> {
  const killed: string[] = [];
  const pruned: string[] = [];
  let conn: DaemonConnection | null = null;
  try {
    const map = await readScratchMap();
    if (Object.keys(map).length === 0) return { killed, pruned };
    conn = await (deps.dialFn ?? dial)();
    const { ptys } = await conn.list();
    const aliveById = new Map(ptys.filter((p) => p.alive).map((p) => [p.ptyId, p]));
    const aliveByTmux = new Map(
      ptys.filter((p) => p.alive && p.tmuxName).map((p) => [p.tmuxName as string, p]),
    );

    for (const [scratchPtyId, rec] of Object.entries(map)) {
      // Owner match: bare ptyId first, else tmux name (a tmux owner gets a fresh
      // ptyId across a daemon restart — matching ptyId alone would orphan-kill it).
      let owner = aliveById.get(rec.ownerPtyId);
      if (!owner && rec.ownerTmuxName) owner = aliveByTmux.get(rec.ownerTmuxName);

      if (!owner) {
        // Owner gone → the shell is orphaned. Best-effort kill + prune.
        await conn.kill(scratchPtyId).catch(() => {});
        await removeScratch(scratchPtyId);
        killed.push(scratchPtyId);
        continue;
      }
      if (!aliveById.has(scratchPtyId)) {
        // Owner alive but the scratch pty itself died — stale entry, prune it.
        await removeScratch(scratchPtyId);
        pruned.push(scratchPtyId);
        continue;
      }
      if (owner.ptyId !== rec.ownerPtyId) {
        // tmux owner came back under a new ptyId — refresh so the exit hook and
        // client owner-matching stay correct post-daemon-restart.
        await updateScratch(scratchPtyId, { ownerPtyId: owner.ptyId });
      }
    }
  } catch {
    /* never throw — a sweep failure must not block server startup */
  } finally {
    conn?.close();
  }
  return { killed, pruned };
}

/**
 * Events-hub exit hook (fire-and-forget from the 'exit' broadcast). Two triggers,
 * decided by which side of the association the exited ptyId is:
 *   - the ptyId IS a scratch → the shell itself died/was killed → prune its record.
 *   - the ptyId OWNS scratch(es) → the owner agent PTY exited → kill its shell(s)
 *     + prune. NOTE: exit here is a genuine PTY end, never a UI tab dismissal
 *     (decision 2 keeps a dismissed tab's shell alive — dismissal never exits).
 * Never throws.
 */
export async function handleScratchOnExit(ptyId: string, deps: ScratchDeps = {}): Promise<void> {
  try {
    const map = await readScratchMap();
    if (map[ptyId]) {
      await removeScratch(ptyId); // the scratch itself exited — belt-and-suspenders prune.
      return;
    }
    const owned = Object.keys(map).filter((sid) => map[sid].ownerPtyId === ptyId);
    if (owned.length === 0) return;
    let conn: DaemonConnection | null = null;
    try {
      conn = await (deps.dialFn ?? dial)();
      for (const scratchPtyId of owned) {
        await conn.kill(scratchPtyId).catch(() => {});
        await removeScratch(scratchPtyId);
      }
    } finally {
      conn?.close();
    }
  } catch {
    /* never throw — fire-and-forget from the daemon event loop */
  }
}

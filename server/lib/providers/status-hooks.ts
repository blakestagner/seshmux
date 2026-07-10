// Claude Code status-hook installer (Spec 2 — hook-based status authority).
// Registers Notification / Stop / PermissionRequest hooks in ~/.claude/settings.json
// pointing at a small script this module writes out at install time, so the agent's
// own lifecycle events author needs-input status instead of screen-scraping heuristics
// alone.
//
// Script delivery: the script BODY is inlined as a TS string constant
// (status-hook-script.ts, same reasoning as manifest.ts's static JSON imports) — a
// sibling asset resolved via import.meta.url would not exist once esbuild bundles
// server/index.ts into one file for the standalone build. installHooks() writes the
// string to <scriptPath> (chmod 0o755) BEFORE referencing it in settings.json, so the
// path always exists by the time Claude Code would invoke it.
//
// Config-target seam: same posture as server/lib/bridge/registry.ts — the real
// ~/.claude/settings.json path lives ONLY in defaultStatusHookTargets() below; every
// other function takes an explicit settingsPath/scriptPath so tests (and this module
// itself) never touch the real file. HARD RULE 3 still holds — this stays under providers/.
//
// Opt-in only: never called except from the explicit Settings toggle / its route.
// Append-safe merge: read -> add/replace ONLY our hook entries -> write atomically.
// Uninstall removes ONLY our entries, byte-for-byte restoring everything else.

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CLAUDE_STATUS_HOOK_SCRIPT } from './status-hook-script';

// Bump on any change to CLAUDE_STATUS_HOOK_SCRIPT's behavior/output shape so an
// already-installed hook gets reinstalled instead of silently drifting stale
// (herdr pattern referenced in the spec).
export const HOOK_INTEGRATION_VERSION = 1;

const HOOK_EVENTS = ['Notification', 'Stop', 'PermissionRequest'] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

// Marker embedded in the installed command string (not a settings.json field —
// the schema only allows type/command/args/if/shell) so we can identify AND
// version-check our own entries on read, and never touch a user's own hooks.
const MARKER = 'SESHMUX_STATUS_HOOK';

export interface StatusHookTargets {
  settingsPath: string;
  scriptPath: string;
  // Optional override of the script body written to scriptPath — tests only;
  // real installs always write CLAUDE_STATUS_HOOK_SCRIPT.
  scriptContent?: string;
}

function defaultConfigDir(): string {
  return process.env.SESHMUX_CONFIG_DIR || join(homedir(), '.config', 'seshmux');
}

export function defaultStatusHookTargets(): StatusHookTargets {
  return {
    settingsPath: join(homedir(), '.claude', 'settings.json'),
    scriptPath: join(defaultConfigDir(), 'claude-status-hook.sh'),
  };
}

function hookCommand(scriptPath: string): string {
  // Version + marker travel as leading env assignments in the shell command
  // string itself — inspectable by string match, no extra JSON fields needed.
  return `${MARKER}_V${HOOK_INTEGRATION_VERSION}=1 "${scriptPath}"`;
}

function isOurCommand(command: unknown): command is string {
  return typeof command === 'string' && command.includes(MARKER);
}

function ourVersion(command: string): number | null {
  const m = command.match(new RegExp(`${MARKER}_V(\\d+)=1`));
  return m ? Number(m[1]) : null;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // Malformed JSON — surface to the caller instead of silently clobbering
    // the user's file (install/uninstall both refuse to write in this case).
    throw new Error(`settings.json is not valid JSON: ${(err as Error).message}`);
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

interface HookMatcherGroup {
  hooks: { type: 'command'; command: string }[];
  [k: string]: unknown;
}

function asHooksObject(cfg: Record<string, unknown>): Record<string, unknown> {
  const h = cfg.hooks;
  return h && typeof h === 'object' && !Array.isArray(h) ? (h as Record<string, unknown>) : {};
}

/**
 * Idempotent install: for each of Notification/Stop/PermissionRequest, ensure
 * exactly one matcher group whose hooks array contains our (current-version)
 * command, removing any STALE version of our own entry first (drift reinstall).
 * Never touches entries that aren't ours.
 */
export async function installHooks(targets: StatusHookTargets = defaultStatusHookTargets()): Promise<void> {
  const cfg = await readJson(targets.settingsPath);
  if (cfg === null) throw new Error('refusing to install: settings.json is malformed');

  // Write the script BEFORE touching settings.json — the referenced path must
  // exist by the time Claude Code could invoke it (and if this write fails,
  // settings.json is never touched — fail before the merge, not after).
  await mkdir(dirname(targets.scriptPath), { recursive: true });
  await writeFile(targets.scriptPath, targets.scriptContent ?? CLAUDE_STATUS_HOOK_SCRIPT, 'utf8');
  await chmod(targets.scriptPath, 0o755);

  const hooks = asHooksObject(cfg);
  const command = hookCommand(targets.scriptPath);

  for (const event of HOOK_EVENTS) {
    const groups: HookMatcherGroup[] = Array.isArray(hooks[event])
      ? (hooks[event] as HookMatcherGroup[])
      : [];
    // Drop any prior version of OUR entry (drift reinstall) from every group;
    // a group left with zero hooks (it held only ours) is dropped entirely —
    // we re-add our own single-hook group below, keeping output idempotent.
    const survivors = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurCommand(h.command)) }))
      .filter((g) => g.hooks.length > 0);
    survivors.push({ hooks: [{ type: 'command', command }] });
    hooks[event] = survivors;
  }

  cfg.hooks = hooks;
  await atomicWrite(targets.settingsPath, JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * Exact-restore uninstall: removes ONLY our command entries. A matcher group
 * that held nothing but our hook is dropped entirely; a hooks[event] array
 * left empty is dropped too; hooks:{} left empty is dropped — so uninstalling
 * from a settings.json that had no hooks before install restores it exactly.
 */
export async function uninstallHooks(targets: StatusHookTargets = defaultStatusHookTargets()): Promise<void> {
  const cfg = await readJson(targets.settingsPath);
  if (cfg === null) throw new Error('refusing to uninstall: settings.json is malformed');

  const hooks = asHooksObject(cfg);
  let anyLeft = false;

  for (const key of Object.keys(hooks)) {
    if (!HOOK_EVENTS.includes(key as HookEvent)) {
      anyLeft = true; // untouched foreign event key — hooks stays present
      continue;
    }
    const groups = Array.isArray(hooks[key]) ? (hooks[key] as HookMatcherGroup[]) : [];
    const cleaned = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurCommand(h.command)) }))
      .filter((g) => g.hooks.length > 0);
    if (cleaned.length > 0) {
      hooks[key] = cleaned;
      anyLeft = true;
    } else {
      delete hooks[key];
    }
  }

  if (anyLeft) {
    cfg.hooks = hooks;
  } else {
    delete cfg.hooks;
  }
  await atomicWrite(targets.settingsPath, JSON.stringify(cfg, null, 2) + '\n');
  // Best-effort cleanup of the written script — not required for the "restore
  // settings.json exactly" guarantee (that's the file checked above), just tidy.
  await rm(targets.scriptPath, { force: true }).catch(() => {});
}

export interface HooksInstallState {
  installed: boolean;
  upToDate: boolean;
  version: number | null;
}

/** Reports install state without writing. Never throws on malformed file. */
export async function hooksInstallState(
  targets: StatusHookTargets = defaultStatusHookTargets(),
): Promise<HooksInstallState> {
  let cfg: Record<string, unknown> | null;
  try {
    cfg = await readJson(targets.settingsPath);
  } catch {
    return { installed: false, upToDate: false, version: null };
  }
  if (cfg === null) return { installed: false, upToDate: false, version: null };

  const hooks = asHooksObject(cfg);
  let version: number | null = null;
  let installedCount = 0;
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as HookMatcherGroup[]) : [];
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        if (isOurCommand(h.command)) {
          installedCount++;
          version = ourVersion(h.command);
        }
      }
    }
  }
  const installed = installedCount === HOOK_EVENTS.length;
  return { installed, upToDate: installed && version === HOOK_INTEGRATION_VERSION, version };
}

// Claude Code is always a candidate for hook installation on any platform we
// support (settings.json + shell hooks work on darwin/linux, which is all
// seshmux targets already — daemon-protocol skill). No CLI-version probing
// needed: the hook mechanism has been stable Claude Code surface for a long
// time, unlike codex's undocumented internal hooks (see codex.ts note).
export function hooksAvailable(): boolean {
  return true;
}

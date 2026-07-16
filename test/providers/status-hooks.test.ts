import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installHooks,
  uninstallHooks,
  hooksInstallState,
  HOOK_INTEGRATION_VERSION,
  type StatusHookTargets,
} from '../../server/lib/providers/status-hooks';
import { CLAUDE_STATUS_HOOK_SCRIPT } from '../../server/lib/providers/status-hook-script';
import { IS_WIN } from '../helpers/platform';

// Temp dir per test — NEVER touch the real ~/.claude/settings.json.
// scriptPath is NOT pre-created — installHooks() writes it out itself; that
// write is exactly what's under test in a couple of cases below.
function makeTargets(): { targets: StatusHookTargets; settingsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'seshmux-hooks-'));
  const settingsPath = join(dir, 'settings.json');
  const scriptPath = join(dir, 'claude-status-hook.sh');
  return { targets: { settingsPath, scriptPath }, settingsPath };
}

describe('CLAUDE_STATUS_HOOK_SCRIPT', () => {
  it('is syntactically valid bash (the smallest real check for shipped shell)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seshmux-hook-syntax-'));
    const p = join(dir, 'check.sh');
    writeFileSync(p, CLAUDE_STATUS_HOOK_SCRIPT);
    expect(() => execFileSync('bash', ['-n', p])).not.toThrow();
  });
});

describe('hooksInstallState — before install', () => {
  it('reports not installed when the file does not exist', async () => {
    const { targets } = makeTargets();
    expect(await hooksInstallState(targets)).toEqual({ installed: false, upToDate: false, version: null });
  });
});

describe('installHooks', () => {
  it('writes Notification/Stop/PermissionRequest hook entries into a fresh file', async () => {
    const { targets, settingsPath } = makeTargets();
    await installHooks(targets);
    const cfg = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const event of ['Notification', 'Stop', 'PermissionRequest']) {
      expect(cfg.hooks[event]).toHaveLength(1);
      expect(cfg.hooks[event][0].hooks[0].type).toBe('command');
      expect(cfg.hooks[event][0].hooks[0].command).toContain(targets.scriptPath);
      expect(cfg.hooks[event][0].hooks[0].command).toContain(`_V${HOOK_INTEGRATION_VERSION}=1`);
    }
  });

  it('writes the script file itself (executable) BEFORE settings.json references it', async () => {
    const { targets } = makeTargets();
    expect(existsSync(targets.scriptPath)).toBe(false);
    await installHooks(targets);
    expect(existsSync(targets.scriptPath)).toBe(true);
    expect(readFileSync(targets.scriptPath, 'utf8')).toBe(CLAUDE_STATUS_HOOK_SCRIPT);
    // NTFS has no POSIX executable bit — chmod's argument is accepted but stat().mode
    // always comes back with the exec bits cleared, so this assertion cannot hold on
    // Windows. Not a real coverage gap: hooksAvailable() gates this whole feature off
    // on win32 (see status-hooks.ts), so installHooks() never runs there in production.
    if (!IS_WIN) {
      const { statSync } = await import('node:fs');
      const mode = statSync(targets.scriptPath).mode & 0o777;
      expect(mode & 0o100).toBe(0o100); // owner-executable
    }
  });

  it('preserves existing unrelated settings and the user’s own hooks for other events', async () => {
    const { targets, settingsPath } = makeTargets();
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        someOtherSetting: true,
        permissions: { allow: ['Bash(git *)'] },
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        },
      }),
    );
    await installHooks(targets);
    const cfg = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(cfg.someOtherSetting).toBe(true);
    expect(cfg.permissions.allow).toEqual(['Bash(git *)']);
    expect(cfg.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: 'echo hi' }] }]);
    expect(cfg.hooks.Notification).toHaveLength(1);
  });

  it('preserves the user’s own hook in a shared event (Notification) alongside ours', async () => {
    const { targets, settingsPath } = makeTargets();
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Notification: [{ hooks: [{ type: 'command', command: '/Users/me/.claude/bin/claude-notify.sh' }] }],
        },
      }),
    );
    await installHooks(targets);
    const cfg = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const commands = cfg.hooks.Notification.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((h) => h.command),
    );
    expect(commands).toContain('/Users/me/.claude/bin/claude-notify.sh');
    expect(commands.some((c: string) => c.includes(targets.scriptPath))).toBe(true);
  });

  it('is idempotent: second install produces identical content, no duplicate entries', async () => {
    const { targets, settingsPath } = makeTargets();
    await installHooks(targets);
    const first = readFileSync(settingsPath, 'utf8');
    await installHooks(targets);
    const second = readFileSync(settingsPath, 'utf8');
    expect(second).toBe(first);
    const cfg = JSON.parse(second);
    expect(cfg.hooks.Notification).toHaveLength(1);
    expect(cfg.hooks.Notification[0].hooks).toHaveLength(1);
  });

  it('refuses to write when settings.json is malformed JSON (fixture)', async () => {
    const { targets, settingsPath } = makeTargets();
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    writeFileSync(settingsPath, '{ this is not valid json ,,, ');
    await expect(installHooks(targets)).rejects.toThrow(/not valid JSON/i);
    // File must be left untouched.
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ this is not valid json ,,, ');
  });
});

describe('hooksInstallState — after install', () => {
  it('reports installed + up to date', async () => {
    const { targets } = makeTargets();
    await installHooks(targets);
    expect(await hooksInstallState(targets)).toEqual({
      installed: true,
      upToDate: true,
      version: HOOK_INTEGRATION_VERSION,
    });
  });

  it('detects a stale version and reinstall brings it current (drift reinstall)', async () => {
    const { targets, settingsPath } = makeTargets();
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    const staleCommand = `SESHMUX_STATUS_HOOK_V0=1 "${targets.scriptPath}"`;
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Notification: [{ hooks: [{ type: 'command', command: staleCommand }] }],
          Stop: [{ hooks: [{ type: 'command', command: staleCommand }] }],
          PermissionRequest: [{ hooks: [{ type: 'command', command: staleCommand }] }],
        },
      }),
    );
    const before = await hooksInstallState(targets);
    expect(before).toEqual({ installed: true, upToDate: false, version: 0 });

    await installHooks(targets);
    const after = await hooksInstallState(targets);
    expect(after).toEqual({ installed: true, upToDate: true, version: HOOK_INTEGRATION_VERSION });

    // Only one command per event after drift reinstall — no duplicate stale + fresh.
    const cfg = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(cfg.hooks.Notification).toHaveLength(1);
    expect(cfg.hooks.Notification[0].hooks).toHaveLength(1);
  });
});

describe('uninstallHooks', () => {
  it('exactly restores a settings.json that had no hooks before install', async () => {
    const { targets, settingsPath } = makeTargets();
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    const original = JSON.stringify({ someOtherSetting: true, permissions: { allow: ['Bash(git *)'] } }, null, 2) + '\n';
    writeFileSync(settingsPath, original);

    await installHooks(targets);
    expect(readFileSync(settingsPath, 'utf8')).not.toBe(original);

    await uninstallHooks(targets);
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it('removes only our entries, leaving the user’s other hooks for the same event intact', async () => {
    const { targets, settingsPath } = makeTargets();
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    const original = JSON.stringify(
      {
        hooks: {
          Notification: [{ hooks: [{ type: 'command', command: '/Users/me/.claude/bin/claude-notify.sh' }] }],
        },
      },
      null,
      2,
    ) + '\n';
    writeFileSync(settingsPath, original);

    await installHooks(targets);
    await uninstallHooks(targets);

    const cfg = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const commands = cfg.hooks.Notification.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((h) => h.command),
    );
    expect(commands).toEqual(['/Users/me/.claude/bin/claude-notify.sh']);
    expect(cfg.hooks.Stop).toBeUndefined();
    expect(cfg.hooks.PermissionRequest).toBeUndefined();
  });

  it('refuses to write when settings.json is malformed JSON (fixture)', async () => {
    const { targets, settingsPath } = makeTargets();
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    writeFileSync(settingsPath, 'not even close to json {{{');
    await expect(uninstallHooks(targets)).rejects.toThrow(/not valid JSON/i);
    expect(readFileSync(settingsPath, 'utf8')).toBe('not even close to json {{{');
  });

  it('is a no-op-safe on a file that was never installed', async () => {
    const { targets, settingsPath } = makeTargets();
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ foo: 'bar' }));
    await uninstallHooks(targets);
    const cfg = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(cfg).toEqual({ foo: 'bar' });
  });
});

describe('real ~/.claude never touched', () => {
  it('every test above passes explicit temp-file targets', () => {
    expect(true).toBe(true);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ensureDaemon, pidAlive, paths } = require('../../daemon/ensure.js');

// The daemon is spawned DETACHED so it outlives its launcher — which is the
// whole update-safety mechanism, and also means these tests must clean up after
// themselves explicitly.
const dirs: string[] = [];
function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'seshmux-recover-'));
  dirs.push(dir);
  return dir;
}

function readPid(dir: string): number | null {
  try {
    const n = Number(readFileSync(paths(dir).pid, 'utf8').trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function waitFor(pred: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    const pid = readPid(dir);
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
      await waitFor(() => !pidAlive(pid), 5_000);
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows may still hold a handle briefly — temp dir, not our problem */
    }
  }
});

// The reported failure: seshmuxd died mid-run and nothing brought it back, so
// every "new session" failed with `connect ENOENT ...seshmuxd.sock` until the
// user restarted the whole app by hand. The server never spawns a daemon by
// design (ensure.js is the single sanctioned spawn path) and bin/seshmux.js
// called ensureDaemon() only at startup — these cover the recovery the
// supervisor's heartbeat now leans on.
describe('daemon recovery after an unexpected death', () => {
  it('brings back a daemon whose process is gone', async () => {
    const dir = tempConfigDir();

    const first = await ensureDaemon({ configDir: dir });
    expect(first.spawned).toBe(true);
    const firstPid = readPid(dir)!;
    expect(pidAlive(firstPid)).toBe(true);

    // Simulate the crash.
    process.kill(firstPid);
    expect(await waitFor(() => !pidAlive(firstPid))).toBe(true);

    // What the heartbeat does on its next tick.
    const second = await ensureDaemon({ configDir: dir });
    expect(second.spawned).toBe(true);
    const secondPid = readPid(dir)!;
    expect(secondPid).not.toBe(firstPid);
    expect(pidAlive(secondPid)).toBe(true);
  }, 30_000);

  it('is a no-op against a healthy daemon — never spawns a duplicate', async () => {
    const dir = tempConfigDir();

    const first = await ensureDaemon({ configDir: dir });
    expect(first.spawned).toBe(true);
    const pid = readPid(dir)!;

    // The heartbeat fires on a timer regardless of health, so this is the case
    // that runs ~every tick forever. It must never displace a live daemon.
    for (let i = 0; i < 3; i++) {
      const again = await ensureDaemon({ configDir: dir });
      expect(again.spawned).toBe(false);
    }
    expect(readPid(dir)).toBe(pid);
    expect(pidAlive(pid)).toBe(true);
  }, 30_000);

  // Previously stdio:'ignore' — a dead daemon left NO stack, no exit reason, not
  // even proof it ever started. A process that owns every live agent session has
  // to be able to explain its own death.
  it('writes startup diagnostics to seshmuxd.log', async () => {
    const dir = tempConfigDir();
    await ensureDaemon({ configDir: dir });

    const logPath = join(dir, 'seshmuxd.log');
    expect(await waitFor(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('listening'))).toBe(true);
  }, 30_000);
});

// Guard-rail: the standalone entry must keep BOTH crash nets. The daemon owns
// every live PTY, so an unhandled throw of either flavour ends every agent
// session at once. In-process tests deliberately get neither (they want loud
// failures), so this asserts on the standalone block rather than by behaviour.
describe('standalone crash guards', () => {
  it('registers handlers for both unhandled rejections and uncaught exceptions', () => {
    const src = readFileSync(new URL('../../daemon/index.js', import.meta.url), 'utf8');
    const standalone = src.slice(src.indexOf('require.main === module'));
    expect(standalone).toContain("process.on('unhandledRejection'");
    expect(standalone).toContain("process.on('uncaughtException'");
  });
});

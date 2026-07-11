// Spec 2 acceptance: a fresh hook status file WINS over needs-input heuristics in the
// events-hub classify feed — never blended, heuristics are the fallback only. Real daemon
// (matches test/daemon.test.ts / term-bridge.test.ts posture — no mocking node-pty).
//
// SESHMUX_CONFIG_DIR points BOTH the daemon socket and the hub's statusDir/dial() at the
// same temp dir (daemon-client.ts/events-hub.ts read it at call time, not module load).
//
// KNOWN COARSENESS (by design per spec — only Notification/Stop/PermissionRequest are
// wired, no resume/working event): a Notification's 'waiting' file wins for up to 30s
// (HOOK_STATUS_MAX_AGE_MS) even after the user approves and the agent resumes working —
// there's no hook that flips it back to 'working' on resume, so a turn under 30s can show
// 'waiting' the whole time and jump straight to 'idle' on Stop. Heuristics alone would
// have caught the "esc to interrupt" working footer; hooks-on trades that correction away
// for higher-confidence prompt detection. Documented ceiling, not a bug — expanding the
// wired hook set (e.g. a working-resume signal) is future scope, not this spec.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startDaemon } = require('../../daemon/index.js');

describe('events-hub — hook status precedence (Spec 2)', () => {
  let daemon: any;
  let configDir: string;
  let prevConfigDir: string | undefined;

  beforeAll(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seshmux-hub-test-'));
    daemon = await startDaemon({ configDir });
    prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
    process.env.SESHMUX_CONFIG_DIR = configDir;
  });

  afterAll(async () => {
    try {
      daemon.ptyManager.killAll();
    } catch {}
    try {
      await daemon.close();
    } catch {}
    if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
    else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
    try {
      rmSync(configDir, { recursive: true, force: true });
    } catch {}
  });

  it('a fresh hook file flips status to waiting even when heuristics see plain working output (regex broken on purpose)', async () => {
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    try {
      const { dial } = await import('../../server/daemon-client');
      const spawnConn = await dial();
      // Plain /bin/cat output matches NONE of the waiting patterns — the
      // heuristic path alone would classify this as 'working', never 'waiting'.
      // This is the "verify by breaking the regex on purpose" acceptance case.
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: ['/bin/cat'], cols: 80, rows: 24 });
      spawnConn.close();

      // Write a fresh hook status file BEFORE the hub attaches — attachPty()
      // seeds `hooksActive` immediately from an existence probe (no need to
      // wait a full TICK_MS), matching the real flow where hooks are already
      // installed before a session spawns.
      const statusDir = path.join(configDir, 'status');
      mkdirSync(statusDir, { recursive: true });
      writeFileSync(
        path.join(statusDir, `${ptyId}.json`),
        JSON.stringify({ status: 'waiting', ts: Date.now(), source: 'hook' }),
      );

      hub.trackPty(ptyId);
      // Let the hub attach (+ seed hooksActive).
      await new Promise((r) => setTimeout(r, 200));

      const writeConn = await dial();
      await writeConn.write(ptyId, 'plain non-matching output\n');
      writeConn.close();

      // Poll statusByPty indirectly via a fresh events-ws snapshot substitute:
      // the hub doesn't expose statusByPty directly, so we open a raw daemon
      // connection is not enough — use the hub's own broadcast via a fake ws.
      const seen: any[] = [];
      const fakeWs = {
        readyState: 1,
        OPEN: 1,
        send: (frame: string) => seen.push(JSON.parse(frame)),
        on: () => {},
        close: () => {},
      } as any;

      // Give the async readHookStatus().then(setStatus) a moment to land, then
      // snapshot via addClient (replays current statusByPty synchronously).
      await new Promise((r) => setTimeout(r, 300));
      hub.addClient(fakeWs);
      const status = seen.find((e) => e.event === 'status' && e.ptyId === ptyId);
      expect(status?.status).toBe('waiting');

      const killConn = await dial();
      await killConn.kill(ptyId);
      killConn.close();
    } finally {
      await hub.close();
    }
  }, 10000);

  it('falls back to heuristic classification once the hook file goes stale', async () => {
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    try {
      const { dial } = await import('../../server/daemon-client');
      const spawnConn = await dial();
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: ['/bin/cat'], cols: 80, rows: 24 });
      spawnConn.close();

      const statusDir = path.join(configDir, 'status');
      mkdirSync(statusDir, { recursive: true });
      // STALE hook file (31s old), present BEFORE attach so hooksActive picks
      // it up (the file EXISTS — hooksActive only gates on existence, not
      // freshness) — this genuinely exercises the async path's own staleness
      // fallback, not just the hooksActive gate.
      writeFileSync(
        path.join(statusDir, `${ptyId}.json`),
        JSON.stringify({ status: 'waiting', ts: Date.now() - 31_000, source: 'hook' }),
      );

      hub.trackPty(ptyId);
      await new Promise((r) => setTimeout(r, 200));

      const writeConn = await dial();
      // A working-signal frame so heuristics classify it as 'working'.
      await writeConn.write(ptyId, 'esc to interrupt\n');
      writeConn.close();

      await new Promise((r) => setTimeout(r, 300));
      const seen: any[] = [];
      const fakeWs = {
        readyState: 1,
        OPEN: 1,
        send: (frame: string) => seen.push(JSON.parse(frame)),
        on: () => {},
        close: () => {},
      } as any;
      hub.addClient(fakeWs);
      const status = seen.find((e) => e.event === 'status' && e.ptyId === ptyId);
      expect(status?.status).toBe('working');

      const killConn = await dial();
      await killConn.kill(ptyId);
      killConn.close();
    } finally {
      await hub.close();
    }
  }, 10000);

  it('realistic timing: a hook file appearing AFTER attach (first Notification firing mid-session) flips status within ~1s via the status-dir watch, not the 4s tick', async () => {
    // The other precedence tests write the hook file BEFORE trackPty/attach so
    // attachPty's immediate seed applies — fast, but not how a real session
    // behaves (the file doesn't exist until the agent's first Notification
    // fires, well after spawn/attach). This test creates it post-attach and
    // asserts the flip lands well under TICK_MS (4000ms), proving the chokidar
    // status-dir watch (not the periodic tick) drove it.
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    try {
      const { dial } = await import('../../server/daemon-client');
      const spawnConn = await dial();
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: ['/bin/cat'], cols: 80, rows: 24 });
      spawnConn.close();

      hub.trackPty(ptyId);
      await new Promise((r) => setTimeout(r, 200)); // attach settles, hooksActive seed sees no file yet

      const seen: any[] = [];
      const fakeWs = {
        readyState: 1,
        OPEN: 1,
        send: (frame: string) => seen.push(JSON.parse(frame)),
        on: () => {},
        close: () => {},
      } as any;
      hub.addClient(fakeWs);

      // Hook file appears AFTER attach — no pre-seed, no data chunk needed. The
      // status-dir watch alone must flip status to 'waiting'.
      const statusDir = path.join(configDir, 'status');
      mkdirSync(statusDir, { recursive: true });
      writeFileSync(
        path.join(statusDir, `${ptyId}.json`),
        JSON.stringify({ status: 'waiting', ts: Date.now(), source: 'hook' }),
      );

      // Poll well under one TICK_MS (4000ms) for the status broadcast.
      const deadline = Date.now() + 1000;
      let status: any;
      while (Date.now() < deadline) {
        status = seen.find((e) => e.event === 'status' && e.ptyId === ptyId && e.status === 'waiting');
        if (status) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(status?.status).toBe('waiting');

      const killConn = await dial();
      await killConn.kill(ptyId);
      killConn.close();
    } finally {
      await hub.close();
    }
  }, 10000);

  it('a PTY with no hook file ever written stays fully heuristic-driven (hooks off = byte-identical behavior)', async () => {
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    try {
      const { dial } = await import('../../server/daemon-client');
      const spawnConn = await dial();
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: ['/bin/cat'], cols: 80, rows: 24 });
      spawnConn.close();

      hub.trackPty(ptyId);
      await new Promise((r) => setTimeout(r, 200));

      // No hook file written at all for this ptyId — statusDir may not even exist.
      const writeConn = await dial();
      await writeConn.write(ptyId, 'esc to interrupt\n');
      writeConn.close();

      await new Promise((r) => setTimeout(r, 300));
      const seen: any[] = [];
      const fakeWs = {
        readyState: 1,
        OPEN: 1,
        send: (frame: string) => seen.push(JSON.parse(frame)),
        on: () => {},
        close: () => {},
      } as any;
      hub.addClient(fakeWs);
      const status = seen.find((e) => e.event === 'status' && e.ptyId === ptyId);
      expect(status?.status).toBe('working');

      const killConn = await dial();
      await killConn.kill(ptyId);
      killConn.close();
    } finally {
      await hub.close();
    }
  }, 10000);

  it('never resurrects a status broadcast for a PTY that already exited (async hook read racing the exit event)', async () => {
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    try {
      const { dial } = await import('../../server/daemon-client');
      const spawnConn = await dial();
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: ['/bin/cat'], cols: 80, rows: 24 });
      spawnConn.close();

      const statusDir = path.join(configDir, 'status');
      mkdirSync(statusDir, { recursive: true });
      writeFileSync(
        path.join(statusDir, `${ptyId}.json`),
        JSON.stringify({ status: 'waiting', ts: Date.now(), source: 'hook' }),
      );

      hub.trackPty(ptyId);
      await new Promise((r) => setTimeout(r, 200));

      const seen: any[] = [];
      const fakeWs = {
        readyState: 1,
        OPEN: 1,
        send: (frame: string) => seen.push(JSON.parse(frame)),
        on: () => {},
        close: () => {},
      } as any;
      hub.addClient(fakeWs);

      // Fire a data chunk (schedules the async hook read) immediately followed
      // by kill (fires 'exit' synchronously, broadcasting idle + deleting the
      // PTY from every tracking map) — the async read resolves AFTER exit.
      const writeConn = await dial();
      await writeConn.write(ptyId, 'plain output\n');
      const killConn = await dial();
      await killConn.kill(ptyId);
      writeConn.close();
      killConn.close();

      // Let both the exit broadcast and the (guarded) async resolve settle.
      await new Promise((r) => setTimeout(r, 400));

      const statusEvents = seen.filter((e) => e.event === 'status' && e.ptyId === ptyId);
      // Last status seen for this ptyId must be 'idle' (from exit) — never
      // resurrected to 'waiting'/'working' by the late-resolving hook read.
      expect(statusEvents[statusEvents.length - 1]?.status).toBe('idle');
    } finally {
      await hub.close();
    }
  }, 10000);

  // BUG-8: requestApproval must self-expire at expiresAt so a stale pendingApprovals
  // entry can't be resolved late (after the listener's own 120s timeout deny) and
  // report a false "approved" success.
  it('requestApproval self-expires at expiresAt — a late resolveApproval finds nothing and reports false', async () => {
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    try {
      const expiresAt = Date.now() + 100;
      const approvalPromise = hub.requestApproval({
        requestId: 'bug8-req-1',
        tool: 'test-tool',
        question: 'proceed?',
        cwd: os.tmpdir(),
        hop: 0,
        expiresAt,
      });

      // Wait past expiresAt so the self-expire timer fires.
      await new Promise((r) => setTimeout(r, 200));
      const resolved = await approvalPromise;
      expect(resolved).toBe(false); // self-expired, matches the listener's timeout deny

      // A late UI approve after expiry must find the entry already evicted.
      const lateResult = hub.resolveApproval('bug8-req-1', true);
      expect(lateResult).toBe(false); // no false "approved" success
    } finally {
      await hub.close();
    }
  }, 10000);

  // Spec 6: getStatusExplain surfaces the evidence behind the classify feed.
  it('getStatusExplain names the matching pattern for a heuristic-only PTY (no hooks)', async () => {
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    try {
      const { dial } = await import('../../server/daemon-client');
      const spawnConn = await dial();
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: ['/bin/cat'], cols: 80, rows: 24 });
      spawnConn.close();

      expect(hub.getStatusExplain(ptyId)).toBeNull(); // never classified yet

      hub.trackPty(ptyId);
      await new Promise((r) => setTimeout(r, 200));

      const writeConn = await dial();
      await writeConn.write(ptyId, 'esc to interrupt\n');
      writeConn.close();

      await new Promise((r) => setTimeout(r, 300));
      const explain = hub.getStatusExplain(ptyId);
      expect(explain?.status).toBe('working');
      expect(explain?.evidence.branch).toBe('working-activity');
      expect(explain?.evidence.matchedPattern).toBe('esc to interrupt');
      expect(explain?.hookOverride).toBeNull();
      expect(explain?.lastLines.some((l) => l.includes('esc to interrupt'))).toBe(true);

      const killConn = await dial();
      await killConn.kill(ptyId);
      killConn.close();

      // Evidence is cleared on exit (no history kept for a dead PTY).
      await new Promise((r) => setTimeout(r, 100));
      expect(hub.getStatusExplain(ptyId)).toBeNull();
    } finally {
      await hub.close();
    }
  }, 10000);

  it('getStatusExplain reports hookOverride when a fresh hook file wins over heuristics', async () => {
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    try {
      const { dial } = await import('../../server/daemon-client');
      const spawnConn = await dial();
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: ['/bin/cat'], cols: 80, rows: 24 });
      spawnConn.close();

      const statusDir = path.join(configDir, 'status');
      mkdirSync(statusDir, { recursive: true });
      writeFileSync(
        path.join(statusDir, `${ptyId}.json`),
        JSON.stringify({ status: 'waiting', ts: Date.now(), source: 'hook' }),
      );

      hub.trackPty(ptyId);
      await new Promise((r) => setTimeout(r, 200));

      const writeConn = await dial();
      await writeConn.write(ptyId, 'plain non-matching output\n');
      writeConn.close();

      await new Promise((r) => setTimeout(r, 300));
      const explain = hub.getStatusExplain(ptyId);
      expect(explain?.status).toBe('waiting');
      expect(explain?.hookOverride).toMatchObject({ hookStatus: 'waiting' });
      expect(explain?.hookOverride?.path).toContain(ptyId);
      // Underlying heuristic evidence is still there for comparison — the
      // override didn't reclassify, it just won the precedence decision.
      expect(explain?.evidence.status).toBe('working');

      const killConn = await dial();
      await killConn.kill(ptyId);
      killConn.close();
    } finally {
      await hub.close();
    }
  }, 10000);

  // Spec 5 task 1: waitForStatus subscribes to the SAME setStatus/broadcast path
  // as the WS status feed — no polling, resolves on the real transition.
  describe('waitForStatus (Spec 5)', () => {
    it('resolves immediately when the ptyId is already at the target status', async () => {
      const { createEventsHub } = await import('../../server/events-hub');
      const hub = await createEventsHub();
      try {
        const { dial } = await import('../../server/daemon-client');
        const spawnConn = await dial();
        const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: ['/bin/cat'], cols: 80, rows: 24 });
        spawnConn.close();

        hub.trackPty(ptyId);
        await new Promise((r) => setTimeout(r, 200));

        // attachPty seeds a fresh PTY to 'working' if unset — assert against
        // that real starting status rather than assuming it.
        const already = await Promise.race([
          hub.waitForStatus(ptyId, 'working', 5),
          new Promise((r) => setTimeout(() => r('slow'), 50)),
        ]);
        expect(already).toEqual({ status: 'working' }); // resolved fast (already there), not the 50ms race loser

        const killConn = await dial();
        await killConn.kill(ptyId);
        killConn.close();
      } finally {
        await hub.close();
      }
    }, 10000);

    it('resolves when a real status transition fires (working -> waiting via heuristic classify)', async () => {
      const { createEventsHub } = await import('../../server/events-hub');
      const hub = await createEventsHub();
      try {
        const { dial } = await import('../../server/daemon-client');
        const spawnConn = await dial();
        const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: ['/bin/cat'], cols: 80, rows: 24 });
        spawnConn.close();

        hub.trackPty(ptyId);
        await new Promise((r) => setTimeout(r, 200));

        const waitPromise = hub.waitForStatus(ptyId, 'waiting', 5);

        const writeConn = await dial();
        // A permission-prompt-shaped frame the real needsInputPatterns match.
        await writeConn.write(ptyId, 'Do you want to proceed?\n❯ 1. Yes\n');
        writeConn.close();

        const result = await waitPromise;
        expect(result).toEqual({ status: 'waiting' });

        const killConn = await dial();
        await killConn.kill(ptyId);
        killConn.close();
      } finally {
        await hub.close();
      }
    }, 10000);

    it('resolves {status:"timeout"} — never throws — when the target status never arrives', async () => {
      const { createEventsHub } = await import('../../server/events-hub');
      const hub = await createEventsHub();
      try {
        const { dial } = await import('../../server/daemon-client');
        const spawnConn = await dial();
        const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: ['/bin/cat'], cols: 80, rows: 24 });
        spawnConn.close();

        hub.trackPty(ptyId);
        await new Promise((r) => setTimeout(r, 200));

        // Never fires 'idle' (session stays alive, no idle-tick within the cap) —
        // the 1s cap here is far below the real idle-silence threshold, so this
        // is genuinely exercising the timeout path, not a lucky race.
        const result = await hub.waitForStatus(ptyId, 'idle', 1);
        expect(result).toEqual({ status: 'timeout' });

        const killConn = await dial();
        await killConn.kill(ptyId);
        killConn.close();
      } finally {
        await hub.close();
      }
    }, 10000);

    it('resolves waiters targeting "idle" on PTY exit (not just via setStatus)', async () => {
      const { createEventsHub } = await import('../../server/events-hub');
      const hub = await createEventsHub();
      try {
        const { dial } = await import('../../server/daemon-client');
        const spawnConn = await dial();
        const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: ['/bin/cat'], cols: 80, rows: 24 });
        spawnConn.close();

        hub.trackPty(ptyId);
        await new Promise((r) => setTimeout(r, 200));

        const waitPromise = hub.waitForStatus(ptyId, 'idle', 5);

        const killConn = await dial();
        await killConn.kill(ptyId);
        killConn.close();

        const result = await waitPromise;
        expect(result).toEqual({ status: 'idle' });
      } finally {
        await hub.close();
      }
    }, 10000);
  });
});

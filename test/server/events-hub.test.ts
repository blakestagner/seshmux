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
import { catPty } from '../helpers/platform';

// daemon spawn's `args` is [file, ...execArgs] (daemon/holder.js reads args[0]
// as the spawn target) — cross-platform stand-in for the posix-only `/bin/cat`
// every PTY in this file is spawned as.
const catArgs = () => {
  const { file, args } = catPty();
  return [file, ...args];
};

// Condition-based waiting (kills the CI flake): the old write → sleep(300) →
// assert pattern raced BOTH the monitor attach (a chunk written before the hub
// attaches is never delivered — nothing to wait for) and the async
// readHookStatus().then(setStatus) classify. waitForCond polls a condition to
// a deadline; writeUntil additionally RE-WRITES the probe chunk every 250ms so
// a lost pre-attach chunk self-heals. Verified: shrinking the old sleeps to
// 10ms reproduced the exact CI failures; these helpers pass at any speed.
async function waitForCond<T>(
  cond: () => T | null | undefined | false,
  what: string,
  timeoutMs = 5000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// A ws stand-in that just records the frames the hub broadcasts.
function fakeWs(sink: any[]) {
  return {
    readyState: 1,
    OPEN: 1,
    send: (frame: string) => sink.push(JSON.parse(frame)),
    on: () => {},
    close: () => {},
  } as any;
}

/**
 * trackPty + wait until the hub has really attached, instead of sleeping 200ms
 * and hoping.
 *
 * attachPty (server/events-hub.ts:344-373) awaits ensureMonitor() + m.attach()
 * before it seeds a status, and on a loaded Windows runner that can exceed 200ms
 * — every downstream race in this file then leaks. It IS observable: the seed
 * goes out through setStatus -> broadcast (events-hub.ts:363), so attach a probe
 * client FIRST and wait for the seed frame.
 *
 * The probe is why the caller's own recorder stays clean: tests here deliberately
 * add their ws AFTER the seed so `seen` holds only what the test provoked. Pass
 * `status` when a specific seed must land (e.g. a pre-existing fresh hook file
 * flips the 'working' default to 'waiting' via the ASYNC readHookStatusDetail at
 * events-hub.ts:369-373 — waiting on that exact value proves the async read
 * resolved, which a sleep only guessed at).
 */
async function trackAndAwaitAttach(hub: any, ptyId: string, status?: string): Promise<void> {
  const probe: any[] = [];
  hub.addClient(fakeWs(probe));
  hub.trackPty(ptyId);
  await waitForCond(
    () =>
      probe.some(
        (e) => e.event === 'status' && e.ptyId === ptyId && (status === undefined || e.status === status),
      ),
    `attach seed status${status ? ` '${status}'` : ''} for ${ptyId}`,
    8000,
  );
}

describe('events-hub — hook status precedence (Spec 2)', () => {
  let daemon: any;
  let configDir: string;
  let prevConfigDir: string | undefined;

  // Write `chunk` to the PTY, re-writing every ~250ms, until `cond` is truthy.
  // cat echoes the chunk back; each re-write is idempotent for classification.
  async function writeUntil<T>(
    ptyId: string,
    chunk: string,
    cond: () => T | null | undefined | false,
    what: string,
  ): Promise<T> {
    const { dial } = await import('../../server/daemon-client');
    const conn = await dial();
    try {
      const start = Date.now();
      let lastWrite = 0;
      for (;;) {
        if (Date.now() - lastWrite >= 250 || lastWrite === 0) {
          lastWrite = Date.now();
          await conn.write(ptyId, chunk);
        }
        const v = cond();
        if (v) return v;
        if (Date.now() - start > 5000) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      conn.close();
    }
  }

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
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
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

      // Subscribe BEFORE writing so the classify broadcast can't be missed;
      // writeUntil re-writes the probe until a status event lands (heals the
      // pre-attach lost-chunk race — see helper comment).
      const seen: any[] = [];
      const fakeWs = {
        readyState: 1,
        OPEN: 1,
        send: (frame: string) => seen.push(JSON.parse(frame)),
        on: () => {},
        close: () => {},
      } as any;
      hub.addClient(fakeWs);

      // Wait for 'waiting' specifically — attachPty seeds a fresh PTY to
      // 'working', so "any status event" would trip on the seed replay.
      const status = await writeUntil(
        ptyId,
        'plain non-matching output\n',
        () => seen.find((e) => e.event === 'status' && e.ptyId === ptyId && e.status === 'waiting'),
        "hook-driven 'waiting' broadcast after plain output",
      );
      expect(status.status).toBe('waiting');

      const killConn = await dial();
      await killConn.kill(ptyId);
      killConn.close();
    } finally {
      await hub.close();
    }
  }, 10000);

  it('a fresh waiting hook YIELDS to a genuine working footer — agent visibly resumed (R2-4)', async () => {
    // The waiting-hook exists to catch prompts the heuristic MISSES, but with no resume-hook
    // it would pin 'waiting' for up to 30s after the agent resumes. A matched working
    // PATTERN ("esc to interrupt", the footer redrawn on resume) is a high-confidence resume
    // signal, so it overrides a stale waiting hook — unlike plain output (see the test above,
    // which stays 'waiting' because no pattern matched).
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    try {
      const { dial } = await import('../../server/daemon-client');
      const spawnConn = await dial();
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
      spawnConn.close();

      const statusDir = path.join(configDir, 'status');
      mkdirSync(statusDir, { recursive: true });
      // FRESH waiting hook (unlike the stale-fallback test) — the precedence tweak, not
      // staleness, is what lets working win here.
      writeFileSync(
        path.join(statusDir, `${ptyId}.json`),
        JSON.stringify({ status: 'waiting', ts: Date.now(), source: 'hook' }),
      );

      hub.trackPty(ptyId);

      // matched working pattern = genuine resume. Key the wait on the CLASSIFY
      // evidence (getStatusExplain), not the status broadcast — attachPty seeds
      // a fresh PTY to 'working', so a 'working' broadcast alone could be the
      // seed replay, not the R2-4 precedence decision under test.
      const explain = await writeUntil(
        ptyId,
        'esc to interrupt\n',
        () => {
          const e = hub.getStatusExplain(ptyId);
          return e?.status === 'working' ? e : null;
        },
        "classified 'working' overriding the fresh waiting hook",
      );
      expect(explain.status).toBe('working');
      // status-explain: the hook did NOT win, so no hookOverride is claimed.
      expect(explain.hookOverride).toBeNull();

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
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
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

      // A working-signal frame so heuristics classify it as 'working' (the
      // stale hook must NOT win). Explain-keyed, not broadcast-keyed: the
      // attach seed also broadcasts 'working', which would false-pass this.
      const explain = await writeUntil(
        ptyId,
        'esc to interrupt\n',
        () => {
          const e = hub.getStatusExplain(ptyId);
          return e?.status === 'working' ? e : null;
        },
        "heuristic 'working' beating the stale hook",
      );
      expect(explain.status).toBe('working');

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
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
      spawnConn.close();

      // No hook file exists yet, so the seed is attachPty's 'working' default.
      await trackAndAwaitAttach(hub, ptyId, 'working');

      const seen: any[] = [];
      hub.addClient(fakeWs(seen));

      // Hook file appears AFTER attach — no pre-seed, no data chunk needed. The
      // status-dir watch alone must flip status to 'waiting'.
      const statusDir = path.join(configDir, 'status');
      mkdirSync(statusDir, { recursive: true });
      writeFileSync(
        path.join(statusDir, `${ptyId}.json`),
        JSON.stringify({ status: 'waiting', ts: Date.now(), source: 'hook' }),
      );

      // Poll under one TICK_MS (4000ms) for the status broadcast. 3s, not 1s: the
      // status-dir watch has no awaitWriteFinish (events-hub.ts:461), and Windows
      // fs-event latency under CI load can exceed a second. Still strictly below
      // TICK_MS, so a pass STILL proves the watch — not the periodic tick — drove
      // the flip, which is the whole point of this test.
      const status = await waitForCond(
        () => seen.find((e) => e.event === 'status' && e.ptyId === ptyId && e.status === 'waiting'),
        'hook-file watch to flip status to waiting (under TICK_MS)',
        3000,
      );
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
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
      spawnConn.close();

      hub.trackPty(ptyId);

      // No hook file written at all for this ptyId — statusDir may not even
      // exist. Explain-keyed (see stale-hook test — the attach seed also
      // broadcasts 'working').
      const explain = await writeUntil(
        ptyId,
        'esc to interrupt\n',
        () => {
          const e = hub.getStatusExplain(ptyId);
          return e?.status === 'working' ? e : null;
        },
        "heuristic-only classified 'working'",
      );
      expect(explain.status).toBe('working');

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
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
      spawnConn.close();

      const statusDir = path.join(configDir, 'status');
      mkdirSync(statusDir, { recursive: true });
      writeFileSync(
        path.join(statusDir, `${ptyId}.json`),
        JSON.stringify({ status: 'waiting', ts: Date.now(), source: 'hook' }),
      );

      // The hook file above is fresh, so attach's async hook read flips the
      // 'working' default to 'waiting' — wait for THAT exact seed, so the async
      // read is known to have resolved before we start recording.
      await trackAndAwaitAttach(hub, ptyId, 'waiting');

      const seen: any[] = [];
      hub.addClient(fakeWs(seen));

      // Fire a data chunk (schedules the async hook read) immediately followed
      // by kill (fires 'exit' synchronously, broadcasting idle + deleting the
      // PTY from every tracking map) — the async read resolves AFTER exit.
      const writeConn = await dial();
      await writeConn.write(ptyId, 'plain output\n');
      const killConn = await dial();
      await killConn.kill(ptyId);
      writeConn.close();
      killConn.close();

      // Wait for the exit-driven idle, THEN settle, THEN assert it stuck.
      //
      // A fixed 400ms settle raced ConPTY's exit propagation on the node-20
      // Windows runner: idle simply hadn't arrived yet, the last event was still
      // 'waiting', and the test failed for a reason it wasn't testing. Polling
      // for idle first STRENGTHENS this test rather than loosening it — its point
      // is "nothing resurrects a status AFTER idle", which is only meaningful once
      // idle has actually landed. The settle after it is what gives the late
      // (guarded) hook read room to wrongly resurrect, which is the real assertion.
      await waitForCond(
        () => seen.some((e) => e.event === 'status' && e.ptyId === ptyId && e.status === 'idle'),
        'exit-driven idle status',
        8000,
      );
      await new Promise((r) => setTimeout(r, 250));

      const statusEvents = seen.filter((e) => e.event === 'status' && e.ptyId === ptyId);
      // Last status seen for this ptyId must be 'idle' (from exit) — never
      // resurrected to 'waiting'/'working' by the late-resolving hook read.
      expect(statusEvents[statusEvents.length - 1]?.status).toBe('idle');
    } finally {
      await hub.close();
    }
  }, 10000);

  // Stage 3: a PTY exit is the ONLY trigger that drops its live-ledger entry.
  it('removes the ledger entry when a PTY exits', async () => {
    const { createEventsHub } = await import('../../server/events-hub');
    const { addEntry, readEntries, _resetLedgerForTest } = await import('../../server/lib/live-ledger');
    _resetLedgerForTest(); // rebuild the store against this suite's SESHMUX_CONFIG_DIR
    const hub = await createEventsHub();
    try {
      const { dial } = await import('../../server/daemon-client');
      const spawnConn = await dial();
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
      spawnConn.close();

      await addEntry({ ptyId, tmuxName: null, provider: 'claude', cwd: os.tmpdir(), startedAt: Date.now() });
      expect((await readEntries()).some((e) => e.ptyId === ptyId)).toBe(true);

      // Attach first so the monitor connection is subscribed to the exit broadcast.
      await trackAndAwaitAttach(hub, ptyId, 'working');

      const killConn = await dial();
      await killConn.kill(ptyId);
      killConn.close();

      // The exit-driven removeByPtyId is async; poll until the entry is gone.
      let gone = false;
      const start = Date.now();
      while (Date.now() - start < 5000) {
        if (!(await readEntries()).some((e) => e.ptyId === ptyId)) {
          gone = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(gone).toBe(true);
    } finally {
      await hub.close();
      _resetLedgerForTest();
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
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
      spawnConn.close();

      expect(hub.getStatusExplain(ptyId)).toBeNull(); // never classified yet

      hub.trackPty(ptyId);

      const explain = await writeUntil(
        ptyId,
        'esc to interrupt\n',
        () => {
          // Condition on the PATTERN, not just the status: the PTY echo can split
          // the marker across chunks, and a partial frame classifies 'working'
          // with matchedPattern null (CI flake on the slow leg). Keep probing
          // until a chunk carried the whole marker — that's the state asserted.
          const e = hub.getStatusExplain(ptyId);
          return e?.status === 'working' && e.evidence.matchedPattern ? e : null;
        },
        "explain to reach 'working' with the matched pattern",
      );
      expect(explain.status).toBe('working');
      expect(explain.evidence.branch).toBe('working-activity');
      expect(explain.evidence.matchedPattern).toBe('esc to interrupt');
      expect(explain.hookOverride).toBeNull();
      expect(explain.lastLines.some((l) => l.includes('esc to interrupt'))).toBe(true);

      const killConn = await dial();
      await killConn.kill(ptyId);
      killConn.close();

      // Evidence is cleared on exit (no history kept for a dead PTY).
      await waitForCond(() => hub.getStatusExplain(ptyId) === null, 'explain cleared on exit');
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
      const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
      spawnConn.close();

      const statusDir = path.join(configDir, 'status');
      mkdirSync(statusDir, { recursive: true });
      writeFileSync(
        path.join(statusDir, `${ptyId}.json`),
        JSON.stringify({ status: 'waiting', ts: Date.now(), source: 'hook' }),
      );

      hub.trackPty(ptyId);

      const explain = await writeUntil(
        ptyId,
        'plain non-matching output\n',
        () => {
          const e = hub.getStatusExplain(ptyId);
          return e?.status === 'waiting' ? e : null;
        },
        "explain to reach hook-driven 'waiting'",
      );
      expect(explain.status).toBe('waiting');
      expect(explain.hookOverride).toMatchObject({ hookStatus: 'waiting' });
      expect(explain.hookOverride?.path).toContain(ptyId);
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
        const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
        spawnConn.close();

        // Wait for the 'working' seed to have actually landed before racing it
        // against a 50ms timer. Gated on a 200ms sleep this was a latent flake CI
        // hadn't hit yet: if attach hadn't seeded, waitForStatus registered a real
        // 5s waiter and 'slow' won — failing the test for a reason it isn't about.
        await trackAndAwaitAttach(hub, ptyId, 'working');

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
        const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
        spawnConn.close();

        await trackAndAwaitAttach(hub, ptyId, 'working');

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
        const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
        spawnConn.close();

        await trackAndAwaitAttach(hub, ptyId, 'working');

        // Never fires 'idle' (session stays alive, no idle-tick within the cap) —
        // the 1s cap here is far below the real idle-silence threshold, so this
        // is genuinely exercising the timeout path, not a lucky race.
        //
        // The ONLY way 'idle' can appear inside a ~1s window is the daemon's exit
        // broadcast (events-hub.ts:329) — no heuristic can, since SILENCE_MS is
        // 20s. So a {status:'idle'} here means the cat PTY DIED, not that anything
        // classified it: that is what the node-20 Windows runner hit, and why
        // fixtures/bin/cat.cjs now holds its own event loop open instead of
        // depending on stdin staying open. Assert liveness explicitly so a
        // regression names itself instead of masquerading as a status bug.
        const result = await hub.waitForStatus(ptyId, 'idle', 1);
        const listConn = await dial();
        const stillAlive = (await listConn.list()).ptys.some((p: any) => p.ptyId === ptyId);
        listConn.close();
        expect(stillAlive).toBe(true); // if this fails, the fixture died — not a classifier bug
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
        const { ptyId } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
        spawnConn.close();

        await trackAndAwaitAttach(hub, ptyId, 'working');

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

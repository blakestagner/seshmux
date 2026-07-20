// Stage 4: scratch PTYs are never status-classified (the daemon fans EVERY PTY's
// data out to every subscribed socket, so the monitor RECEIVES a scratch's output
// even though it never attached it — the exclusion must hold at the classify gate,
// not just at attach), and an owner PTY's exit fires the scratch kill hook.
//
// Real daemon (matches events-hub.test.ts posture — no mocking node-pty). The
// scratch-store skip-set + owner-exit kill are INJECTED so this test is hermetic
// against the association map (the real store/kill cascade is covered in
// scratch.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startDaemon } = require('../../daemon/index.js');
import { catPty } from '../helpers/platform';

const catArgs = () => {
  const { file, args } = catPty();
  return [file, ...args];
};

async function waitForCond<T>(cond: () => T | null | undefined | false, what: string, timeoutMs = 6000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function fakeWs(sink: any[]) {
  return { readyState: 1, OPEN: 1, send: (frame: string) => sink.push(JSON.parse(frame)), on: () => {}, close: () => {} } as any;
}

describe('events-hub — scratch classifier exclusion + owner-exit kill (Stage 4)', () => {
  let daemon: any;
  let configDir: string;
  let prevConfigDir: string | undefined;

  beforeAll(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seshmux-hub-scratch-'));
    daemon = await startDaemon({ configDir });
    prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
    process.env.SESHMUX_CONFIG_DIR = configDir;
  });

  afterAll(async () => {
    try { daemon.ptyManager.killAll(); } catch {}
    try { await daemon.close(); } catch {}
    if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
    else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
    try { fs.rmSync(configDir, { recursive: true, force: true }); } catch {}
  });

  it('restart-reattach: attaches the owner but NEVER classifies the scratch, even though the monitor receives its data', async () => {
    const { dial } = await import('../../server/daemon-client');
    const spawnConn = await dial();
    const { ptyId: owner } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
    const { ptyId: scratch } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
    spawnConn.close();

    const { createEventsHub } = await import('../../server/events-hub');
    // A fresh hub IS the restart-reattach path: reattachAll() runs at creation.
    const hub = await createEventsHub({ scratchPtyIds: async () => new Set([scratch]) });
    try {
      const seen: any[] = [];
      hub.addClient(fakeWs(seen));

      // The owner attaches on the reattach path → seeds a 'working' status.
      await waitForCond(
        () => seen.some((e) => e.event === 'status' && e.ptyId === owner),
        'owner status seed on reattach',
      );

      // Write into the scratch PTY. The monitor RECEIVES this via the daemon's
      // global fan-out (proven: attaching the owner subscribes the one shared
      // monitor socket to every PTY), but the classify gate must drop it.
      const w = await dial();
      await w.write(scratch, 'esc to interrupt\n');
      w.close();
      await new Promise((r) => setTimeout(r, 400));

      expect(seen.some((e) => e.event === 'status' && e.ptyId === scratch)).toBe(false);
      // And the owner was classified (attached) — sanity that the hub is live.
      expect(seen.some((e) => e.event === 'status' && e.ptyId === owner)).toBe(true);

      const k = await dial();
      await k.kill(owner).catch(() => {});
      await k.kill(scratch).catch(() => {});
      k.close();
    } finally {
      await hub.close();
    }
  }, 15000);

  it('invokes the owner-exit hook when a PTY exits (owner id and scratch id both routed)', async () => {
    const { dial } = await import('../../server/daemon-client');
    const spawnConn = await dial();
    const { ptyId: owner } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
    const { ptyId: scratch } = await spawnConn.spawn({ cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
    spawnConn.close();

    const exitCalls: string[] = [];
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub({
      scratchPtyIds: async () => new Set([scratch]),
      onOwnerExit: async (ptyId: string) => { exitCalls.push(ptyId); },
    });
    try {
      // Subscribe the monitor (attach owner) so it receives exit broadcasts for
      // BOTH ptys (fan-out is per-socket, not per-pty).
      const seen: any[] = [];
      hub.addClient(fakeWs(seen));
      await waitForCond(() => seen.some((e) => e.event === 'status' && e.ptyId === owner), 'owner attach');

      const k = await dial();
      await k.kill(scratch);
      await waitForCond(() => exitCalls.includes(scratch), 'onOwnerExit called for the scratch exit');

      await k.kill(owner);
      await waitForCond(() => exitCalls.includes(owner), 'onOwnerExit called for the owner exit');
      k.close();
    } finally {
      await hub.close();
    }
  }, 15000);
});

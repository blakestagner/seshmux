// Stage 6: the scratch-terminal promise proven end-to-end against a REAL daemon.
// Spawn a scratch shell, restart the hub, prove the shell survives AND is never
// status-classified on the restart-reattach path; getLive() tags it kind:'scratch'
// with no session enrichment; owner exit kills it; a dead-owner orphan is swept.
//
// Real in-process daemon (startDaemon from daemon/index.js) — same posture as
// events-hub.test.ts / events-hub-scratch.test.ts, no node-pty mocking. Uses the
// REAL scratch store + spawn/sweep (only the shell is injected so the scratch is a
// deterministic bare `node` REPL, alive in its PTY, instead of a login shell).
//
// Load-robust by construction: every async daemon state is polled with a generous
// timeout, never a fixed sleep — this shares the daemon under full-suite parallelism.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
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

async function poll<T>(cond: () => Promise<T | null | undefined | false> | (T | null | undefined | false), what: string, timeoutMs = 12000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

// A scratch shell must be ONE argv token (startScratchTerminal spawns [shell]);
// a bare node REPL holds its PTY open, the one-token analogue of the reboot
// test's `node -e setInterval` stub.
const stubShell = () => process.execPath;

function fakeWs(sink: any[]) {
  return { readyState: 1, OPEN: 1, send: (frame: string) => sink.push(JSON.parse(frame)), on: () => {}, close: () => {} } as any;
}

const posixDescribe = process.platform === 'win32' ? describe.skip : describe;

posixDescribe('scratch-terminal (integration, real daemon)', () => {
  let daemon: any;
  let configDir: string;
  let prevConfigDir: string | undefined;

  beforeAll(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smx-scr-int-'));
    daemon = await startDaemon({ configDir });
    prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
    process.env.SESHMUX_CONFIG_DIR = configDir;
    (await import('../../server/lib/scratch-store'))._resetScratchStoreForTest();
  });

  afterAll(async () => {
    try { daemon.ptyManager.killAll(); } catch {}
    try { await daemon.close(); } catch {}
    if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
    else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
    try { fs.rmSync(configDir, { recursive: true, force: true }); } catch {}
  });

  async function aliveIds(): Promise<Set<string>> {
    const { dial } = await import('../../server/daemon-client');
    const conn = await dial();
    try {
      const { ptys } = await conn.list();
      return new Set(ptys.filter((p: any) => p.alive).map((p: any) => p.ptyId));
    } finally {
      conn.close();
    }
  }

  it('spawns a scratch shell for an owner (idempotent), classifies it never on restart, tags it in getLive, kills it on owner exit', async () => {
    const { dial } = await import('../../server/daemon-client');
    const { startScratchTerminal } = await import('../../server/lib/scratch');
    const { readScratchMap } = await import('../../server/lib/scratch-store');

    // Owner: a long-lived cat PTY (agent stand-in — the daemon is provider-agnostic).
    const spawnConn = await dial();
    const { ptyId: owner } = await spawnConn.spawn({ cwd: configDir, args: catArgs(), cols: 80, rows: 24 });
    spawnConn.close();

    // 1. Spawn scratch; idempotent second call returns the same ptyId.
    const first = await startScratchTerminal(owner, { shell: stubShell });
    expect(first.existing).toBe(false);
    const scratch = first.ptyId;
    expect(await poll(async () => (await aliveIds()).has(scratch), 'scratch alive')).toBe(true);
    expect((await readScratchMap())[scratch]?.ownerPtyId).toBe(owner);

    const second = await startScratchTerminal(owner, { shell: stubShell });
    expect(second).toEqual({ ptyId: scratch, existing: true });

    // 2. Restart the hub (a fresh createEventsHub IS the restart-reattach path —
    //    reattachAll runs at creation). The scratch must never be classified even
    //    though the shared monitor socket receives its data via the daemon fan-out.
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    try {
      const seen: any[] = [];
      hub.addClient(fakeWs(seen));
      // Owner attaches on the reattach path → seeds a status.
      await poll(() => seen.some((e) => e.event === 'status' && e.ptyId === owner), 'owner status on reattach');
      // Poke the scratch so the monitor definitely receives its output.
      const wConn = await dial();
      await wConn.write(scratch, "echo hi\n");
      wConn.close();
      // Give the fan-out a real window, then assert the scratch never got a status.
      await new Promise((r) => setTimeout(r, 400));
      expect(seen.some((e) => e.event === 'status' && e.ptyId === scratch)).toBe(false);

      // 3. getLive() tags the scratch and skips session enrichment.
      const { default: termRoutes } = await import('../../server/routes/term');
      const f = Fastify();
      // Real dial → real daemon + real scratch map; resolve stub proves agents still enrich.
      f.register(termRoutes, { resolveSessionForCwd: async () => ({ sessionId: 'sess-x', projectId: 'proj-x' }) } as any);
      const res = await f.inject({ method: 'GET', url: '/api/sessions/live' });
      const live = res.json().live as any[];
      const scratchEntry = live.find((l) => l.ptyId === scratch);
      const ownerEntry = live.find((l) => l.ptyId === owner);
      expect(scratchEntry).toMatchObject({ kind: 'scratch', ownerPtyId: owner });
      expect(scratchEntry.sessionId).toBeUndefined();
      expect(scratchEntry.projectId).toBeUndefined();
      expect(ownerEntry).toMatchObject({ kind: 'agent', sessionId: 'sess-x' });
      await f.close();

      // 4. Owner exit kills the scratch and prunes its record (hub exit hook).
      const kConn = await dial();
      await kConn.kill(owner);
      kConn.close();
      expect(await poll(async () => !(await aliveIds()).has(scratch), 'scratch dies with owner')).toBe(true);
      expect(await poll(async () => (await readScratchMap())[scratch] === undefined, 'scratch record pruned')).toBe(true);
    } finally {
      await hub.close();
    }
  }, 45000);

  it('sweepOrphanScratch kills and prunes a scratch whose owner is gone', async () => {
    const { dial } = await import('../../server/daemon-client');
    const { startScratchTerminal, sweepOrphanScratch } = await import('../../server/lib/scratch');
    const { readScratchMap, updateScratch } = await import('../../server/lib/scratch-store');

    const spawnConn = await dial();
    const { ptyId: owner } = await spawnConn.spawn({ cwd: configDir, args: catArgs(), cols: 80, rows: 24 });
    spawnConn.close();
    const { ptyId: scratch } = await startScratchTerminal(owner, { shell: stubShell });
    expect(await poll(async () => (await aliveIds()).has(scratch), 'orphan-test scratch alive')).toBe(true);

    // Repoint the record at a dead owner ptyId (an owner that never comes back),
    // then sweep: the shell is orphaned → killed + pruned.
    await updateScratch(scratch, { ownerPtyId: 'owner-never-existed', ownerTmuxName: null });
    // Owner-gone orphans are categorized `killed` (record removed too); `pruned`
    // is the distinct owner-alive-but-scratch-already-dead case.
    const { killed } = await sweepOrphanScratch();
    expect(killed).toContain(scratch);
    expect(await poll(async () => !(await aliveIds()).has(scratch), 'orphan scratch killed')).toBe(true);
    expect((await readScratchMap())[scratch]).toBeUndefined();
  }, 30000);
});

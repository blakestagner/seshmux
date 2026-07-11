import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ensure = require('../../daemon/ensure.js');
const { startDaemon } = require('../../daemon/index.js');

// ── Pure classifier (the stale-socket / dead-pid decision), no I/O ──────────────
describe('ensure.classify', () => {
  it('dial ok → use it', () => {
    expect(ensure.classify({ socketExists: true, dialOk: true, pidExists: true, pidAlive: true })).toBe('ok');
  });
  it('no socket file → spawn', () => {
    expect(ensure.classify({ socketExists: false, dialOk: false, pidExists: false, pidAlive: false })).toBe('spawn');
  });
  it('socket exists, dial fails, pid alive → wait (peer starting)', () => {
    expect(ensure.classify({ socketExists: true, dialOk: false, pidExists: true, pidAlive: true })).toBe('wait');
  });
  it('socket exists, dial fails, pid dead → stale (unlink + respawn)', () => {
    expect(ensure.classify({ socketExists: true, dialOk: false, pidExists: true, pidAlive: false })).toBe('stale');
  });
  it('socket exists, dial fails, no pidfile → stale', () => {
    expect(ensure.classify({ socketExists: true, dialOk: false, pidExists: false, pidAlive: false })).toBe('stale');
  });
});

describe('ensure.pidAlive', () => {
  it('own pid is alive', () => {
    expect(ensure.pidAlive(process.pid)).toBe(true);
  });
  it('an almost-certainly-dead pid is not alive', () => {
    // A very high pid unlikely to exist.
    expect(ensure.pidAlive(999999)).toBe(false);
  });
  it('null / NaN → not alive', () => {
    expect(ensure.pidAlive(null)).toBe(false);
    expect(ensure.pidAlive(NaN)).toBe(false);
  });
});

// ── validateStart: argv-injection guard at the session-start boundary ───────────
describe('term.validateStart (argv injection guard)', () => {
  let realDir: string;
  beforeAll(() => {
    realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seshmux-validate-'));
  });
  afterAll(() => {
    try {
      fs.rmSync(realDir, { recursive: true, force: true });
    } catch {}
  });

  it('accepts an absolute existing dir + normal resumeId', async () => {
    const { validateStart } = await import('../../server/routes/term');
    const r = await validateStart({ projectPath: realDir, provider: 'claude', resumeId: '1d3e8c0e-uuid' });
    expect(r.ok).toBe(true);
  });
  it('rejects a resumeId starting with "-" (flag injection)', async () => {
    const { validateStart } = await import('../../server/routes/term');
    const r = await validateStart({
      projectPath: realDir,
      provider: 'claude',
      resumeId: '--dangerously-skip-permissions',
    });
    expect(r.ok).toBe(false);
  });
  it('rejects a relative projectPath', async () => {
    const { validateStart } = await import('../../server/routes/term');
    expect((await validateStart({ projectPath: 'relative/dir', provider: 'claude' })).ok).toBe(false);
  });
  it('rejects a nonexistent projectPath', async () => {
    const { validateStart } = await import('../../server/routes/term');
    expect((await validateStart({ projectPath: '/no/such/dir/xyz123', provider: 'claude' })).ok).toBe(false);
  });
  it('rejects a projectPath that is a file, not a dir', async () => {
    const { validateStart } = await import('../../server/routes/term');
    const file = path.join(realDir, 'f.txt');
    fs.writeFileSync(file, 'x');
    expect((await validateStart({ projectPath: file, provider: 'claude' })).ok).toBe(false);
  });
  it('rejects missing provider / projectPath', async () => {
    const { validateStart } = await import('../../server/routes/term');
    expect((await validateStart({ projectPath: realDir })).ok).toBe(false);
    expect((await validateStart({ provider: 'claude' })).ok).toBe(false);
  });
});

// ── ensureDaemon: real detached spawn + recovery on a temp config dir ───────────
describe('ensureDaemon (real spawn + recovery)', () => {
  let configDir: string;

  beforeAll(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seshmux-ensure-test-'));
  });

  afterAll(async () => {
    // Kill any daemon we spawned via its pidfile, then clean the dir.
    try {
      const pid = Number(fs.readFileSync(path.join(configDir, 'seshmuxd.pid'), 'utf8').trim());
      if (pid) process.kill(pid, 'SIGKILL');
    } catch {}
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {}
  });

  it('spawns a daemon when none exists, and it answers hello', async () => {
    const res = await ensure.ensureDaemon({ configDir });
    expect(res.spawned).toBe(true);
    expect(fs.existsSync(res.sock)).toBe(true);
    // hello works through the socket.
    const ok = await ensure.tryHello(res.sock);
    expect(ok).toBe(true);
  });

  it('reuses the running daemon on a second call (spawned:false)', async () => {
    const res = await ensure.ensureDaemon({ configDir });
    expect(res.spawned).toBe(false);
  });

  it('recovers from a stale socket left by a dead daemon', async () => {
    const p = ensure.paths(configDir);
    // Kill the live daemon but leave its socket file + a dead-pid pidfile behind.
    const pid = Number(fs.readFileSync(p.pid, 'utf8').trim());
    process.kill(pid, 'SIGKILL');
    // Wait for it to die; leave the stale unix socket file in place.
    for (let i = 0; i < 40 && ensure.pidAlive(pid); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // Point the pidfile at a definitely-dead pid so classify() sees "stale".
    fs.writeFileSync(p.pid, '999999');
    expect(fs.existsSync(p.sock)).toBe(true); // stale socket still there

    const res = await ensure.ensureDaemon({ configDir });
    expect(res.spawned).toBe(true);
    const ok = await ensure.tryHello(res.sock);
    expect(ok).toBe(true);
  });
});

// ── WS bridge + session-start echo, end-to-end against a real in-process daemon ─
// Uses the daemon-client + term route logic directly (no full Fastify server) to
// keep the test hermetic; the auth hook is exercised separately in auth.test.ts.
describe('daemon-client bridge', () => {
  let daemon: any;
  let configDir: string;

  beforeAll(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seshmux-bridge-test-'));
    daemon = await startDaemon({ configDir });
    process.env.SESHMUX_CONFIG_DIR = configDir; // daemon-client dials this socket
  });

  afterAll(async () => {
    try {
      daemon.ptyManager.killAll();
    } catch {}
    try {
      await daemon.close();
    } catch {}
    delete process.env.SESHMUX_CONFIG_DIR;
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {}
  });

  it('spawn → attach → write echoes back, filtered to the right ptyId', async () => {
    // Import after SESHMUX_CONFIG_DIR is set so socketPath() resolves to our temp dir.
    const { DaemonConnection } = await import('../../server/daemon-client');

    const control = new DaemonConnection(daemon.sockPath);
    await control.connect();
    const catPty = await control.spawn({ cwd: os.tmpdir(), args: ['/bin/cat'] });
    const otherPty = await control.spawn({ cwd: os.tmpdir(), args: ['/bin/cat'] });

    // Simulate one /ws/term connection bound to catPty, with the ptyId filter.
    const term = new DaemonConnection(daemon.sockPath);
    await term.connect();
    const got: string[] = [];
    let leaked = false;
    term.onEvent((e) => {
      if (e.event === 'data' && e.ptyId === catPty.ptyId) got.push(e.data!);
      if (e.event === 'data' && e.ptyId === otherPty.ptyId) leaked = true;
    });
    await term.attach(catPty.ptyId, true);
    await term.write(catPty.ptyId, 'ping\n');

    // Poke the OTHER pty via a separate connection; our filtered handler must ignore it.
    const poke = new DaemonConnection(daemon.sockPath);
    await poke.connect();
    await poke.attach(otherPty.ptyId, false);
    await poke.write(otherPty.ptyId, 'should-not-leak\n');

    await waitUntil(() => got.join('').includes('ping'), 2000);
    expect(got.join('')).toContain('ping');
    expect(leaked).toBe(false); // ptyId filter kept other-pty output out

    await control.kill(catPty.ptyId);
    await control.kill(otherPty.ptyId);
    control.close();
    term.close();
    poke.close();
  });

  it('a client disconnect does NOT kill the PTY (update-safety in miniature)', async () => {
    const { DaemonConnection } = await import('../../server/daemon-client');

    const c1 = new DaemonConnection(daemon.sockPath);
    await c1.connect();
    const { ptyId } = await c1.spawn({ cwd: os.tmpdir(), args: ['/bin/cat'] });
    await c1.attach(ptyId, true);
    await c1.write(ptyId, 'survivor\n');
    await delay(200);

    // Drop the connection entirely (like a server restart closing its sockets).
    c1.close();
    await delay(200);

    // A brand-new connection re-attaches and the PTY is still alive with scrollback.
    const c2 = new DaemonConnection(daemon.sockPath);
    await c2.connect();
    const replay: string[] = [];
    c2.onEvent((e) => {
      if (e.event === 'data' && e.ptyId === ptyId) replay.push(e.data!);
    });
    await c2.attach(ptyId, true);
    await waitUntil(() => replay.join('').includes('survivor'), 2000);
    expect(replay.join('')).toContain('survivor');

    const { ptys } = await c2.list();
    const found = ptys.find((p: any) => p.ptyId === ptyId);
    expect(found?.alive).toBe(true);

    await c2.kill(ptyId);
    c2.close();
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitUntil timed out'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

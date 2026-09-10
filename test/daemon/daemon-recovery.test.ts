import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { ipcPath } from '../../server/lib/ipc';

const require = createRequire(import.meta.url);
const { ensureDaemon, pidAlive, paths } = require('../../daemon/ensure.js');
const { startDaemon } = require('../../daemon/index.js');

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

// ---------------------------------------------------------------------------
// Crash surface. seshmuxd owns every live PTY, so ONE throw that reaches the
// process level ends every agent session at once — the precise failure the
// daemon exists to prevent. These test that behaviour, not its spelling.

/** Minimal NDJSON hello; enough to prove the daemon is still answering. */
function hello(sockPath: string, timeoutMs = 4000): Promise<any | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    let buf = '';
    const sock = net.connect(ipcPath(sockPath));
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, method: 'hello' }) + '\n'));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) done(JSON.parse(line).result ?? null);
      }
    });
    sock.on('error', () => done(null));
    sock.on('close', () => done(null));
  });
}

async function pollFor(pred: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

describe('a malformed holder frame cannot kill the daemon', () => {
  let holder: net.Server | null = null;
  let daemon: ChildProcess | null = null;

  afterEach(() => {
    try {
      daemon?.kill();
    } catch {
      /* already gone */
    }
    daemon = null;
    try {
      holder?.close();
    } catch {
      /* already closed */
    }
    holder = null;
  });

  // Regression for a REAL crash, reproduced against the real standalone daemon:
  // the path holder socket -> HolderClient._handle -> _onData -> _appendRing ->
  // countNewlines carried no try/catch at all, and data frames were trusted
  // blindly. JSON.stringify DROPS an undefined value, so a holder emitting
  // {event:'data', data: undefined} puts {"event":"data"} on the wire, which
  // reached countNewlines(undefined) and killed seshmuxd with a TypeError —
  // silently, because holder and daemon stderr both went nowhere. Every live
  // agent session died with it.
  it('drops the frame, stays up, and still serves the adopted session', async () => {
    const dir = tempConfigDir();
    const holderDir = join(dir, 'holders');
    mkdirSync(holderDir, { recursive: true });
    const holderSock = ipcPath(join(holderDir, 'pty-1.sock'));

    // A stand-in holder: an alive pid, a listening socket and the ready
    // handshake are all rehydrateHolders() needs to adopt it as a live PTY.
    const attached: net.Socket[] = [];
    holder = net.createServer((sock) => {
      attached.push(sock);
      sock.on('error', () => {});
      sock.write(JSON.stringify({ event: 'ready' }) + '\n');
    });
    await new Promise<void>((r) => holder!.listen(holderSock, () => r()));
    writeFileSync(
      join(holderDir, 'pty-1.json'),
      JSON.stringify({
        ptyId: 'pty-1',
        pid: process.pid, // this test process — alive by definition
        sock: holderSock,
        cwd: process.cwd(),
        args: ['node'],
        cols: 80,
        rows: 24,
        startedAt: Date.now(),
      })
    );

    const daemonEntry = require.resolve('../../daemon/index.js');
    // Capture stderr: the assertion below is that the frame was HANDLED,
    // not merely survived, and the difference is only visible here.
    const logPath = join(dir, 'd.log');
    const logFd = openSync(logPath, 'a');
    daemon = spawn(process.execPath, [daemonEntry], {
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, SESHMUX_CONFIG_DIR: dir },
    });
    closeSync(logFd);

    const sockPath = paths(dir).sock;
    expect(await pollFor(async () => (await hello(sockPath)) !== null)).toBe(true);
    // Adoption is async — rehydrateHolders() runs after listen().
    expect(await pollFor(async () => (await hello(sockPath))?.ptyCount === 1)).toBe(true);
    expect(attached.length).toBeGreaterThan(0);

    // Frames a correct holder would never send. Each one used to be fatal.
    for (const frame of [
      { event: 'data' }, // data absent — the exact crash
      { event: 'data', data: null },
      { event: 'data', data: 42 },
    ]) {
      for (const s of attached) s.write(JSON.stringify(frame) + '\n');
      await new Promise((r) => setTimeout(r, 150));
    }

    // Still alive, still answering, still owning the session.
    expect(daemon.exitCode).toBe(null);
    const after = await hello(sockPath);
    expect(after).not.toBeNull();
    expect(after.ptyCount).toBe(1);

    // And the frame was CONTAINED, not caught on the way out the door.
    // uncaughtException keeps the process alive but leaves whatever it
    // interrupted half-done; surviving that way is a last resort, not the
    // fix. This is the assertion that fails if the containment is removed.
    expect(readFileSync(logPath, 'utf8')).not.toContain(
      'uncaught exception'
    );
  }, 30_000);
});

describe('crash guards', () => {
  // The listen() handshake did once(error, reject) then removed it, leaving the
  // RPC server with NO error listener for the rest of its life. Node emits
  // server errors on the ACCEPT path (EMFILE/ENFILE once file handles run out —
  // observed on this project on Windows, where live PTYs and chokidar watchers
  // compete for handles) while keeping the server up, and an EventEmitter that
  // emits error unlistened THROWS from inside Node internals. Nothing
  // per-request can catch that, and it would take every session down with it.
  it('keeps an error listener on the RPC server for its whole life', async () => {
    const dir = tempConfigDir();
    const d = await startDaemon({ configDir: dir });
    try {
      expect(d.server.listenerCount('error')).toBeGreaterThan(0);
      // Emitting is exactly what the accept path does; it must not throw.
      expect(() => d.server.emit('error', new Error('EMFILE stand-in'))).not.toThrow();
    } finally {
      await d.close();
    }
  }, 30_000);

  // Guard-rail: both standalone entrypoints keep BOTH process-level nets. The
  // holder needs them as much as the daemon — on a machine without tmux the
  // HOLDER owns every node-pty (which throws from inside its own socket error
  // callbacks), so the daemon nets do not cover the real crash path at all.
  // In-process tests deliberately get neither: they want loud failures.
  it.each([
    ['daemon/index.js', 'require.main === module'],
    ['daemon/holder.js', 'SIGHUP'],
  ])('%s registers both process-level nets', (file, marker) => {
    const src = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    const standalone = src.slice(src.indexOf(marker));
    expect(standalone).toContain("process.on('unhandledRejection'");
    expect(standalone).toContain("process.on('uncaughtException'");
  });
});

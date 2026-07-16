import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { ipcPath } from '../../server/lib/ipc';
import { catPty, nodeScriptPty } from '../helpers/platform';

// daemon spawn's `args` is [file, ...execArgs] (daemon/holder.js reads args[0]
// as the spawn target via cmdInvocation) — cross-platform stand-ins for
// posix-only `/bin/cat` and `/bin/sh -c '<script>'`.
const catArgs = () => {
  const { file, args } = catPty();
  return [file, ...args];
};
const nodeArgs = (code: string) => {
  const { file, args } = nodeScriptPty(code);
  return [file, ...args];
};

/**
 * Holder tier: a detached `daemon/holder.js` owns each non-tmux PTY, so the
 * agent survives the daemon's death (crash, restart, upgrade) and the next
 * daemon re-adopts it under the SAME ptyId.
 *
 * These run a REAL out-of-process daemon (SIGKILL is the whole point) against a
 * throwaway SESHMUX_CONFIG_DIR under a SHORT path — macOS caps unix socket
 * paths at ~104 bytes.
 */

const DAEMON_ENTRY = path.join(__dirname, '..', '..', 'daemon', 'index.js');
const CONFIG_DIR = path.join(os.tmpdir(), 'smxh-' + process.pid);
const HOLDER_DIR = path.join(CONFIG_DIR, 'holders');
const SOCK = path.join(CONFIG_DIR, 'seshmuxd.sock');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal NDJSON client for the daemon socket. */
class Client {
  sock: net.Socket;
  private buffer = '';
  private pending = new Map<number, (v: any) => void>();
  events: any[] = [];
  private waiters: { pred: (e: any) => boolean; resolve: (e: any) => void }[] = [];
  private idc = 0;

  constructor(sockPath: string) {
    // Raw client here (not DaemonConnection) — must still go through ipcPath()
    // like every real listen()/connect(); win32 has no fs-path socket to dial.
    this.sock = net.connect(ipcPath(sockPath));
    this.sock.setEncoding('utf8');
    this.sock.on('error', () => {});
    this.sock.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) {
          this.pending.get(msg.id)?.(msg);
          this.pending.delete(msg.id);
        } else if (msg.event) {
          this.events.push(msg);
          for (let i = this.waiters.length - 1; i >= 0; i--) {
            if (this.waiters[i].pred(msg)) {
              this.waiters[i].resolve(msg);
              this.waiters.splice(i, 1);
            }
          }
        }
      }
    });
  }

  ready() {
    return new Promise<void>((resolve, reject) => {
      this.sock.once('connect', () => resolve());
      this.sock.once('error', reject);
    });
  }

  call(method: string, params?: any): Promise<any> {
    const id = ++this.idc;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.sock.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  waitFor(pred: (e: any) => boolean, timeoutMs = 5000): Promise<any> {
    const existing = this.events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('event wait timed out')), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(t);
          resolve(e);
        },
      });
    });
  }

  dataFor(ptyId: string) {
    return this.events
      .filter((e) => e.event === 'data' && e.ptyId === ptyId)
      .map((e) => e.data)
      .join('');
  }

  close() {
    this.sock.destroy();
  }
}

let daemon: ChildProcess | null = null;

/** Start a real daemon process against CONFIG_DIR and wait until it answers. */
async function startDaemonProc(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    env: { ...process.env, SESHMUX_CONFIG_DIR: CONFIG_DIR },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    // No fs.existsSync(SOCK) pre-check: a win32 named pipe leaves no filesystem
    // entry (the whole reason ipcPath() exists), so that pre-check would always
    // fail there and declare the daemon dead before a connect was ever tried.
    // Attempt-and-catch each iteration instead — strictly more rigorous than
    // the existsSync gate, and identical in effect on posix.
    try {
      const c = new Client(SOCK);
      await c.ready();
      const hello = await c.call('hello');
      c.close();
      if (hello.result?.protocol === 1) return child;
    } catch {
      // still booting
    }
  }
  throw new Error('daemon did not come up');
}

function killDaemonProc(child: ChildProcess | null, signal: NodeJS.Signals = 'SIGKILL') {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

function holderMeta(ptyId: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOLDER_DIR, ptyId + '.json'), 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(pred: () => boolean, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(100);
  }
  return false;
}

describe('seshmuxd holder tier', () => {
  beforeAll(() => {
    fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  });

  afterAll(async () => {
    killDaemonProc(daemon);
    // Reap every holder we created — nothing may outlive the test run.
    try {
      for (const f of fs.readdirSync(HOLDER_DIR)) {
        if (!f.endsWith('.json')) continue;
        const meta = holderMeta(f.replace(/\.json$/, ''));
        if (meta?.pid) {
          try {
            process.kill(meta.pid, 'SIGKILL');
          } catch {
            // gone
          }
        }
      }
    } catch {
      // no holder dir
    }
    await sleep(200);
    fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  });

  it("a holder's PTY survives SIGKILL of the daemon; a fresh daemon re-adopts it under the same ptyId", async () => {
    daemon = await startDaemonProc();
    const c1 = new Client(SOCK);
    await c1.ready();
    // `sleep 1` fires AFTER the daemon is dead — its output must still be
    // buffered by the holder (asserted by the next test via replay).
    const spawned = await c1.call('spawn', {
      cwd: os.tmpdir(),
      // Cross-platform stand-in for `sleep 1; echo AFTERKILL; cat`: wait 1s
      // (so it fires after the daemon is killed below), print the marker, then
      // keep echoing stdin like cat.
      args: nodeArgs(
        'setTimeout(() => { console.log("AFTERKILL"); process.stdin.pipe(process.stdout); }, 1000)'
      ),
      cols: 80,
      rows: 24,
    });
    const ptyId = spawned.result.ptyId as string;
    expect(ptyId).toMatch(/^pty-/);

    // Holder is on disk with a live, DIFFERENT pid than the daemon's.
    expect(await until(() => holderMeta(ptyId) !== null, 5000)).toBe(true);
    const meta = holderMeta(ptyId);
    expect(meta.pid).not.toBe(daemon.pid);
    expect(pidAlive(meta.pid)).toBe(true);

    c1.close();
    killDaemonProc(daemon); // SIGKILL — the old failure mode
    await until(() => daemon!.exitCode !== null || daemon!.signalCode !== null, 5000);

    // The holder (and therefore the agent) is untouched by the daemon's death.
    await sleep(300);
    expect(pidAlive(meta.pid)).toBe(true);

    // Fresh daemon adopts it under the ORIGINAL ptyId.
    daemon = await startDaemonProc();
    const c2 = new Client(SOCK);
    await c2.ready();
    const list = await c2.call('list');
    const found = list.result.ptys.find((p: any) => p.ptyId === ptyId);
    expect(found).toBeTruthy();
    expect(found.alive).toBe(true);
    expect(holderMeta(ptyId).pid).toBe(meta.pid); // same holder, not a respawn
    c2.close();
    (globalThis as any).__survivorPtyId = ptyId;
  }, 30000);

  it('replays output produced while NO daemon was attached (ring buffer)', async () => {
    const ptyId = (globalThis as any).__survivorPtyId as string;
    const c = new Client(SOCK);
    await c.ready();
    await c.call('attach', { ptyId });
    // AFTERKILL was printed while the daemon was dead; the holder buffered it
    // and replayed it into the new daemon's ring on adoption.
    expect(await until(() => c.dataFor(ptyId).includes('AFTERKILL'), 8000)).toBe(true);
    c.close();
  }, 20000);

  it('write, resize and kill still work through a holder', async () => {
    const ptyId = (globalThis as any).__survivorPtyId as string;
    const c = new Client(SOCK);
    await c.ready();
    await c.call('attach', { ptyId, fromScrollback: false });

    const w = await c.call('write', { ptyId, data: 'ECHOED\n' });
    expect(w.result.ok).toBe(true);
    await c.waitFor((e) => e.event === 'data' && e.ptyId === ptyId && e.data.includes('ECHOED'));

    const r = await c.call('resize', { ptyId, cols: 120, rows: 40 });
    expect(r.result.ok).toBe(true);
    const list = await c.call('list');
    const found = list.result.ptys.find((p: any) => p.ptyId === ptyId);
    expect(found.cols).toBe(120);
    expect(found.rows).toBe(40);

    const k = await c.call('kill', { ptyId });
    expect(k.result.ok).toBe(true);
    const exit = await c.waitFor((e) => e.event === 'exit' && e.ptyId === ptyId);
    expect(exit).toBeTruthy();
    c.close();
  }, 20000);

  it('cleans up socket + json when the PTY exits, and reports exit', async () => {
    const c = new Client(SOCK);
    await c.ready();
    const spawned = await c.call('spawn', {
      cwd: os.tmpdir(),
      args: nodeArgs('process.exit(7)'),
      cols: 80,
      rows: 24,
    });
    const ptyId = spawned.result.ptyId as string;
    await c.call('attach', { ptyId });
    const exit = await c.waitFor((e) => e.event === 'exit' && e.ptyId === ptyId, 10000);
    expect(exit.code).toBe(7);

    const sock = path.join(HOLDER_DIR, ptyId + '.sock');
    const json = path.join(HOLDER_DIR, ptyId + '.json');
    // Holder keeps the socket up briefly so a reconnecting daemon can learn the
    // exit, then removes BOTH files and exits — no orphans.
    expect(await until(() => !fs.existsSync(json) && !fs.existsSync(sock), 15000)).toBe(true);
    c.close();
  }, 30000);

  it('refuses a second client on the same holder (no double-attach)', async () => {
    const c = new Client(SOCK);
    await c.ready();
    const spawned = await c.call('spawn', { cwd: os.tmpdir(), args: catArgs(), cols: 80, rows: 24 });
    const ptyId = spawned.result.ptyId as string;
    expect(await until(() => holderMeta(ptyId) !== null, 5000)).toBe(true);
    const meta = holderMeta(ptyId);
    // Round-trip a byte first: proves the daemon IS the holder's client before
    // we race it (otherwise the raw socket below could legitimately win).
    await c.call('attach', { ptyId, fromScrollback: false });
    await c.call('write', { ptyId, data: 'PING\n' });
    await c.waitFor((e) => e.event === 'data' && e.ptyId === ptyId && e.data.includes('PING'));

    // The daemon is already this holder's client; anyone else gets 'busy'.
    const frame: string = await new Promise((resolve, reject) => {
      const s = net.connect(meta.sock);
      s.setEncoding('utf8');
      s.on('data', (d: string) => {
        resolve(d);
        s.destroy();
      });
      s.on('error', reject);
      setTimeout(() => reject(new Error('no frame from holder')), 5000);
    });
    expect(frame).toContain('"busy"');

    // ...and the PTY is untouched by the rejected attempt.
    expect(pidAlive(meta.pid)).toBe(true);
    await c.call('kill', { ptyId });
    c.close();
  }, 20000);

  it('a holder whose pid is dead leaves no adopted entry (stale files are cleaned)', async () => {
    const ghost = 'pty-9001';
    const sock = path.join(HOLDER_DIR, ghost + '.sock');
    const json = path.join(HOLDER_DIR, ghost + '.json');
    fs.mkdirSync(HOLDER_DIR, { recursive: true });
    fs.writeFileSync(sock, ''); // orphaned socket file left by a SIGKILLed holder
    fs.writeFileSync(
      json,
      JSON.stringify({
        ptyId: ghost,
        pid: 999999, // not a live process
        sock,
        cwd: os.tmpdir(),
        args: catArgs(),
        cols: 80,
        rows: 24,
        startedAt: Date.now(),
      })
    );

    killDaemonProc(daemon);
    await until(() => daemon!.exitCode !== null || daemon!.signalCode !== null, 5000);
    daemon = await startDaemonProc();

    const c = new Client(SOCK);
    await c.ready();
    const list = await c.call('list');
    expect(list.result.ptys.find((p: any) => p.ptyId === ghost)).toBeUndefined();
    expect(fs.existsSync(json)).toBe(false);
    expect(fs.existsSync(sock)).toBe(false);
    c.close();
  }, 30000);
});

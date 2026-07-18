// Stage 7: the product promise proven end-to-end against a REAL out-of-process
// daemon. A "reboot" = SIGKILL the daemon AND the holder (nothing survives), then
// a fresh daemon + reconcile() must re-spawn the interrupted session. Plus a
// negative control (holder survives → NO duplicate spawn) and second-reconcile
// idempotence.
//
// Harness copied from holders.test.ts: minimal NDJSON Client, out-of-process
// daemon/index.js spawn, SHORT SESHMUX_CONFIG_DIR (macOS ~104-byte socket cap).
//
// Posix-only: holder-survival mechanics (a detached PTY outliving its daemon and
// being re-adopted) are the posix persistence story; gate like the daemon suite.

import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { ipcPath } from '../../server/lib/ipc';

// Fake provider registry + no-tmux detect, shared by the in-process reconcile and
// the REAL startSession it drives (real getProviders would need a live ~/.claude,
// and no agent binary exists in tests). Mutable state is set per-test.
const H = vi.hoisted(() => ({
  state: { cwd: '', sessionId: '', mtime: 0, resumeArgv: [] as string[] },
}));

// Force holder tier (tmuxName === null) for every restored spawn.
vi.mock('../../server/lib/detect', () => ({
  detectEnv: async () => ({
    claude: { found: true },
    codex: { found: false },
    tmux: { found: false },
    rg: { found: false },
  }),
}));

vi.mock('../../server/lib/providers/types', () => ({
  getProviders: async () => [
    {
      id: 'claude',
      scanProjects: async () => [{ id: 'proj-1', path: H.state.cwd, missing: false }],
      listSessions: async () => [{ id: H.state.sessionId, mtime: H.state.mtime }],
      commands: { resume: () => H.state.resumeArgv },
      needsInputPatterns: [],
    },
  ],
  _resetProviders: () => {},
}));

const DAEMON_ENTRY = path.join(__dirname, '..', '..', 'daemon', 'index.js');
// SHORT path (macOS ~104-byte unix-socket cap) — /tmp, not the long os.tmpdir().
const CONFIG_DIR = `/tmp/smxr-${process.pid}`;
const HOLDER_DIR = path.join(CONFIG_DIR, 'holders');
const SOCK = path.join(CONFIG_DIR, 'seshmuxd.sock');

// The in-process consumers (dial, live-ledger) read SESHMUX_CONFIG_DIR at call
// time — set it before any of them run.
process.env.SESHMUX_CONFIG_DIR = CONFIG_DIR;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal NDJSON client for the daemon socket (copy of holders.test.ts). */
class Client {
  sock: net.Socket;
  private buffer = '';
  private pending = new Map<number, (v: any) => void>();
  private idc = 0;

  constructor(sockPath: string) {
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

  close() {
    this.sock.destroy();
  }
}

let daemon: ChildProcess | null = null;

async function startDaemonProc(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    env: { ...process.env, SESHMUX_CONFIG_DIR: CONFIG_DIR },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    await sleep(50);
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

const stubArgs = () => [process.execPath, '-e', 'setInterval(() => {}, 1000)'];

/** Spawn a long-lived holder-tier PTY directly via the daemon (bypasses
 *  startSession for setup — no agent binary needed) and return its ptyId. */
async function spawnStubHolder(c: Client): Promise<string> {
  const [file, ...rest] = stubArgs();
  const spawned = await c.call('spawn', { cwd: CONFIG_DIR, args: [file, ...rest], cols: 80, rows: 24 });
  const ptyId = spawned.result.ptyId as string;
  expect(await until(() => holderMeta(ptyId) !== null, 5000)).toBe(true);
  return ptyId;
}

function reapHolders() {
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
}

const posixDescribe = process.platform === 'win32' ? describe.skip : describe;

posixDescribe('auto-restore reboot (integration)', () => {
  beforeAll(() => {
    fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  });

  afterEach(async () => {
    killDaemonProc(daemon);
    reapHolders();
    daemon = null;
    // Fresh ledger + reconcile guard for the next scenario.
    const { _resetLedgerForTest, ledgerPath } = await import('../../server/lib/live-ledger');
    const { _resetReconcileForTest } = await import('../../server/lib/restore');
    _resetReconcileForTest();
    _resetLedgerForTest();
    // Retry the rm and FAIL LOUDLY if it never lands: a swallowed EMFILE here
    // once leaked test 1's ledger entry into the negative control on macOS CI
    // (2 entries where 1 was asserted) — a corrupt next test is worse than a
    // clear cleanup failure.
    let rmErr: unknown = null;
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(ledgerPath(), { force: true });
        rmErr = null;
        break;
      } catch (e) {
        rmErr = e;
        await sleep(200);
      }
    }
    if (rmErr) throw rmErr;
    _resetLedgerForTest();
    await sleep(150);
  });

  afterAll(() => {
    fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  });

  it('re-spawns an interrupted holder session after a full reboot (daemon + holder SIGKILLed)', async () => {
    const { addEntry, readEntries } = await import('../../server/lib/live-ledger');
    const { reconcile, _resetReconcileForTest } = await import('../../server/lib/restore');

    // 1. Boot daemon A; create a live holder-tier PTY + a matching bound ledger entry.
    daemon = await startDaemonProc();
    const c1 = new Client(SOCK);
    await c1.ready();
    const oldPtyId = await spawnStubHolder(c1);
    const holderPid = holderMeta(oldPtyId).pid as number;
    expect(pidAlive(holderPid)).toBe(true);
    await addEntry({
      ptyId: oldPtyId,
      tmuxName: null,
      provider: 'claude',
      cwd: CONFIG_DIR,
      label: 'smxr',
      startedAt: Date.now(),
      sessionId: 'sess-reboot',
    });
    c1.close();

    // 2. Reboot: SIGKILL the daemon AND the holder — nothing survives.
    killDaemonProc(daemon);
    await until(() => daemon!.exitCode !== null || daemon!.signalCode !== null, 5000);
    process.kill(holderPid, 'SIGKILL');
    expect(await until(() => !pidAlive(holderPid), 5000)).toBe(true);

    // 3. Fresh daemon B — the killed holder is gone, so list() is empty.
    daemon = await startDaemonProc();
    const cB = new Client(SOCK);
    await cB.ready();
    expect(await until(() => holderMeta(oldPtyId) === null, 5000)).toBe(true); // stale json cleaned
    const before = await cB.call('list');
    expect(before.result.ptys.filter((p: any) => p.alive)).toHaveLength(0);

    // 4. reconcile() with the fake provider reporting the session resumable+recent;
    //    the resume spawns the long-lived stub through the REAL startSession.
    H.state.cwd = CONFIG_DIR;
    H.state.sessionId = 'sess-reboot';
    H.state.mtime = Date.now();
    H.state.resumeArgv = stubArgs();

    const restored = await reconcile({ settleMs: 50 });
    expect(restored).toBe(1);

    // 5. Exactly ONE new alive PTY; ledger holds exactly one entry with the new
    //    ptyId and the preserved sessionId.
    const after = await cB.call('list');
    const alive = after.result.ptys.filter((p: any) => p.alive);
    expect(alive).toHaveLength(1);
    const newPtyId = alive[0].ptyId as string;
    expect(newPtyId).not.toBe(oldPtyId);

    const entries = await readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].ptyId).toBe(newPtyId);
    expect(entries[0].sessionId).toBe('sess-reboot');

    // 7. Second reconcile restores nothing — first via the once-per-process guard
    //    (B2), then again with the guard reset (the session is now genuinely live).
    expect(await reconcile()).toBe(0); // guard latched
    _resetReconcileForTest();
    H.state.mtime = Date.now();
    expect(await reconcile({ settleMs: 50 })).toBe(0); // matched alive → keepLive, no spawn

    const stillOne = await cB.call('list');
    expect(stillOne.result.ptys.filter((p: any) => p.alive)).toHaveLength(1);
    cB.close();
  }, 40000);

  it('negative control: a surviving holder (daemon-only SIGKILL) is re-adopted, not duplicated', async () => {
    const { addEntry, readEntries } = await import('../../server/lib/live-ledger');
    const { reconcile } = await import('../../server/lib/restore');

    // Boot daemon A; live holder + bound ledger entry.
    daemon = await startDaemonProc();
    const c1 = new Client(SOCK);
    await c1.ready();
    const ptyId = await spawnStubHolder(c1);
    const holderPid = holderMeta(ptyId).pid as number;
    await addEntry({
      ptyId,
      tmuxName: null,
      provider: 'claude',
      cwd: CONFIG_DIR,
      label: 'smxr',
      startedAt: Date.now(),
      sessionId: 'sess-neg',
    });
    c1.close();

    // SIGKILL the daemon ONLY — the holder (and its PTY) survives.
    killDaemonProc(daemon);
    await until(() => daemon!.exitCode !== null || daemon!.signalCode !== null, 5000);
    await sleep(300);
    expect(pidAlive(holderPid)).toBe(true);

    // Fresh daemon B re-adopts the surviving holder under the SAME ptyId.
    daemon = await startDaemonProc();
    const cB = new Client(SOCK);
    await cB.ready();
    // Poll the real list for the re-adopted ptyId (adoption is async on daemon boot).
    let readopted = false;
    for (let i = 0; i < 50; i++) {
      const l = await cB.call('list');
      if (l.result.ptys.some((p: any) => p.ptyId === ptyId && p.alive)) {
        readopted = true;
        break;
      }
      await sleep(100);
    }
    expect(readopted).toBe(true);

    // reconcile must NOT restore — the entry matches an alive PTY in both lists.
    H.state.cwd = CONFIG_DIR;
    H.state.sessionId = 'sess-neg';
    H.state.mtime = Date.now();
    H.state.resumeArgv = stubArgs();

    const restored = await reconcile({ settleMs: 200 });
    expect(restored).toBe(0);

    // Still exactly one PTY (the original), ledger entry untouched.
    const after = await cB.call('list');
    const alive = after.result.ptys.filter((p: any) => p.alive);
    expect(alive).toHaveLength(1);
    expect(alive[0].ptyId).toBe(ptyId);

    const entries = await readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].ptyId).toBe(ptyId);
    expect(entries[0].sessionId).toBe('sess-neg');
    cB.close();
  }, 40000);
});

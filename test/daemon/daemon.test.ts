import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// daemon is plain CJS Node JS — require it, no build step.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startDaemon } = require('../../daemon/index.js');

/**
 * A tiny NDJSON client over the unix socket. Collects responses (by id) and
 * pushed events, and lets tests await either.
 */
class Client {
  sock: net.Socket;
  buffer = '';
  private pending = new Map<number, (v: any) => void>();
  events: any[] = [];
  private eventWaiters: { pred: (e: any) => boolean; resolve: (e: any) => void }[] = [];

  constructor(sockPath: string) {
    this.sock = net.connect(sockPath);
    this.sock.setEncoding('utf8');
    this.sock.on('data', (chunk: string) => this.onData(chunk));
  }

  ready() {
    return new Promise<void>((resolve, reject) => {
      this.sock.once('connect', () => resolve());
      this.sock.once('error', reject);
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      } else if (msg.event !== undefined) {
        this.events.push(msg);
        for (let i = this.eventWaiters.length - 1; i >= 0; i--) {
          if (this.eventWaiters[i].pred(msg)) {
            this.eventWaiters[i].resolve(msg);
            this.eventWaiters.splice(i, 1);
          }
        }
      }
    }
  }

  private idc = 0;
  call(method: string, params?: any): Promise<any> {
    const id = ++this.idc;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.sock.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  waitForEvent(pred: (e: any) => boolean, timeoutMs = 3000): Promise<any> {
    const existing = this.events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('event wait timed out')), timeoutMs);
      this.eventWaiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(t);
          resolve(e);
        },
      });
    });
  }

  close() {
    this.sock.destroy();
  }
}

describe('seshmuxd daemon', () => {
  let daemon: any;
  let configDir: string;
  let sockPath: string;

  beforeAll(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seshmux-daemon-test-'));
    daemon = await startDaemon({ configDir });
    sockPath = daemon.sockPath;
  });

  afterAll(async () => {
    // Force-kill any live PTYs and tear down — zero stray processes.
    try {
      daemon.ptyManager.killAll();
    } catch {}
    try {
      await daemon.close();
    } catch {}
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {}
  });

  it('creates socket and pidfile under the config dir', () => {
    expect(fs.existsSync(sockPath)).toBe(true);
    expect(fs.existsSync(daemon.pidPath)).toBe(true);
    expect(sockPath.startsWith(configDir)).toBe(true);
  });

  it('hello handshake returns protocol 1', async () => {
    const c = new Client(sockPath);
    await c.ready();
    const res = await c.call('hello');
    expect(res.result.protocol).toBe(1);
    expect(typeof res.result.version).toBe('string');
    // ptyCount is a count, not asserted to be 0 — startup tmux rehydration may
    // adopt pre-existing seshmux- sessions on the developer's machine.
    expect(typeof res.result.ptyCount).toBe('number');
    expect(res.result.ptyCount).toBeGreaterThanOrEqual(0);
    c.close();
  });

  it('spawns a pty, echoes write via a data event', async () => {
    const c = new Client(sockPath);
    await c.ready();
    const spawn = await c.call('spawn', { cwd: os.tmpdir(), args: ['/bin/cat'], cols: 80, rows: 24 });
    const ptyId = spawn.result.ptyId;
    expect(ptyId).toMatch(/^pty-/);

    // Real protocol flow: attach to subscribe to this pty's events.
    await c.call('attach', { ptyId });

    // /bin/cat echoes its input.
    await c.call('write', { ptyId, data: 'hello\n' });
    const evt = await c.waitForEvent((e) => e.event === 'data' && e.ptyId === ptyId && e.data.includes('hello'));
    expect(evt.data).toContain('hello');

    await c.call('kill', { ptyId });
    c.close();
  });

  it('spawns with $SESHMUX_PTY_ID set in the child env, equal to the returned ptyId (Spec 2)', async () => {
    const c = new Client(sockPath);
    await c.ready();
    const spawn = await c.call('spawn', {
      cwd: os.tmpdir(),
      args: ['/bin/sh', '-c', 'echo "PTYID=$SESHMUX_PTY_ID"'],
      cols: 80,
      rows: 24,
    });
    const ptyId = spawn.result.ptyId;
    await c.call('attach', { ptyId });
    const evt = await c.waitForEvent((e) => e.event === 'data' && e.ptyId === ptyId && e.data.includes('PTYID='));
    expect(evt.data).toContain(`PTYID=${ptyId}`);
    c.close();
  });

  it('second client attach replays the ring buffer', async () => {
    const c1 = new Client(sockPath);
    await c1.ready();
    const spawn = await c1.call('spawn', { cwd: os.tmpdir(), args: ['/bin/cat'], cols: 80, rows: 24 });
    const ptyId = spawn.result.ptyId;
    await c1.call('attach', { ptyId });

    await c1.call('write', { ptyId, data: 'scrollback-marker\n' });
    await c1.waitForEvent((e) => e.event === 'data' && e.ptyId === ptyId && e.data.includes('scrollback-marker'));

    // A fresh client that never saw the write gets the buffer replayed on attach.
    const c2 = new Client(sockPath);
    await c2.ready();
    const replayP = c2.waitForEvent((e) => e.event === 'data' && e.ptyId === ptyId && e.data.includes('scrollback-marker'));
    await c2.call('attach', { ptyId, fromScrollback: true });
    const replay = await replayP;
    expect(replay.data).toContain('scrollback-marker');

    await c1.call('kill', { ptyId });
    c1.close();
    c2.close();
  });

  it('list reports spawned ptys; kill removes it from alive set', async () => {
    const c = new Client(sockPath);
    await c.ready();
    const spawn = await c.call('spawn', { cwd: os.tmpdir(), args: ['/bin/cat'] });
    const ptyId = spawn.result.ptyId;
    await c.call('attach', { ptyId });

    let list = await c.call('list');
    const found = list.result.ptys.find((p: any) => p.ptyId === ptyId);
    expect(found).toBeTruthy();
    expect(found.alive).toBe(true);

    await c.call('kill', { ptyId });
    // exit event fires when cat dies.
    await c.waitForEvent((e) => e.event === 'exit' && e.ptyId === ptyId);
    list = await c.call('list');
    const after = list.result.ptys.find((p: any) => p.ptyId === ptyId);
    expect(after.alive).toBe(false);
    c.close();
  });

  it('write/resize/kill on unknown ptyId reply with an error, not a crash', async () => {
    const c = new Client(sockPath);
    await c.ready();
    const w = await c.call('write', { ptyId: 'pty-nope', data: 'x' });
    expect(w.error).toBeTruthy();
    const r = await c.call('resize', { ptyId: 'pty-nope', cols: 10, rows: 10 });
    expect(r.error).toBeTruthy();
    const k = await c.call('kill', { ptyId: 'pty-nope' });
    expect(k.error).toBeTruthy();
    // Daemon still responds after errors.
    const h = await c.call('hello');
    expect(h.result.protocol).toBe(1);
    c.close();
  });

  it('shutdown refuses while a pty is alive unless forced', async () => {
    const c = new Client(sockPath);
    await c.ready();
    const spawn = await c.call('spawn', { cwd: os.tmpdir(), args: ['/bin/cat'] });
    const ptyId = spawn.result.ptyId;
    await c.call('attach', { ptyId });

    const refused = await c.call('shutdown', {});
    expect(refused.error).toBeTruthy();
    expect(refused.error.message).toContain('refusing');

    // Clean up this pty so it doesn't leak; leave the daemon up for afterAll.
    await c.call('kill', { ptyId });
    await c.waitForEvent((e) => e.event === 'exit' && e.ptyId === ptyId);
    c.close();
  });

  it('sweeps dead pty entries past the grace period, keeps recently-exited ones (MEM-1)', async () => {
    const c = new Client(sockPath);
    await c.ready();
    const spawn = await c.call('spawn', { cwd: os.tmpdir(), args: ['/bin/cat'] });
    const ptyId = spawn.result.ptyId;
    await c.call('attach', { ptyId });
    await c.call('kill', { ptyId });
    await c.waitForEvent((e) => e.event === 'exit' && e.ptyId === ptyId);

    const pm = daemon.ptyManager;
    // Within grace: retained, so a re-attach/rehydrate of a just-exited PTY works.
    pm._sweepDead();
    expect(pm.has(ptyId)).toBe(true);
    // Past grace: swept out (entry + its ring freed).
    pm._ptys.get(ptyId).deadAt = Date.now() - 11 * 60 * 1000;
    pm._sweepDead();
    expect(pm.has(ptyId)).toBe(false);
    c.close();
  });

  it('caps the ring buffer by bytes on newline-free output (MEM-2)', () => {
    const { RING_BUFFER_BYTES } = require('../../daemon/protocol.js');
    const pm = daemon.ptyManager;
    const entry = { ring: [], ringLines: 0, ringBytes: 0 };
    const chunk = 'x'.repeat(100 * 1024); // 100KB, zero newlines
    for (let i = 0; i < 60; i++) pm._appendRing(entry, chunk); // ~6MB fed in
    // Bounded despite no newlines ever bumping the line counter.
    expect(entry.ringBytes).toBeLessThanOrEqual(RING_BUFFER_BYTES + chunk.length);
    expect(entry.ring.length).toBeGreaterThanOrEqual(1); // never fully drained
  });

  it('socket file is chmod 0600 (SEC-2)', () => {
    if (process.platform === 'win32') return;
    expect(fs.statSync(sockPath).mode & 0o777).toBe(0o600);
  });
});

// tmux-tier: gated (skips if tmux absent), kills its own seshmux- sessions in
// cleanup since they survive daemon death by design (would leak a tmux server).
function hasTmux(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const tmuxDescribe = hasTmux() ? describe : describe.skip;

// Strip $TMUX so the test queries the same (default) tmux server the daemon
// uses, even when the suite itself runs inside a tmux pane.
const { TMUX: _t, TMUX_PANE: _tp, ...TMUX_FREE_ENV } = process.env;

tmuxDescribe('seshmuxd tmux tier', () => {
  let daemon: any;
  let configDir: string;
  const bareName = 'test-' + process.pid;
  const fullName = 'seshmux-' + bareName;

  beforeAll(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seshmux-tmux-test-'));
    daemon = await startDaemon({ configDir });
  });

  afterAll(async () => {
    try {
      daemon.ptyManager.killAll();
    } catch {}
    try {
      await daemon.close();
    } catch {}
    // Kill the tmux session directly — it outlives the daemon by design.
    try {
      execFileSync('tmux', ['kill-session', '-t', fullName], { stdio: 'ignore', env: TMUX_FREE_ENV });
    } catch {}
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {}
  });

  it('spawns a tmux-tier session under the seshmux- prefix (caller passes bare name)', async () => {
    const c = new Client(daemon.sockPath);
    await c.ready();
    const spawn = await c.call('spawn', {
      cwd: os.tmpdir(),
      args: ['/bin/cat'],
      cols: 80,
      rows: 24,
      tmuxName: bareName,
    });
    const ptyId = spawn.result.ptyId;
    expect(ptyId).toMatch(/^pty-/);

    // list() reports the daemon-formed full tmux name.
    const list = await c.call('list');
    const found = list.result.ptys.find((p: any) => p.ptyId === ptyId);
    expect(found.tmuxName).toBe(fullName);

    // Attach + wait for first PTY output — proves the tmux client is up and
    // the session is registered before we shell out to `tmux ls`.
    await c.call('attach', { ptyId });
    await c.waitForEvent((e) => e.event === 'data' && e.ptyId === ptyId);

    // The real tmux server now has a matching session.
    const sessions = execFileSync('tmux', ['ls', '-F', '#{session_name}'], {
      encoding: 'utf8',
      env: TMUX_FREE_ENV,
    });
    expect(sessions).toContain(fullName);

    c.close();
  });

  it('seeds $SESHMUX_PTY_ID into a NEW tmux-tier pane via explicit -e (Spec 2 — plain env: does not propagate for tmux)', async () => {
    const c = new Client(daemon.sockPath);
    await c.ready();
    const tmuxBareName = 'test-env-' + process.pid;
    const spawn = await c.call('spawn', {
      cwd: os.tmpdir(),
      args: ['/bin/sh', '-c', 'echo "PTYID=$SESHMUX_PTY_ID"'],
      cols: 80,
      rows: 24,
      tmuxName: tmuxBareName,
    });
    const ptyId = spawn.result.ptyId;
    await c.call('attach', { ptyId });
    const evt = await c.waitForEvent((e) => e.event === 'data' && e.ptyId === ptyId && e.data.includes('PTYID='));
    expect(evt.data).toContain(`PTYID=${ptyId}`);

    try {
      execFileSync('tmux', ['kill-session', '-t', 'seshmux-' + tmuxBareName], { stdio: 'ignore', env: TMUX_FREE_ENV });
    } catch {}
    c.close();
  });

  it('history RPC returns tmux capture-pane scrollback for tmux-tier sessions', async () => {
    const histName = 'test-hist-' + process.pid;
    const fullHist = 'seshmux-' + histName;
    const c = new Client(daemon.sockPath);
    await c.ready();
    try {
      // Print enough lines to push early output into tmux HISTORY (above the
      // 24-row visible screen), then keep the pane alive with cat.
      const spawn = await c.call('spawn', {
        cwd: os.tmpdir(),
        args: ['/bin/sh', '-c', 'i=0; while [ $i -lt 60 ]; do echo "HISTLINE-$i"; i=$((i+1)); done; exec /bin/cat'],
        cols: 80,
        rows: 24,
        tmuxName: histName,
      });
      const ptyId = spawn.result.ptyId;
      await c.call('attach', { ptyId });
      await c.waitForEvent((e) => e.event === 'data' && e.ptyId === ptyId && e.data.includes('HISTLINE-59'));

      const res = await c.call('history', { ptyId, lines: 500 });
      // Early lines scrolled off-screen — only capture-pane history has them.
      expect(res.result.data).toContain('HISTLINE-0');
      expect(res.result.data).toContain('HISTLINE-10');
    } finally {
      try {
        execFileSync('tmux', ['kill-session', '-t', fullHist], { stdio: 'ignore', env: TMUX_FREE_ENV });
      } catch {}
      c.close();
    }
  });

  it('rehydrate skips sessions stamped by a DIFFERENT config dir, claims its own (no double-attach)', async () => {
    const ownName = 'test-own-' + process.pid;
    const fullOwn = 'seshmux-' + ownName;
    const c = new Client(daemon.sockPath);
    await c.ready();
    try {
      // Spawn a tmux-tier session under daemon A (configDir) — spawn stamps it
      // with @seshmux-config = A. Wait for output so the session truly exists.
      const spawn = await c.call('spawn', {
        cwd: os.tmpdir(),
        args: ['/bin/cat'],
        cols: 80,
        rows: 24,
        tmuxName: ownName,
      });
      await c.call('attach', { ptyId: spawn.result.ptyId });
      await c.waitForEvent((e) => e.event === 'data' && e.ptyId === spawn.result.ptyId);

      // Stamping is async (set-option retries until new-session settles) —
      // wait for the @seshmux-config stamp to land before booting the foreign
      // daemon, since the ownership guarantee starts at the stamp.
      // 15s headroom for set-option retries under full-suite load (isolation
      // needs <1s). NOTE: a rare fast-fail flake (~130ms, wrong stamp value)
      // was also observed here under load — that's a race, not this timeout;
      // if it recurs, capture the received value before touching the deadline.
      const deadline = Date.now() + 15000;
      let stamped = '';
      while (Date.now() < deadline) {
        try {
          stamped = execFileSync(
            'tmux',
            ['show-options', '-qv', '-t', fullOwn, '@seshmux-config'],
            { encoding: 'utf8', env: TMUX_FREE_ENV },
          ).trim();
        } catch {}
        if (stamped) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(stamped).toBe(configDir);

      // A FOREIGN daemon (different configDir) boots and rehydrates: it must
      // NOT claim A's session — this is the double-attach bug.
      const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smx-b-'));
      const foreign = await startDaemon({ configDir: foreignDir });
      try {
        const claimed = Object.values<any>((await new Promise((resolve) => {
          const fc = new Client(foreign.sockPath);
          fc.ready().then(async () => {
            const list = await fc.call('list');
            fc.close();
            resolve(list.result.ptys);
          });
        })) as any[]);
        expect(claimed.some((p: any) => p.tmuxName === fullOwn)).toBe(false);
      } finally {
        try {
          foreign.ptyManager.killAll();
        } catch {}
        await foreign.close();
        fs.rmSync(foreignDir, { recursive: true, force: true });
      }

      // A SIBLING daemon with the SAME configDir rehydrates and claims it.
      const sibling = await startDaemon({ configDir, sockPath: path.join(configDir, 'd2.sock'), pidPath: path.join(configDir, 'd2.pid') });
      try {
        const sc = new Client(sibling.sockPath);
        await sc.ready();
        const list = await sc.call('list');
        sc.close();
        expect(list.result.ptys.some((p: any) => p.tmuxName === fullOwn)).toBe(true);
      } finally {
        try {
          sibling.ptyManager.killAll();
        } catch {}
        await sibling.close();
      }
    } finally {
      try {
        execFileSync('tmux', ['kill-session', '-t', fullOwn], { stdio: 'ignore', env: TMUX_FREE_ENV });
      } catch {}
      c.close();
    }
  });
});

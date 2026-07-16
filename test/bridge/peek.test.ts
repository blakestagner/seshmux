// Spec 5 task 2/4: real-spawn daemon test for peekTerminal, following the
// test/term-bridge.test.ts pattern (real in-process daemon on a temp config
// dir, no full Fastify server, no mocking node-pty).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { catPty } from '../helpers/platform';
const require = createRequire(import.meta.url);
const { startDaemon } = require('../../daemon/index.js');

// daemon spawn's `args` is [file, ...execArgs] (daemon/holder.js reads args[0]
// as the spawn target) — cross-platform stand-in for the posix-only `/bin/cat`.
const catArgs = () => {
  const { file, args } = catPty();
  return [file, ...args];
};

describe('peekTerminal (real daemon)', () => {
  let daemon: any;
  let configDir: string;

  beforeAll(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seshmux-peek-test-'));
    daemon = await startDaemon({ configDir });
    process.env.SESHMUX_CONFIG_DIR = configDir;
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

  it('returns the last N ANSI-stripped lines of a live PTY scrollback', async () => {
    const { DaemonConnection } = await import('../../server/daemon-client');
    const { peekTerminal } = await import('../../server/lib/bridge/peek');

    const control = new DaemonConnection(daemon.sockPath);
    await control.connect();
    const { ptyId } = await control.spawn({ cwd: os.tmpdir(), args: catArgs() });

    // Write a distinctive marker THROUGH a subscribed connection and poll the
    // daemon's own list()/scrollback for it landing in the ring buffer BEFORE
    // peeking — avoids a race between the write and peekTerminal's own attach
    // (fixed-sleep-before-write would be fragile; polling for real state isn't).
    const writer = new DaemonConnection(daemon.sockPath);
    await writer.connect();
    let sawMarker = false;
    writer.onEvent((e) => {
      if (e.event === 'data' && e.ptyId === ptyId && typeof e.data === 'string' && e.data.includes('PEEK_MARKER_42')) {
        sawMarker = true;
      }
    });
    await writer.attach(ptyId, false);
    await writer.write(ptyId, 'echo PEEK_MARKER_42\n');
    await waitUntil(() => sawMarker, 2000);
    writer.close();

    const result = await peekTerminal(ptyId, 80);
    expect(result.ptyId).toBe(ptyId);
    expect(result.lines.some((l) => l.includes('PEEK_MARKER_42'))).toBe(true);
    // No raw ANSI/control bytes leaked through (stripAnsi ran on every line).
    for (const l of result.lines) expect(l).not.toMatch(/\x1b\[/);

    await control.kill(ptyId);
    control.close();
  }, 10000);

  it('caps returned lines at the requested count', async () => {
    const { DaemonConnection } = await import('../../server/daemon-client');
    const { peekTerminal } = await import('../../server/lib/bridge/peek');

    const control = new DaemonConnection(daemon.sockPath);
    await control.connect();
    const { ptyId } = await control.spawn({ cwd: os.tmpdir(), args: catArgs() });

    const writer = new DaemonConnection(daemon.sockPath);
    await writer.connect();
    let sawLast = false;
    writer.onEvent((e) => {
      if (e.event === 'data' && e.ptyId === ptyId && typeof e.data === 'string' && e.data.includes('LINE_09')) {
        sawLast = true;
      }
    });
    await writer.attach(ptyId, false);
    for (let i = 0; i < 10; i++) await writer.write(ptyId, `LINE_0${i}\n`);
    await waitUntil(() => sawLast, 2000);
    writer.close();

    const result = await peekTerminal(ptyId, 3);
    expect(result.lines.length).toBeLessThanOrEqual(3);
    // The tail of the requested window is the most recent lines.
    expect(result.lines[result.lines.length - 1]).toContain('LINE_09');

    await control.kill(ptyId);
    control.close();
  }, 10000);

  it('caps at MAX_PEEK_LINES even when a caller asks for more', async () => {
    const { DaemonConnection } = await import('../../server/daemon-client');
    const { peekTerminal, MAX_PEEK_LINES } = await import('../../server/lib/bridge/peek');

    const control = new DaemonConnection(daemon.sockPath);
    await control.connect();
    const { ptyId } = await control.spawn({ cwd: os.tmpdir(), args: catArgs() });

    const result = await peekTerminal(ptyId, 10_000);
    expect(result.lines.length).toBeLessThanOrEqual(MAX_PEEK_LINES);

    await control.kill(ptyId);
    control.close();
  }, 10000);
});

// R2-6: a NaN lines param (the REST route's Number('abc')) used to slip past the cap —
// Math.min/max propagate NaN and slice(-NaN) returns the WHOLE buffer. No daemon needed;
// inject a fake connection that replays many lines on attach.
describe('peekTerminal — NaN lines guard (R2-6)', () => {
  it('falls back to the 80-line default cap for a non-finite lines param', async () => {
    const { peekTerminal } = await import('../../server/lib/bridge/peek');
    const many = Array.from({ length: 200 }, (_, i) => `L${i}`).join('\n') + '\n';
    const fakeDial = async () => {
      let cb: (e: any) => void = () => {};
      return {
        onEvent: (fn: any) => { cb = fn; },
        attach: async (id: string) => { cb({ event: 'data', ptyId: id, data: many }); },
        close: () => {},
      } as any;
    };
    const result = await peekTerminal('pty1', NaN as any, { dial: fakeDial, settleMs: 5 });
    expect(result.lines.length).toBe(80); // capped to the default, not all 200
  });
});

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

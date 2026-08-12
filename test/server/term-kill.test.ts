// DELETE /api/term/:ptyId — closing a session tab must actually END the agent.
// Regression: the tab ✕ was a pure UI dismissal, so every "closed" session kept
// running (and piled up until non-tmux PTYs blocked a daemon upgrade).
//
// Real in-process daemon (same posture as scratch-integration.test.ts): the only
// way to prove the OS process is gone, not just the tab.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startDaemon } = require('../../daemon/index.js');
import { catPty } from '../helpers/platform';

async function poll<T>(cond: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 12000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

const posixDescribe = process.platform === 'win32' ? describe.skip : describe;

posixDescribe('DELETE /api/term/:ptyId (real daemon)', () => {
  let daemon: any;
  let configDir: string;
  let prevConfigDir: string | undefined;

  beforeAll(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smx-kill-'));
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

  it('kills the PTY, and no-ops on an unknown ptyId', async () => {
    const { dial } = await import('../../server/daemon-client');
    const { default: termRoutes } = await import('../../server/routes/term');

    const { file, args } = catPty();
    const conn = await dial();
    const { ptyId } = await conn.spawn({ cwd: configDir, args: [file, ...args], cols: 80, rows: 24 });
    conn.close();
    expect(await poll(async () => (await aliveIds()).has(ptyId), 'pty alive')).toBe(true);

    const f = Fastify();
    f.register(termRoutes as any);
    const res = await f.inject({ method: 'DELETE', url: `/api/term/${ptyId}` });
    expect(res.statusCode).toBe(200);
    expect(await poll(async () => !(await aliveIds()).has(ptyId), 'pty dead after close')).toBe(true);

    // Closing a tab whose PTY already died must still succeed — the UI can't be
    // blocked from closing by a session that's already gone.
    const again = await f.inject({ method: 'DELETE', url: '/api/term/pty-does-not-exist' });
    expect(again.statusCode).toBe(200);
    await f.close();
  });
});

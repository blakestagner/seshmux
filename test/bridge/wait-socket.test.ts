import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startWaitListener,
  requestWaitOverSocket,
  type WaitListener,
} from '../../server/lib/bridge/wait-socket';
import { defaultWaitForStatus } from '../../server/lib/bridge/mcp';
import { ipcPath } from '../../server/lib/ipc';

let dir: string;
let sock: string;
let listener: WaitListener | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wait-'));
  sock = join(dir, 'wait.sock');
  listener = null;
});
afterEach(async () => {
  if (listener) await listener.close();
  rmSync(dir, { recursive: true, force: true });
});

const req = { project: 'demo', session: 'latest', status: 'waiting' as const, timeoutSec: 30 };

describe('request/response round-trip', () => {
  it('client gets the status onRequest resolves with', async () => {
    listener = await startWaitListener({ socketPath: sock, onRequest: async () => ({ status: 'waiting' }) });
    expect(await requestWaitOverSocket(sock, req)).toEqual({ status: 'waiting' });
  });

  it('passes the full request (project/session/status/timeoutSec) to onRequest', async () => {
    let seen: unknown;
    listener = await startWaitListener({
      socketPath: sock,
      onRequest: async (r) => { seen = r; return { status: 'idle' }; },
    });
    await requestWaitOverSocket(sock, req);
    expect(seen).toMatchObject({ project: 'demo', session: 'latest', status: 'waiting', timeoutSec: 30 });
  });

  it('a real timeout result from onRequest passes through untouched', async () => {
    listener = await startWaitListener({ socketPath: sock, onRequest: async () => ({ status: 'timeout' }) });
    expect(await requestWaitOverSocket(sock, req)).toEqual({ status: 'timeout' });
  });
});

describe('FAIL-SAFE (never throws — degrades to {status:"timeout"})', () => {
  it('resolves {status:"timeout"} when no listener is present (connection refused)', async () => {
    const result = await requestWaitOverSocket(join(dir, 'nonexistent.sock'), req);
    expect(result).toEqual({ status: 'timeout' });
  });

  it('resolves {status:"timeout"} when the server dies mid-wait (EOF before reply)', async () => {
    listener = await startWaitListener({
      socketPath: sock,
      onRequest: () => new Promise(() => {}), // hangs
    });
    const pending = requestWaitOverSocket(sock, req);
    await listener.close();
    listener = null;
    expect(await pending).toEqual({ status: 'timeout' });
  });

  it('onRequest throwing resolves {status:"timeout", error} on the LISTENER side (still replies, doesn\'t hang the client)', async () => {
    listener = await startWaitListener({
      socketPath: sock,
      onRequest: async () => {
        throw new Error('boom');
      },
    });
    const result = await requestWaitOverSocket(sock, req);
    expect(result.status).toBe('timeout');
    expect(result.error).toMatch(/boom/);
  });

  it('malformed request → listener replies a timeout result, not a hang', async () => {
    const net = await import('node:net');
    listener = await startWaitListener({ socketPath: sock, onRequest: async () => ({ status: 'waiting' }) });
    // Raw client connect must go through ipcPath() like the product's own
    // connect() calls — win32 has no fs-path socket to connect to.
    const conn = net.createConnection(ipcPath(sock));
    const reply = await new Promise<string>((resolve) => {
      conn.on('connect', () => conn.write('not json\n'));
      conn.on('data', (d) => resolve(d.toString()));
    });
    conn.destroy();
    expect(JSON.parse(reply)).toEqual({ status: 'timeout', error: 'malformed request' });
  });
});

describe('malformed / client-side', () => {
  it('client resolves {status:"timeout"} on a malformed reply', async () => {
    const net = await import('node:net');
    const conns: import('node:net').Socket[] = [];
    const srv = net.createServer((c) => {
      conns.push(c);
      c.write('not json\n');
    });
    // Raw net.Server here (not the product's listener) — must still go through
    // ipcPath() like every real listen()/connect().
    await new Promise<void>((res) => srv.listen(ipcPath(sock), res));
    try {
      expect(await requestWaitOverSocket(sock, req)).toEqual({ status: 'timeout' });
    } finally {
      for (const c of conns) c.destroy();
      await new Promise<void>((res) => srv.close(() => res()));
    }
  });
});

describe('end-to-end: mcp defaultWaitForStatus ↔ listener', () => {
  it('routes through the real mcp client to the listener', async () => {
    const prev = process.env.SESHMUX_CONFIG_DIR;
    process.env.SESHMUX_CONFIG_DIR = dir; // defaultWaitForStatus resolves <dir>/wait.sock
    try {
      listener = await startWaitListener({
        socketPath: join(dir, 'wait.sock'),
        onRequest: async (r) => ({ status: r.status === 'waiting' ? 'waiting' : 'timeout' }),
      });
      expect(await defaultWaitForStatus({ project: 'demo', status: 'waiting' })).toEqual({ status: 'waiting' });
    } finally {
      if (prev === undefined) delete process.env.SESHMUX_CONFIG_DIR;
      else process.env.SESHMUX_CONFIG_DIR = prev;
    }
  });

  it('FAIL-SAFE: mcp client resolves timeout when no listener is running', async () => {
    const prev = process.env.SESHMUX_CONFIG_DIR;
    process.env.SESHMUX_CONFIG_DIR = dir; // no listener bound → connection refused → timeout
    try {
      expect(await defaultWaitForStatus({ project: 'demo', status: 'waiting' })).toEqual({ status: 'timeout' });
    } finally {
      if (prev === undefined) delete process.env.SESHMUX_CONFIG_DIR;
      else process.env.SESHMUX_CONFIG_DIR = prev;
    }
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startApprovalListener,
  requestApprovalOverSocket,
  type ApprovalListener,
} from '../../server/lib/bridge/approval-socket';
import { defaultRequestApproval } from '../../server/lib/bridge/mcp';
import { ipcPath } from '../../server/lib/ipc';

let dir: string;
let sock: string;
let listener: ApprovalListener | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'appr-'));
  sock = join(dir, 'approval.sock');
  listener = null;
});
afterEach(async () => {
  if (listener) await listener.close();
  rmSync(dir, { recursive: true, force: true });
});

const info = { requestId: 'r1', tool: 'ask_codex' as const, question: 'q?', cwd: '/tmp', hop: 1 };

describe('approve/deny round-trip', () => {
  it('client gets true when onRequest approves', async () => {
    listener = await startApprovalListener({ socketPath: sock, onRequest: async () => true });
    const approved = await requestApprovalOverSocket(sock, info);
    expect(approved).toBe(true);
  });

  it('client gets false when onRequest denies', async () => {
    listener = await startApprovalListener({ socketPath: sock, onRequest: async () => false });
    expect(await requestApprovalOverSocket(sock, info)).toBe(false);
  });

  it('passes the full request info (incl. requestId + hop) to onRequest', async () => {
    let seen: unknown;
    listener = await startApprovalListener({
      socketPath: sock,
      onRequest: async (i) => { seen = i; return true; },
    });
    await requestApprovalOverSocket(sock, info);
    expect(seen).toMatchObject({ requestId: 'r1', tool: 'ask_codex', question: 'q?', cwd: '/tmp', hop: 1 });
  });

  it('hands onRequest an expiresAt = now + timeoutMs (for the toast countdown)', async () => {
    let seen: { expiresAt?: number } = {};
    listener = await startApprovalListener({
      socketPath: sock,
      timeoutMs: 120_000,
      now: () => 1_000_000, // fixed clock → deterministic expiresAt
      onRequest: async (i) => { seen = i; return true; },
    });
    await requestApprovalOverSocket(sock, info);
    expect(seen.expiresAt).toBe(1_000_000 + 120_000);
  });
});

describe('FAIL-CLOSED (the security property)', () => {
  it('client denies when no listener is present (connection refused)', async () => {
    expect(await requestApprovalOverSocket(join(dir, 'nonexistent.sock'), info)).toBe(false);
  });

  it('client denies when the server dies mid-approval (EOF before reply)', async () => {
    // onRequest never resolves; we close the listener to simulate a mid-approval crash.
    listener = await startApprovalListener({
      socketPath: sock,
      onRequest: () => new Promise<boolean>(() => {}), // hangs
    });
    const pending = requestApprovalOverSocket(sock, info);
    await listener.close();
    listener = null;
    expect(await pending).toBe(false); // EOF → deny
  });

  it('listener denies on timeout, replies false (short timeoutMs, real timers)', async () => {
    // Inject a tiny timeoutMs so the 120s deadline is exercised without faking timers —
    // fake timers deadlock against the real unix-socket I/O in this round-trip.
    listener = await startApprovalListener({
      socketPath: sock,
      timeoutMs: 50,
      onRequest: () => new Promise<boolean>(() => {}), // human never answers
    });
    const approved = await requestApprovalOverSocket(sock, info);
    expect(approved).toBe(false); // server-side timeout → deny
  });
});

describe('end-to-end: mcp defaultRequestApproval ↔ listener', () => {
  const info2 = { target: 'codex' as const, question: 'run tests?', cwd: '/tmp', hop: 2 };

  it('approves through the real mcp client when the listener approves', async () => {
    const prev = process.env.SESHMUX_CONFIG_DIR;
    process.env.SESHMUX_CONFIG_DIR = dir; // defaultRequestApproval resolves <dir>/approval.sock
    try {
      listener = await startApprovalListener({
        socketPath: join(dir, 'approval.sock'),
        onRequest: async (i) => i.tool === 'ask_codex', // approve only codex
      });
      expect(await defaultRequestApproval(info2)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SESHMUX_CONFIG_DIR;
      else process.env.SESHMUX_CONFIG_DIR = prev;
    }
  });

  it('FAIL-CLOSED: mcp client denies when no listener is running', async () => {
    const prev = process.env.SESHMUX_CONFIG_DIR;
    process.env.SESHMUX_CONFIG_DIR = dir; // no listener bound → connection refused → deny
    try {
      expect(await defaultRequestApproval(info2)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SESHMUX_CONFIG_DIR;
      else process.env.SESHMUX_CONFIG_DIR = prev;
    }
  });
});

describe('malformed / client-side', () => {
  it('client denies on a malformed reply', async () => {
    // A raw listener that writes garbage instead of the protocol reply, then closes its side.
    const net = await import('node:net');
    const conns: import('node:net').Socket[] = [];
    const srv = net.createServer((c) => {
      conns.push(c);
      c.write('not json\n');
    });
    // Raw net.Server here (not the product's listener) — must still go through
    // ipcPath() like every real listen()/connect(), since win32 can't listen()
    // on a filesystem path.
    await new Promise<void>((res) => srv.listen(ipcPath(sock), res));
    try {
      expect(await requestApprovalOverSocket(sock, info)).toBe(false);
    } finally {
      for (const c of conns) c.destroy();
      await new Promise<void>((res) => srv.close(() => res()));
    }
  });
});

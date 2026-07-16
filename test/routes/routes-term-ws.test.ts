// WS /ws/term/:ptyId exit semantics (grid "exited" bug): an {t:'exit'} frame
// means THE PTY DIED — the client permanently stops reconnecting on it
// (ws-term.ts sawExit). Transport-layer failures (daemon dial fail, attach
// TIMEOUT under grid-mount burst, daemon connection drop) must close the
// socket WITHOUT an exit frame so the client's reconnect/backoff path retries.
// Only a real attach error (unknown/dead ptyId) may send exit.
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
// ts-expect-error — 'ws' ships untyped (transitive dep of @fastify/websocket);
// not worth an @types devDep for one test client.
// @ts-expect-error no type declarations
import WebSocket from 'ws';
import termRoutes from '../../server/routes/term';

type Frame = { t?: string; code?: number };

function fakeDaemon(attachImpl: () => Promise<void>) {
  return {
    onEvent: () => {},
    onClose: () => {},
    list: async () => ({ ptys: [] }),
    attach: attachImpl,
    write: async () => {},
    resize: async () => {},
    close: () => {},
  };
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function connect(dialFn: () => Promise<unknown>, query = ''): Promise<{ frames: Frame[]; closed: Promise<void> }> {
  app = Fastify();
  await app.register(import('@fastify/websocket'));
  await app.register(termRoutes, { dialFn: dialFn as never });
  const addr = await app.listen({ port: 0, host: '127.0.0.1' });
  const ws = new WebSocket(`${addr.replace('http', 'ws')}/ws/term/pty-1${query}`);
  const frames: Frame[] = [];
  ws.on('message', (raw: Buffer) => {
    try {
      frames.push(JSON.parse(raw.toString()));
    } catch {}
  });
  const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
  return { frames, closed };
}

describe('ws/term exit-frame semantics', () => {
  it('attach TIMEOUT closes WITHOUT an exit frame (client must reconnect, not die)', async () => {
    const { frames, closed } = await connect(async () =>
      fakeDaemon(() => Promise.reject(new Error('daemon attach timed out'))),
    );
    await closed;
    expect(frames.filter((f) => f.t === 'exit')).toEqual([]);
  });

  it('attach error for a dead/unknown pty DOES send the exit frame', async () => {
    const { frames, closed } = await connect(async () =>
      fakeDaemon(() => Promise.reject(new Error('no such pty'))),
    );
    await closed;
    expect(frames.some((f) => f.t === 'exit')).toBe(true);
  });

  it('daemon dial failure closes WITHOUT an exit frame', async () => {
    const { frames, closed } = await connect(async () => Promise.reject(new Error('ECONNREFUSED')));
    await closed;
    expect(frames.filter((f) => f.t === 'exit')).toEqual([]);
  });

  it('?replay=0 attaches WITHOUT the ring-buffer replay; default keeps it', async () => {
    // The client paints a width-correct capture-pane snapshot instead of raw
    // mixed-width ring bytes (the reattach-garble fix) — server must pass
    // fromScrollback=false through to daemon.attach.
    const calls: unknown[] = [];
    const d = () => {
      const daemon = fakeDaemon(async () => {});
      (daemon as { attach: unknown }).attach = async (_pty: string, fromScrollback: boolean) => {
        calls.push(fromScrollback);
      };
      return Promise.resolve(daemon);
    };
    await connect(d, '?replay=0');
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toEqual([false]);
    await app!.close();
    app = null;
    await connect(d);
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toEqual([false, true]);
  });
});

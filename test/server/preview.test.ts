import { describe, it, expect, beforeEach } from 'vitest';
import net from 'node:net';
import {
  _resetHttpCacheForTest,
  discoverPorts,
  filterHttp,
  frameBlock,
  isLoopbackUrl,
  mergePorts,
  parseNetstat,
  parseTasklist,
  probePort,
  scrapePorts,
  winListeners,
  type MachinePort,
} from '../../server/lib/preview';
import type { PortEntry } from '../../server/lib/ports';

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});

// Fixtures below are line-oriented command output; joining an array reads far
// better than one long embedded string.
const LF = '\n';

// Scraping PTY scrollback is the ONLY port source that works on win32 (ports.ts
// is lsof-only), so these cases are the Windows story, not a nicety.
describe('scrapePorts', () => {
  it('reads the banners real dev servers print', () => {
    const next = '   ▲ Next.js 15.1.0\n   - Local:        http://localhost:3000\n';
    const vite = '  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://192.168.1.5:5173/\n';
    expect(scrapePorts(next).map((p) => p.port)).toEqual([3000]);
    // The LAN address is deliberately not matched — only loopback hosts are.
    expect(scrapePorts(vite).map((p) => p.port)).toEqual([5173]);
  });

  it('normalizes bind addresses to something browsable', () => {
    expect(scrapePorts('listening on http://0.0.0.0:8080')[0]).toEqual({
      port: 8080,
      url: 'http://localhost:8080',
    });
    expect(scrapePorts('serving https://127.0.0.1:8443/')[0]).toEqual({
      port: 8443,
      url: 'https://localhost:8443',
    });
  });

  it('dedupes a port announced several times, keeping first-seen order', () => {
    const out = scrapePorts('http://localhost:3000\nhttp://127.0.0.1:4000\nhttp://localhost:3000');
    expect(out.map((p) => p.port)).toEqual([3000, 4000]);
  });

  it('survives ANSI-decorated output', () => {
    // Colour codes wrapping the URL, as a real dev server emits them.
    const raw = '  [32m➜[39m  [1mLocal[22m:   [36mhttp://localhost:5173/[39m';
    expect(scrapePorts(raw).map((p) => p.port)).toEqual([5173]);
  });

  it('ignores things that merely look like a URL', () => {
    expect(scrapePorts('see https://nextjs.org/docs for help')).toEqual([]);
    expect(scrapePorts('http://localhost:0 is not a port')).toEqual([]);
  });
});

// lsof knows pid/command/dir; a scrape knows a number. When both see a port,
// the richer record has to win or the ports panel loses its kill target.
describe('mergePorts', () => {
  const lsof: PortEntry[] = [{ port: 3000, pid: 42, command: 'node', dir: 'apps/web' }];

  it('prefers the process-derived record on overlap', () => {
    const out = mergePorts(lsof, [{ port: 3000, url: 'http://localhost:3000' }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ port: 3000, origin: 'process', pid: 42, dir: 'apps/web' });
  });

  it('keeps scraped ports lsof never saw, after the process ones', () => {
    const out = mergePorts(lsof, [{ port: 5173, url: 'http://localhost:5173' }]);
    expect(out.map((p) => [p.port, p.origin])).toEqual([
      [3000, 'process'],
      [5173, 'output'],
    ]);
  });
});

// The scrollback scrape only finds servers started INSIDE a seshmux session.
// netstat is what finds the one you started in VSCode — the common case.
describe('parseNetstat', () => {
  // Real `netstat -ano -p TCP` output, including the 0.0.0.0 bind a Next dev
  // server actually uses. Matching only 127.0.0.1 would miss it entirely.
  const out = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       36040',
    '  TCP    [::]:3000              [::]:0                 LISTENING       36040',
    '  TCP    127.0.0.1:4800         0.0.0.0:0              LISTENING       38228',
    '  TCP    192.168.1.20:7000      0.0.0.0:0              LISTENING       999',
    '  TCP    127.0.0.1:50959        127.0.0.1:4800         ESTABLISHED     40528',
    '',
  ].join(LF);

  it('takes wildcard and loopback binds, collapsing v4+v6 of one server', () => {
    expect(parseNetstat(out)).toEqual([
      { port: 3000, pid: 36040, command: '' },
      { port: 4800, pid: 38228, command: '' },
    ]);
  });

  it('ignores a LAN-only bind that localhost could not reach', () => {
    expect(parseNetstat(out).some((p) => p.port === 7000)).toBe(false);
  });

  it('ignores non-LISTENING rows', () => {
    expect(parseNetstat(out).some((p) => p.port === 50959)).toBe(false);
  });

  it('returns nothing for empty or garbage input', () => {
    expect(parseNetstat('')).toEqual([]);
    expect(parseNetstat('not netstat output at all')).toEqual([]);
  });
});

describe('parseTasklist', () => {
  it('reads image names, tolerating a comma inside one', () => {
    const out = [
      '"node.exe","36040","Console","1","250,168 K"',
      '"My App, Inc.exe","999","Console","1","10 K"',
    ].join(LF);
    expect(parseTasklist(out).get(36040)).toBe('node.exe');
    expect(parseTasklist(out).get(999)).toBe('My App, Inc.exe');
  });
});

describe('winListeners', () => {
  const netstat = [
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       36040',
    '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
    '  TCP    127.0.0.1:5040         0.0.0.0:0              LISTENING       7777',
  ].join(LF);
  const tasks = ['"node.exe","36040","Console","1","250 K"', '"System","4","Services","0","1 K"'].join(LF);
  const runner = async (cmd: string) => (cmd === 'netstat' ? netstat : tasks);

  it('names the owner and drops Windows system services', async () => {
    if (process.platform !== 'win32') return; // guarded: [] off win32 by contract
    const out = await winListeners(runner);
    // :445 is System (dropped). :5040 has no tasklist row — an unknown owner is
    // KEPT, since tasklist omits other users' processes and an elevated dev
    // server would otherwise vanish.
    expect(out).toEqual([
      { port: 3000, pid: 36040, command: 'node.exe' },
      { port: 5040, pid: 7777, command: '' },
    ]);
  });

  it('is empty off win32, where lsof answers a better question', async () => {
    if (process.platform === 'win32') return;
    expect(await winListeners(runner)).toEqual([]);
  });

  it('drops the OS dynamic range and puts dev ports first', async () => {
    if (process.platform !== 'win32') return;
    // A real sweep of this box found Spotify/Plex/editor helpers on random high
    // ports. Nobody types a port the OS handed out, so they are not browsable
    // in any useful sense — while :3000 must lead without the user reading on.
    const rows = [
      '  TCP    0.0.0.0:32400          0.0.0.0:0              LISTENING       11',
      '  TCP    0.0.0.0:52220          0.0.0.0:0              LISTENING       12',
      '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       13',
      '  TCP    0.0.0.0:8288           0.0.0.0:0              LISTENING       14',
    ].join(LF);
    const out = await winListeners(async (cmd) => (cmd === 'netstat' ? rows : ''));
    expect(out.map((p) => p.port)).toEqual([3000, 8288, 32400]);
  });
});

describe('filterHttp', () => {
  beforeEach(() => _resetHttpCacheForTest());

  const rows: MachinePort[] = [
    { port: 3000, pid: 1, command: 'node.exe' },
    { port: 5432, pid: 2, command: 'postgres.exe' },
  ];

  it('keeps only what answers HTTP — a netstat sweep is mostly not a web server', async () => {
    const out = await filterHttp(rows, async (p) => p === 3000);
    expect(out.map((p) => p.port)).toEqual([3000]);
  });

  it('caches by port AND pid, so a poll does not re-probe two dozen ports', async () => {
    let probes = 0;
    const probe = async () => {
      probes++;
      return true;
    };
    await filterHttp(rows, probe);
    await filterHttp(rows, probe);
    expect(probes).toBe(2); // once each, not twice each

    // A port whose OWNER changed is a different server and must be re-tested.
    await filterHttp([{ port: 3000, pid: 99, command: 'node.exe' }], probe);
    expect(probes).toBe(3);
  });

  it('treats a probe that throws as not-HTTP rather than failing the sweep', async () => {
    const out = await filterHttp(rows, async () => {
      throw new Error('boom');
    });
    expect(out).toEqual([]);
  });
});

describe('discoverPorts', () => {
  it('drops scraped ports that are no longer listening', async () => {
    // The banner outlives the server — ^C does not erase scrollback.
    const ports = await discoverPorts({
      histories: ['http://localhost:3000\nhttp://localhost:4000'],
      probe: async (p) => p === 4000,
    });
    expect(ports.map((p) => p.port)).toEqual([4000]);
  });

  it('offers the most recently printed port first', async () => {
    // A restart on a taken port: :3000 was announced earlier in the session,
    // then the server came back on :3001. Both still answer (an unrelated
    // process took :3000), so ordering is the only thing that puts the user on
    // the server they just started.
    const ports = await discoverPorts({
      histories: ['- Local: http://localhost:3000\n^C\nPort 3000 in use\n- Local: http://localhost:3001'],
      probe: async () => true,
    });
    expect(ports.map((p) => p.port)).toEqual([3001, 3000]);
  });

  it('never probes a port lsof already proved', async () => {
    let probes = 0;
    const ports = await discoverPorts({
      processPorts: [{ port: 3000, pid: 1, command: 'node', dir: '' }],
      histories: ['http://localhost:3000'],
      probe: async () => {
        probes++;
        return true;
      },
    });
    expect(probes).toBe(0);
    expect(ports.map((p) => p.port)).toEqual([3000]);
  });

  it('offers a machine-wide port the session never printed (the VSCode case)', async () => {
    const ports = await discoverPorts({
      machinePorts: [{ port: 3000, pid: 36040, command: 'node.exe' }],
      probe: async () => false, // never consulted: netstat already proved it live
    });
    expect(ports).toEqual([
      { port: 3000, url: 'http://localhost:3000', origin: 'listening', pid: 36040, command: 'node.exe' },
    ]);
  });

  it('keeps a session-printed port ABOVE machine-wide ones, and skips its probe', async () => {
    let probes = 0;
    const ports = await discoverPorts({
      histories: ['- Local: http://localhost:5173'],
      machinePorts: [
        { port: 3000, pid: 1, command: 'node.exe' },
        { port: 5173, pid: 2, command: 'node.exe' },
      ],
      probe: async () => {
        probes++;
        return true;
      },
    });
    // :5173 is this session's, so it leads and stays `output` — netstat
    // confirming it must not demote it to an unattributed machine port.
    expect(ports.map((p) => [p.port, p.origin])).toEqual([
      [5173, 'output'],
      [3000, 'listening'],
    ]);
    expect(probes).toBe(0);
  });

  it('reports a probe that throws as dead rather than failing the request', async () => {
    const ports = await discoverPorts({
      histories: ['http://localhost:3000'],
      probe: async () => {
        throw new Error('socket blew up');
      },
    });
    expect(ports).toEqual([]);
  });
});

describe('probePort', () => {
  it('sees a real listener and not a closed port', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      expect(await probePort(port)).toBe(true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
    // Same port, now closed.
    expect(await probePort(port, 300)).toBe(false);
  });
});

// A blank iframe with the reason only in a devtools console is the worst
// failure this panel can have, so the header check has to be right.
describe('frameBlock', () => {
  it('catches X-Frame-Options in its usual spellings', () => {
    expect(frameBlock(headers({ 'x-frame-options': 'DENY' }))).toBe('xfo');
    expect(frameBlock(headers({ 'x-frame-options': 'SameOrigin' }))).toBe('xfo');
  });

  it('does NOT block on ALLOW-FROM, which no current browser honours', () => {
    // Chrome never implemented it, Firefox removed it: the frame renders. Calling
    // it blocked would refuse a working page — the over-reporting the contract bans.
    expect(frameBlock(headers({ 'x-frame-options': 'ALLOW-FROM https://example.com' }))).toBe(null);
  });

  it("catches frame-ancestors 'none' but not a permissive one", () => {
    expect(frameBlock(headers({ 'content-security-policy': "frame-ancestors 'none'" }))).toBe('csp');
    expect(frameBlock(headers({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none';" }))).toBe(
      'csp',
    );
    // Under-report rather than over-report: seshmux's own origin varies by port,
    // so a page that might load must never be pre-emptively refused.
    expect(frameBlock(headers({ 'content-security-policy': "frame-ancestors 'self' http://localhost:4700" }))).toBe(
      null,
    );
  });

  it('passes a bare dev server', () => {
    expect(frameBlock(headers({}))).toBe(null);
    expect(frameBlock(headers({ 'content-security-policy': "default-src 'self'" }))).toBe(null);
  });
});

// The frame check makes the SERVER fetch a client-supplied URL. Without this
// guard that is an SSRF primitive aimed at the user's own network.
describe('isLoopbackUrl', () => {
  it('accepts only loopback http(s)', () => {
    expect(isLoopbackUrl('http://localhost:3000/admin')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isLoopbackUrl('https://localhost:8443')).toBe(true);
  });

  it('refuses everything else, including the near-misses', () => {
    expect(isLoopbackUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isLoopbackUrl('http://intranet.corp:8080')).toBe(false);
    expect(isLoopbackUrl('file:///etc/passwd')).toBe(false);
    expect(isLoopbackUrl('http://localhost.evil.com/')).toBe(false);
    expect(isLoopbackUrl('http://127.0.0.1.evil.com/')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});

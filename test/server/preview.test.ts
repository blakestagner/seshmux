import { describe, it, expect } from 'vitest';
import net from 'node:net';
import {
  discoverPorts,
  frameBlock,
  isLoopbackUrl,
  mergePorts,
  probePort,
  scrapePorts,
} from '../../server/lib/preview';
import type { PortEntry } from '../../server/lib/ports';

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});

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
    expect(frameBlock(headers({ 'x-frame-options': 'ALLOW-FROM https://example.com' }))).toBe('xfo');
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

import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkUpdate,
  applyUpdate,
  compareVersions,
  detectInstallMethod,
  isDaemonStale,
  _resetUpdateCache,
} from '../../server/lib/update';

// Fake fetch that returns a registry-shaped body, a status, or throws (offline/timeout).
function fakeFetch(opts: { version?: string; status?: number; throws?: boolean }) {
  return async () => {
    if (opts.throws) throw new Error('network down');
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ name: 'seshmux', version: opts.version ?? '9.9.9' }),
    } as any;
  };
}

describe('compareVersions (numeric segments, not lexical)', () => {
  it('orders single-digit segments', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
  it('orders MULTI-digit segments numerically (0.9.0 < 0.10.0)', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
  });
});

describe('checkUpdate matrix', () => {
  beforeEach(() => _resetUpdateCache()); // module-level 6h cache leaks across cases otherwise
  const base = { current: '1.0.0', argvRealPath: '/usr/local/lib/node_modules/seshmux/bin/seshmux.js', globalPrefix: '/usr/local' };

  it('newer latest → updateAvailable true', async () => {
    const r = await checkUpdate({ ...base, fetchFn: fakeFetch({ version: '1.1.0' }) });
    expect(r).toMatchObject({ current: '1.0.0', latest: '1.1.0', updateAvailable: true });
  });
  it('older latest → false', async () => {
    const r = await checkUpdate({ ...base, fetchFn: fakeFetch({ version: '0.9.0' }) });
    expect(r.updateAvailable).toBe(false);
  });
  it('equal latest → false', async () => {
    const r = await checkUpdate({ ...base, fetchFn: fakeFetch({ version: '1.0.0' }) });
    expect(r.updateAvailable).toBe(false);
  });
  it('multi-digit newer (0.9.0 → 0.10.0) → true', async () => {
    const r = await checkUpdate({ ...base, current: '0.9.0', fetchFn: fakeFetch({ version: '0.10.0' }) });
    expect(r.updateAvailable).toBe(true);
  });
  it('404 (unpublished) → false, never throws, latest=current', async () => {
    const r = await checkUpdate({ ...base, fetchFn: fakeFetch({ status: 404 }) });
    expect(r).toMatchObject({ updateAvailable: false, latest: '1.0.0' });
  });
  it('network error / timeout → false, never throws', async () => {
    const r = await checkUpdate({ ...base, fetchFn: fakeFetch({ throws: true }) });
    expect(r.updateAvailable).toBe(false);
  });
});

describe('detectInstallMethod', () => {
  it('npx when path contains _npx cache segment', () => {
    expect(detectInstallMethod({ argvRealPath: '/Users/x/.npm/_npx/abc123/node_modules/seshmux/bin/seshmux.js', globalPrefix: '/usr/local' })).toBe('npx');
  });
  it('global when realpath under the npm global prefix', () => {
    expect(detectInstallMethod({ argvRealPath: '/usr/local/lib/node_modules/seshmux/bin/seshmux.js', globalPrefix: '/usr/local' })).toBe('global');
  });
  it('local otherwise', () => {
    expect(detectInstallMethod({ argvRealPath: '/Users/x/dev/seshmux/bin/seshmux.js', globalPrefix: '/usr/local' })).toBe('local');
  });
});

describe('applyUpdate', () => {
  it('rejects when installMethod is npx (no self-update from npx cache)', async () => {
    await expect(
      applyUpdate({
        installMethod: 'npx',
        current: '1.0.0',
        exec: async () => ({ stdout: '' }),
      }),
    ).rejects.toThrow(/npx/i);
  });

  it('runs npm i -g, captures log, returns ok + previous version for rollback', async () => {
    let ranCmd = '';
    const res = await applyUpdate({
      installMethod: 'global',
      current: '1.2.3',
      exec: async (cmd: string, args: string[]) => {
        ranCmd = `${cmd} ${args.join(' ')}`;
        return { stdout: 'added 1 package' };
      },
    });
    expect(ranCmd).toContain('npm');
    expect(ranCmd).toContain('seshmux@latest');
    expect(res.ok).toBe(true);
    expect(res.log).toContain('added 1 package');
    expect(res.previous).toBe('1.2.3'); // captured BEFORE install for rollback instructions
  });

  it('returns ok:false with log when npm fails, does not throw', async () => {
    const res = await applyUpdate({
      installMethod: 'global',
      current: '1.0.0',
      exec: async () => {
        throw Object.assign(new Error('EACCES'), { stderr: 'permission denied' });
      },
    });
    expect(res.ok).toBe(false);
    expect(res.log.toLowerCase()).toContain('permission denied');
  });
});

// Regression: detectInstallMethod realpath'd argv but NOT the npm prefix, so a symlinked
// global prefix (macOS /tmp -> /private/tmp, homebrew /usr/local, some nvm layouts) compared
// a resolved path against an unresolved one, missed, and reported a global install as 'local'.
// That silently hides the update button, since we refuse `npm i -g` for non-global installs.
// Found by booting the packed tarball, not by unit tests — fake paths never hit the symlink.
describe('detectInstallMethod — symlinked global prefix', () => {
  it('still reports global when `npm prefix -g` returns a symlink to the real prefix', async () => {
    const { mkdtemp, mkdir, writeFile, symlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const base = await mkdtemp(join(tmpdir(), 'smx-prefix-'));
    const realPrefix = join(base, 'real');
    const linkedPrefix = join(base, 'link');
    const binDir = join(realPrefix, 'lib', 'node_modules', 'seshmux', 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, 'seshmux.js'), '');
    await symlink(realPrefix, linkedPrefix);

    // argv[1] resolves through realpath to the REAL path; npm reports the SYMLINK.
    expect(
      detectInstallMethod({
        argvRealPath: join(realPrefix, 'lib', 'node_modules', 'seshmux', 'bin', 'seshmux.js'),
        globalPrefix: linkedPrefix,
      }),
    ).toBe('global');
  });
});

// The button announced an update and then reliably failed to install it. checkUpdate fetches the
// registry directly and saw 0.1.1; `npm i -g seshmux@latest` re-resolved through npm's CACHED
// packument and died with "ETARGET: No matching version found for seshmux@0.1.1". Everyone whose
// cache predates the release — i.e. every existing user, the only people who can click it — hit
// this. Fix: install the exact version check resolved, with fresh metadata.
describe('applyUpdate — pins the resolved version (ETARGET regression)', () => {
  it('installs the exact target with fresh metadata, not the @latest tag', async () => {
    const calls: string[][] = [];
    await applyUpdate({
      installMethod: 'global',
      current: '0.1.0',
      target: '0.1.1',
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { stdout: 'ok' };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('seshmux@0.1.1');
    expect(calls[0]).not.toContain('seshmux@latest');
    expect(calls[0]).toContain('--prefer-online');
  });

  it('falls back to the tag when no target was resolved', async () => {
    const calls: string[][] = [];
    await applyUpdate({
      installMethod: 'global',
      current: '0.1.0',
      exec: async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: 'ok' }; },
    });
    expect(calls[0]).toContain('seshmux@latest');
  });

  it('refuses a target that is not a plain semver — it comes off an HTTP response', async () => {
    const calls: string[][] = [];
    await applyUpdate({
      installMethod: 'global',
      current: '0.1.0',
      target: '--registry=http://evil.example',
      exec: async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: 'ok' }; },
    });
    expect(calls[0]).toContain('seshmux@latest'); // fell back, did not pin the junk
    expect(calls[0].join(' ')).not.toContain('evil.example');
  });
});

describe('isDaemonStale', () => {
  it('is true only when the server is strictly newer than the daemon', () => {
    expect(isDaemonStale('0.9.0', '0.10.0')).toBe(true);
    expect(isDaemonStale('1.0.0', '1.0.0')).toBe(false);
    expect(isDaemonStale('1.1.0', '1.0.0')).toBe(false); // daemon ahead (dev tree) — no nag
  });

  it('never nags when either version is unknown (dev server / unreachable daemon)', () => {
    expect(isDaemonStale('', '1.0.0')).toBe(false);
    expect(isDaemonStale('1.0.0', '')).toBe(false);
    expect(isDaemonStale(null, null)).toBe(false);
    expect(isDaemonStale(undefined, undefined)).toBe(false);
  });
});

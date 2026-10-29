import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import lib from '../../bin/lib/install-scripts.js';

// bin/lib/install-scripts.js is plain CJS (bin/ ships unbuilt) — import the module object and
// destructure, as test/bin/host.test.ts does.
const { NATIVE_PTY_DEP, npmGlobalInstallArgs, blockedInstallScripts, nativePtyProblem, nativePtyWarning } = lib as {
  NATIVE_PTY_DEP: string;
  npmGlobalInstallArgs: (spec: string) => string[];
  blockedInstallScripts: (out: string) => string[];
  nativePtyProblem: (root: string | null, out: string, env?: { platform?: string; arch?: string; abi?: string }) => string | null;
  nativePtyWarning: (problem: string, version: string) => string;
};

// Verbatim stderr of `npm i -g seshmux@0.9.0 --prefer-online` under npm 12.0.2 on Windows,
// 2026-10-20. npm exited 0. The result had no conpty.node and ended every session at spawn.
const BLOCKED_STDERR = `npm warn deprecated prebuild-install@7.1.3: No longer maintained. Please contact the author of the relevant native addon; alternatives are available.
npm warn install-scripts 3 packages had install scripts blocked because they are not covered by allowScripts:
npm warn install-scripts   seshmux@0.9.0 (preinstall: node -e "if(+process.versions.node.split('.')[0]<20){console.error('\n  seshmux needs Node >=20 (you have '+process.version+').\n  Upgrade Node, then reinstall: https://nodejs.org\n');process.exit(1)}"; postinstall: node bin/postinstall.js)
npm warn install-scripts   @homebridge/node-pty-prebuilt-multiarch@0.13.1 (install: node scripts/check-prebuild.js || prebuild-install --verbose || node scripts/install.js; postinstall: node scripts/post-install.js)
npm warn install-scripts   @parcel/watcher@2.6.0 (install: node scripts/build-from-source.js)
npm warn install-scripts
npm warn install-scripts Run \`npm install -g --allow-scripts=seshmux,@homebridge/node-pty-prebuilt-multiarch,@parcel/watcher\` to allow these scripts once, or \`npm config set allow-scripts=seshmux,@homebridge/node-pty-prebuilt-multiarch,@parcel/watcher --location=user\` to allow them for all global installs.
`;

const CLEAN_STDERR =
  'npm warn deprecated prebuild-install@7.1.3: No longer maintained. Please contact the author of the relevant native addon; alternatives are available.\n';

describe('npmGlobalInstallArgs', () => {
  it('pins the spec with fresh metadata and allows seshmux + node-pty install scripts', () => {
    const args = npmGlobalInstallArgs('seshmux@0.9.1');
    expect(args.slice(0, 3)).toEqual(['i', '-g', 'seshmux@0.9.1']);
    expect(args).toContain('--prefer-online');
    expect(args).toContain('--allow-scripts=seshmux,@homebridge/node-pty-prebuilt-multiarch');
  });
});

describe('blockedInstallScripts', () => {
  it('names every package npm blocked, scoped ones included, in npm order', () => {
    expect(blockedInstallScripts(BLOCKED_STDERR)).toEqual(['seshmux', NATIVE_PTY_DEP, '@parcel/watcher']);
  });
  it('ignores the header and the "Run `npm install -g --allow-scripts=…`" hint', () => {
    const hintOnly = BLOCKED_STDERR.split('\n').filter((l) => /packages had|Run `npm/.test(l)).join('\n');
    expect(hintOnly).toContain('allow-scripts='); // the hint really is in the sample
    expect(blockedInstallScripts(hintOnly)).toEqual([]);
  });
  it('is empty for a clean install (deprecation warnings are not blocks)', () => {
    expect(blockedInstallScripts(CLEAN_STDERR)).toEqual([]);
    expect(blockedInstallScripts('')).toEqual([]);
  });
});

// A fake seshmux package root whose node-pty has exactly the given files.
function fakeRoot(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'smx-pty-'));
  const dep = join(root, 'node_modules', ...NATIVE_PTY_DEP.split('/'));
  mkdirSync(dep, { recursive: true });
  writeFileSync(join(dep, 'package.json'), '{"name":"' + NATIVE_PTY_DEP + '"}');
  for (const f of files) {
    const p = join(dep, ...f.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '');
  }
  return root;
}

describe('nativePtyProblem', () => {
  it('flags node-pty blocked in npm output, regardless of disk', () => {
    const root = fakeRoot(['build/Release/conpty.node']);
    expect(nativePtyProblem(root, BLOCKED_STDERR)).toMatch(/blocked.*node-pty-prebuilt-multiarch/);
    expect(nativePtyProblem(null, BLOCKED_STDERR)).toMatch(/blocked/);
  });
  it('is null for clean output when no root is given to inspect', () => {
    expect(nativePtyProblem(null, CLEAN_STDERR)).toBeNull();
  });

  it('win32: wants build/Release/conpty.node, accepts the winpty pty.node fallback', () => {
    const win = { platform: 'win32', arch: 'x64' };
    expect(nativePtyProblem(fakeRoot([]), '', win)).toMatch(/no native binary.*conpty\.node/);
    expect(nativePtyProblem(fakeRoot(['build/Release/conpty.node']), '', win)).toBeNull();
    expect(nativePtyProblem(fakeRoot(['build/Release/pty.node']), '', win)).toBeNull();
    // the linux prebuilds the tarball ships do not help a Windows machine
    expect(nativePtyProblem(fakeRoot(['prebuilds/linux-x64/node.abi127.node']), '', win)).toMatch(/no native binary/);
  });

  it('posix: accepts the bundled prebuild for this platform/abi or a built pty.node', () => {
    const linux = { platform: 'linux', arch: 'x64', abi: '127' };
    expect(nativePtyProblem(fakeRoot(['prebuilds/linux-x64/node.abi127.node']), '', linux)).toBeNull();
    expect(nativePtyProblem(fakeRoot(['prebuilds/linux-x64/node.abi127.musl.node']), '', linux)).toBeNull();
    expect(nativePtyProblem(fakeRoot(['prebuilds/linux-x64/node.abi115.node']), '', linux)).toMatch(/no native binary/);
    const mac = { platform: 'darwin', arch: 'arm64', abi: '127' };
    expect(nativePtyProblem(fakeRoot(['build/Release/pty.node']), '', mac)).toBeNull();
    expect(nativePtyProblem(fakeRoot([]), '', mac)).toMatch(/no native binary/);
  });

  it('is null when node-pty cannot be located at all (nothing sensible to say)', () => {
    expect(nativePtyProblem(mkdtempSync(join(tmpdir(), 'smx-empty-')), '')).toBeNull();
  });

  it('passes on the real repo install (this checkout can spawn PTYs)', () => {
    expect(nativePtyProblem(join(__dirname, '..', '..'), '')).toBeNull();
  });
});

describe('nativePtyWarning', () => {
  it('states the problem and ends with the exact reinstall command', () => {
    const msg = nativePtyWarning('npm blocked the install script of ' + NATIVE_PTY_DEP, '0.9.1');
    expect(msg).toMatch(/^\[seshmux\] live terminals cannot start: npm blocked/);
    expect(msg.trim().split('\n').pop()!.trim()).toBe(
      'npm i -g seshmux@0.9.1 --allow-scripts=seshmux,@homebridge/node-pty-prebuilt-multiarch',
    );
  });
});

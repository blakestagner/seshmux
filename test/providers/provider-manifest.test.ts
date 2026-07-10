// Spec 4 — needs-input pattern manifests: override seam + malformed-file fallback.
// Regression gate (byte-identical fixture behavior) lives in test/needs-input.test.ts, which
// already exercises loadNeedsInputPatterns via ClaudeProvider/CodexProvider construction.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadNeedsInputPatterns } from '../../server/lib/providers/manifest';

describe('loadNeedsInputPatterns', () => {
  const prev = process.env.SESHMUX_CONFIG_DIR;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seshmux-manifest-'));
    process.env.SESHMUX_CONFIG_DIR = dir;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.SESHMUX_CONFIG_DIR;
    else process.env.SESHMUX_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the shipped manifest when no override file exists', () => {
    const patterns = loadNeedsInputPatterns('claude');
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.every((re) => re instanceof RegExp)).toBe(true);
  });

  it('a valid override file wholly replaces the shipped patterns', () => {
    mkdirSync(join(dir, 'manifests'), { recursive: true });
    writeFileSync(
      join(dir, 'manifests', 'claude.json'),
      JSON.stringify({ provider: 'claude', version: 1, waiting: ['CUSTOM_MARKER'] }),
    );
    const patterns = loadNeedsInputPatterns('claude');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].test('some CUSTOM_MARKER text')).toBe(true);
    expect(patterns[0].test('1. Yes')).toBe(false); // shipped pattern gone, not merged
  });

  it('a malformed override (bad JSON) falls back to the shipped manifest', () => {
    mkdirSync(join(dir, 'manifests'), { recursive: true });
    writeFileSync(join(dir, 'manifests', 'claude.json'), 'not json{{{');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const patterns = loadNeedsInputPatterns('claude');
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.some((re) => re.source.includes('Yes'))).toBe(true); // shipped pattern present
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a malformed override (wrong shape) falls back to the shipped manifest', () => {
    mkdirSync(join(dir, 'manifests'), { recursive: true });
    writeFileSync(join(dir, 'manifests', 'claude.json'), JSON.stringify({ provider: 'claude' })); // no "waiting"
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const patterns = loadNeedsInputPatterns('claude');
    expect(patterns.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it('compiles pattern sources with the case-insensitive flag', () => {
    mkdirSync(join(dir, 'manifests'), { recursive: true });
    writeFileSync(
      join(dir, 'manifests', 'claude.json'),
      JSON.stringify({ provider: 'claude', version: 1, waiting: ['hello'] }),
    );
    const [re] = loadNeedsInputPatterns('claude');
    expect(re.flags).toContain('i');
    expect(re.test('HELLO world')).toBe(true);
  });
});

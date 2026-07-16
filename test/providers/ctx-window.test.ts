import { describe, it, expect } from 'vitest';
import { windowForModel } from '../../server/lib/providers/claude';

describe('windowForModel', () => {
  it('matches 1M-window model families (real bare model strings from disk)', () => {
    expect(windowForModel('claude-opus-4-8')).toBe(1_000_000);
    expect(windowForModel('claude-fable-5')).toBe(1_000_000);
    expect(windowForModel('claude-opus-4-6')).toBe(1_000_000);
  });

  it('defaults everything else to 200k', () => {
    expect(windowForModel('claude-sonnet-5')).toBe(200_000); // sonnet stays 200k, matches Claude Code TUI
    expect(windowForModel('claude-sonnet-4-6')).toBe(200_000);
    expect(windowForModel('claude-haiku-4-5-20251001')).toBe(200_000); // real dated haiku string
    expect(windowForModel('claude-opus-4-1')).toBe(200_000); // pre-4.5 opus, must NOT match 1M
    expect(windowForModel('opus')).toBe(200_000); // short alias, unknown
    expect(windowForModel('')).toBe(200_000); // empty, safe default
  });
});

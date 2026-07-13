// Codex-undetected gating: every cross-agent surface derives from the SAME
// detected-provider set (GET /api/env's `commands` keys). These cover the two
// derivations the UI renders off — the filter chips (Rail) and the bridge
// target (Transcript / TerminalPane handoff + review buttons).
import { describe, it, expect } from 'vitest';
import { providersFromEnv, bridgeTarget, provFilterOptions } from '../../lib/client/providers';

describe('providersFromEnv', () => {
  it('reads the detected set from /api/env commands keys', () => {
    expect(providersFromEnv({ commands: { claude: {}, codex: {} } })).toEqual(['claude', 'codex']);
    expect(providersFromEnv({ commands: { claude: {} } })).toEqual(['claude']);
  });

  it('falls back to claude when env is missing or empty', () => {
    expect(providersFromEnv(null)).toEqual(['claude']);
    expect(providersFromEnv({})).toEqual(['claude']);
  });
});

describe('provFilterOptions (Rail provider filter chips)', () => {
  it('hides the whole segmented control when only one provider is detected', () => {
    expect(provFilterOptions(['claude'])).toEqual([]);
  });

  it('renders All + one chip per detected provider when both exist', () => {
    expect(provFilterOptions(['claude', 'codex'])).toEqual([
      { id: 'all', label: 'All' },
      { id: 'claude', label: 'Claude' },
      { id: 'codex', label: 'Codex' },
    ]);
  });
});

describe('bridgeTarget (Continue in… / Review with… buttons)', () => {
  it('is null from a claude session when codex is undetected — no bridge buttons render', () => {
    expect(bridgeTarget('claude', ['claude'])).toBeNull();
  });

  it('targets codex from a claude session when codex is detected', () => {
    expect(bridgeTarget('claude', ['claude', 'codex'])).toBe('codex');
  });

  it('targets claude from a codex session (the gate is "is the OTHER provider detected")', () => {
    expect(bridgeTarget('codex', ['claude', 'codex'])).toBe('claude');
    expect(bridgeTarget('codex', ['codex'])).toBeNull();
  });
});

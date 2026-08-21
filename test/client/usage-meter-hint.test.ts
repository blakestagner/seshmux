import { describe, it, expect } from 'vitest';
import { meterHint, windowLabel } from '../../components/UsageMeters/UsageMeters';

// Labels and tooltips are derived from windowMinutes rather than from a per-provider
// hardcoding, so a vendor changing its window length can't make the bar lie. Assertions
// stay locale-agnostic (CI's ICU data is not the developer's) — they check the branch
// taken, not the exact formatted string.
const NOW = Date.parse('2026-08-21T12:00:00Z');
const m = (windowMinutes: number, pct: number, resetsAt: string | null = null, scope?: 'opus') => ({
  windowMinutes,
  pct,
  resetsAt,
  ...(scope ? { scope } : {}),
});

describe('windowLabel', () => {
  it('names the common windows', () => {
    expect(windowLabel(m(300, 0))).toBe('5h');
    expect(windowLabel(m(10_080, 0))).toBe('wk');
  });

  it('follows the window rather than assuming 5h', () => {
    expect(windowLabel(m(360, 0))).toBe('6h'); // vendor widened the session window
    expect(windowLabel(m(30, 0))).toBe('30m');
    expect(windowLabel(m(4320, 0))).toBe('3d');
  });

  it('distinguishes the opus-only weekly bar from the all-models one', () => {
    expect(windowLabel(m(10_080, 0, null, 'opus'))).toBe('wk opus');
  });
});

describe('meterHint', () => {
  it('omits the reset clause when there is no timestamp', () => {
    expect(meterHint('Claude Code', m(300, 62.4), undefined, NOW)).toBe(
      'Claude Code 5h window: 62% used',
    );
  });

  it('omits it for an unparseable timestamp rather than rendering Invalid Date', () => {
    const s = meterHint('Claude Code', m(300, 5, 'whenever'), undefined, NOW);
    expect(s).toBe('Claude Code 5h window: 5% used');
    expect(s).not.toMatch(/Invalid/);
  });

  it('renders a clock time when the reset is inside 24h', () => {
    const s = meterHint('Claude Code', m(300, 25, '2026-08-21T19:50:00+00:00'), undefined, NOW);
    expect(s).toMatch(/^Claude Code 5h window: 25% used · resets /);
    expect(s).toMatch(/\d:\d\d/);
    expect(s).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  });

  it('names the day, and says "weekly", for the seven-day window', () => {
    const s = meterHint('Codex CLI', m(10_080, 33, '2026-08-23T22:00:00+00:00'), undefined, NOW);
    expect(s).toMatch(/^Codex CLI weekly: 33% used · resets /);
    expect(s).toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  });

  it('caveats a stale snapshot with its age, in minutes then hours', () => {
    const mins = meterHint('Codex CLI', m(300, 8), '2026-08-21T11:00:00Z', NOW);
    expect(mins).toContain('as of 60m ago');
    const hrs = meterHint('Codex CLI', m(300, 8), '2026-08-20T12:00:00Z', NOW);
    expect(hrs).toContain('as of 24h ago');
  });

  it('does not caveat a fresh snapshot, or a live reading with no capture time', () => {
    expect(meterHint('Codex CLI', m(300, 8), '2026-08-21T11:58:00Z', NOW)).not.toContain('as of');
    expect(meterHint('Claude Code', m(300, 8), undefined, NOW)).not.toContain('as of');
  });

  it('rounds the percentage the same way the visible number does', () => {
    expect(meterHint('x', m(300, 62.4), undefined, NOW)).toContain('62%');
    expect(meterHint('x', m(300, 62.6), undefined, NOW)).toContain('63%');
  });
});

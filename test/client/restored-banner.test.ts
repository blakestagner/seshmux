import { describe, it, expect } from 'vitest';
import { shouldShowRestoreBanner } from '../../lib/client/store';

// Auto-restore-sessions Stage 8: silent by default (spec §4). The banner is
// OPT-IN — opposite polarity of the `!== false` notification toggles — so it
// shows ONLY when `restoreNotice === true` AND a session was actually restored.
describe('shouldShowRestoreBanner (opt-in gate, silent by default)', () => {
  it('undefined settings → silent even with a positive count', () => {
    expect(shouldShowRestoreBanner(undefined, 3)).toBe(false);
  });

  it('empty settings (default, key absent) → silent', () => {
    expect(shouldShowRestoreBanner({}, 3)).toBe(false);
  });

  it('restoreNotice explicitly false → silent', () => {
    expect(shouldShowRestoreBanner({ restoreNotice: false }, 3)).toBe(false);
  });

  it('restoreNotice true but nothing restored (count 0) → silent', () => {
    expect(shouldShowRestoreBanner({ restoreNotice: true }, 0)).toBe(false);
  });

  it('restoreNotice true + count > 0 → shows', () => {
    expect(shouldShowRestoreBanner({ restoreNotice: true }, 1)).toBe(true);
    expect(shouldShowRestoreBanner({ restoreNotice: true }, 5)).toBe(true);
  });

  it('strict === true polarity: a truthy-but-not-true value stays silent', () => {
    expect(shouldShowRestoreBanner({ restoreNotice: 'yes' }, 3)).toBe(false);
    expect(shouldShowRestoreBanner({ restoreNotice: 1 }, 3)).toBe(false);
  });
});

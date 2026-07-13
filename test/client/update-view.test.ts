// Settings › Updates decision logic. The button runs `npm i -g` — offering it to an npx or
// local install would global-install seshmux for someone who never did one, so install method
// gating is the load-bearing case here.
import { describe, it, expect } from 'vitest';
import { updateView, type UpdateStatus } from '../../lib/client/update';

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  current: '0.1.0',
  latest: '0.1.0',
  updateAvailable: false,
  installMethod: 'global',
  ...over,
});

describe('updateView', () => {
  it('offers the button on a global install with a newer version', () => {
    const v = updateView(status({ latest: '0.2.0', updateAvailable: true }));
    expect(v.canApply).toBe(true);
    expect(v.message).toContain('v0.2.0');
    expect(v.tone).toBe('ok');
  });

  it('says up to date on a global install at the latest version', () => {
    const v = updateView(status());
    expect(v).toEqual({ canApply: false, message: 'up to date', tone: 'neutral' });
  });

  it('reports a failed check instead of a fake "up to date"', () => {
    const v = updateView(null, true);
    expect(v.canApply).toBe(false);
    expect(v.message).toMatch(/registry/);
    expect(v.tone).toBe('bad');
  });

  it('never offers the button for an npx run, even when an update exists', () => {
    const v = updateView(status({ latest: '0.2.0', updateAvailable: true, installMethod: 'npx' }));
    expect(v.canApply).toBe(false);
    expect(v.message).toMatch(/npx seshmux@latest/);
  });

  it('never offers the button for a local install — that is a package.json bump', () => {
    const v = updateView(status({ latest: '0.2.0', updateAvailable: true, installMethod: 'local' }));
    expect(v.canApply).toBe(false);
    expect(v.message).toMatch(/package\.json/);
  });

  it('shows a checking state before the first response', () => {
    expect(updateView(null)).toEqual({ canApply: false, message: 'checking…', tone: 'neutral' });
  });
});

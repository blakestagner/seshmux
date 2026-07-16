// Pure decision logic for the Settings › Updates section. Kept out of the component so it can
// be tested without a DOM (vitest has no jsdom here — see test/client/provider-gating.test.ts).
//
// `npm i -g` is only correct for a GLOBAL install: an npx run has a throwaway cache and a local
// dep belongs to the project's package.json. Both get an explanation, never a button.

export type InstallMethod = 'global' | 'npx' | 'local';

export interface UpdateStatus {
  current: string;
  latest: string;
  updateAvailable: boolean;
  installMethod: InstallMethod;
}

export interface UpdateView {
  /** true = render the enabled "Update & restart" button. */
  canApply: boolean;
  /** Right-hand status text for the row. */
  message: string;
  /** Tone for the status span: ok = update ready, bad = check failed, neutral otherwise. */
  tone: 'ok' | 'bad' | 'neutral';
}

// status === null + failed === false means "still checking".
export function updateView(status: UpdateStatus | null, failed = false): UpdateView {
  if (failed) return { canApply: false, message: "couldn't reach the npm registry", tone: 'bad' };
  if (!status) return { canApply: false, message: 'checking…', tone: 'neutral' };

  if (status.installMethod === 'npx') {
    return {
      canApply: false,
      message: 'running via npx — run `npx seshmux@latest` to update',
      tone: 'neutral',
    };
  }
  if (status.installMethod === 'local') {
    return {
      canApply: false,
      message: 'local install — update seshmux in your package.json',
      tone: 'neutral',
    };
  }
  if (status.updateAvailable) {
    return { canApply: true, message: `v${status.latest} available`, tone: 'ok' };
  }
  return { canApply: false, message: 'up to date', tone: 'neutral' };
}

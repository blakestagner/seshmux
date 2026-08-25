// Shared shape for subscription rate-limit meters, so the route and the UI handle every
// provider identically and "add Codex beside Claude" stays an array append.
//
// Deliberately semantic, not presentational: the server reports the WINDOW, the client
// decides it renders as "5h" or "wk". Providers disagree on how they express a window
// (Claude names its buckets, Codex reports window_minutes), so normalising to minutes here
// is what lets one renderer serve both.

import type { ProviderId } from './types';

export type UsageMeter = {
  /** Length of the rolling window in minutes. 300 = 5h, 10080 = weekly. */
  windowMinutes: number;
  /** Percentage of the allowance consumed, 0-100. */
  pct: number;
  /** ISO timestamp the window rolls over, or null when the provider didn't say. */
  resetsAt: string | null;
  /** Set when the meter covers one model family rather than all models. */
  scope?: 'opus';
};

export type ProviderLimits = {
  provider: ProviderId;
  meters: UsageMeter[];
  /**
   * ISO timestamp the numbers were observed. Absent for a live reading (Claude, queried
   * on demand); present for a snapshot (Codex, only written while it runs) so the UI can
   * caveat numbers that may have gone stale.
   */
  capturedAt?: string;
};

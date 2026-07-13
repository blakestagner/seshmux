'use client';

// Which agent providers actually exist on THIS machine — the single client-side
// source of truth. GET /api/env's `commands` map is built by iterating
// getProviders(), and the server only includes a provider there when its CLI or
// its session store was detected. So its keys ARE the detected set (hard rule 3
// safe: provider ids only, no paths/binaries).
//
// Page fetches /api/env once before it renders the app, so consumers below the
// provider never see an "unknown" state — no cross-agent buttons that flash in
// and get yanked.

import { createContext, useContext } from 'react';
import type { ProviderId } from './types';

const Ctx = createContext<ProviderId[]>(['claude']);

export const DetectedProvidersProvider = Ctx.Provider;

export function useDetectedProviders(): ProviderId[] {
  return useContext(Ctx);
}

export function providersFromEnv(env: { commands?: Record<string, unknown> } | null): ProviderId[] {
  const ids = Object.keys(env?.commands ?? {}) as ProviderId[];
  // ponytail: claude is the floor — an empty map means detection failed, and the
  // SetupGate already covers "no agent at all".
  return ids.length ? ids : ['claude'];
}

/** Bridge/handoff target for a session: the other DETECTED provider, or null when
 *  there isn't one. null => hide every cross-agent affordance. */
export function bridgeTarget(source: ProviderId, detected: ProviderId[]): ProviderId | null {
  return detected.find((p) => p !== source) ?? null;
}

const PROV_CHIP_LABEL: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex' };

/** Provider identity (the ✳/⬡ badge on tabs, session rows, cards, statusbar) only
 *  says something when there is more than one provider to tell apart. On a
 *  single-agent machine every badge would read the same, so they are all noise. */
export function showsProviderIdentity(detected: ProviderId[]): boolean {
  return detected.length > 1;
}

/** Rail's provider-filter chips. One detected provider = nothing to filter
 *  between, so the whole segmented control disappears (a filter with a single
 *  real option is noise). */
export function provFilterOptions(detected: ProviderId[]): { id: 'all' | ProviderId; label: string }[] {
  if (detected.length < 2) return [];
  return [{ id: 'all' as const, label: 'All' }, ...detected.map((p) => ({ id: p, label: PROV_CHIP_LABEL[p] }))];
}

// Shared four-state status selector — the ONE place that buckets live sessions
// into working/waiting/done/idle. TopNav's counter and the Agents view both
// render from this, so they can never disagree (spec: docs/todo/2026-07-10-
// agents-view.md). Pure function, no store/react imports.
//
// Bucket precedence: waiting > done(unviewed) > working > idle — "blocked on
// you NOW" outranks "finished while you were away".
'use client';

import type { Tab } from './store';
import type { ProviderId, SessionMeta } from './types';

export type AgentBucket = 'working' | 'waiting' | 'done' | 'idle';

export interface AgentCardData {
  tabId: string;
  title: string;
  provider?: ProviderId;
  branch?: string | null;
  isWorkspace: boolean;
  lastActivityTs: number | null;
  startedAt: number | null;
  durationMs: number | null;
  bucket: AgentBucket;
}

export interface Rollup {
  counts: Record<AgentBucket, number>;
  cards: AgentCardData[];
}

function bucketOf(tab: Tab): AgentBucket {
  // Raw agent status when the store has seen a live event for this tab;
  // legacy tab.status as fallback (rehydrated tabs before their first event:
  // 'live'→working keeps the pre-agents-view counter behavior, 'done'→idle).
  const ni = tab.ni ?? ({ live: 'working', waiting: 'waiting', done: 'idle' } as const)[tab.status ?? 'live'];
  if (ni === 'waiting') return 'waiting';
  if (tab.unviewed) return 'done';
  return ni === 'working' ? 'working' : 'idle';
}

export function rollup(tabs: Tab[], sessionsById?: Map<string, SessionMeta>): Rollup {
  const counts: Record<AgentBucket, number> = { working: 0, waiting: 0, done: 0, idle: 0 };
  const cards: AgentCardData[] = [];
  for (const tab of tabs) {
    if (tab.kind !== 'term' || !tab.ptyId) continue;
    const bucket = bucketOf(tab);
    counts[bucket] += 1;
    const meta = tab.sessionId ? sessionsById?.get(tab.sessionId) : undefined;
    cards.push({
      tabId: tab.id,
      title: meta?.title || tab.label,
      provider: tab.provider,
      branch: tab.branch ?? meta?.branch ?? null,
      isWorkspace: !!(tab.branch ?? meta?.branch)?.startsWith('agent/'),
      lastActivityTs: tab.lastStatusTs ?? meta?.mtime ?? null,
      startedAt: meta?.startedAt ?? null,
      durationMs: meta?.durationMs ?? null,
      bucket,
    });
  }
  return { counts, cards };
}

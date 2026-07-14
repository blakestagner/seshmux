'use client';
// Agents view (docs/todo/2026-07-10-agents-view.md): kanban status board over
// the LIVE sessions (open term tabs) — Waiting · Done · Working · Idle, most
// actionable first. Cards click through to their tab (tabs view), which
// focuses the tab and so drains a Done card via the Spec-3 unviewed clear.
// Titles/durations join from session meta, fetched here for just the projects
// that have live tabs (session lists live in Rail-local state, not the store).

import { useEffect, useMemo, useState } from 'react';
import { useAppState } from '../../lib/client/store';
import { rollup, type AgentBucket, type AgentCardData } from '../../lib/client/status-rollup';
import { getSessions } from '../../lib/client/api';
import type { SessionMeta } from '../../lib/client/types';
import StatusDot from '../ui/StatusDot/StatusDot';
import ProviderBadge from '../ui/ProviderBadge/ProviderBadge';
import BranchLabel from '../ui/BranchLabel/BranchLabel';
import styles from './AgentsView.module.scss';

const COLUMNS: { bucket: AgentBucket; label: string; empty: string }[] = [
  { bucket: 'waiting', label: 'Waiting', empty: 'nothing waiting' },
  { bucket: 'done', label: 'Done', empty: 'nothing unseen' },
  { bucket: 'working', label: 'Working', empty: 'nothing running' },
  { bucket: 'idle', label: 'Idle', empty: 'nothing idle' },
];

const DOT: Record<AgentBucket, 'live' | 'waiting' | 'unviewed' | 'neutral'> = {
  working: 'live',
  waiting: 'waiting',
  done: 'unviewed',
  idle: 'neutral',
};

function ago(ts: number | null, now: number): string | null {
  if (!ts) return null;
  const m = Math.max(0, Math.round((now - ts) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function dur(card: AgentCardData, now: number): string | null {
  // Live session: duration keeps growing — prefer now-startedAt; recorded
  // durationMs is the fallback for metas without a start time.
  const ms = card.startedAt ? now - card.startedAt : card.durationMs;
  if (!ms || ms < 60000) return null;
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function AgentsView() {
  const { state, dispatch } = useAppState();
  const [metaById, setMetaById] = useState<Map<string, SessionMeta>>(new Map());
  // Lazy clock: relative ages re-render every 30s while mounted, no per-second timers.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Titles/durations: fetch session lists for just the projects with live tabs.
  const projectIds = useMemo(
    () => [...new Set(state.tabs.filter((t) => t.kind === 'term' && t.ptyId && t.projectId).map((t) => t.projectId!))],
    [state.tabs],
  );
  useEffect(() => {
    let cancelled = false;
    Promise.all(projectIds.map((id) => getSessions(id, { limit: 50 }).catch(() => [])))
      .then((lists) => {
        if (cancelled) return;
        const m = new Map<string, SessionMeta>();
        for (const s of lists.flat()) m.set(s.id, s);
        setMetaById(m);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIds.join(',')]);

  const { counts, cards } = rollup(state.tabs, metaById);

  if (cards.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.mark}>◫</div>
        <div>No live sessions — start one from the rail.</div>
      </div>
    );
  }

  return (
    <div className={styles.board}>
      {COLUMNS.map((col) => (
        <div key={col.bucket} className={styles.column}>
          <div className={styles.colHead}>
            <StatusDot status={DOT[col.bucket]} size={7} />
            <span className={styles.colLabel}>{col.label}</span>
            <span className={styles.colCount}>{counts[col.bucket]}</span>
          </div>
          {cards.filter((c) => c.bucket === col.bucket).map((card) => (
            <button
              key={card.tabId}
              type="button"
              className={styles.card}
              onClick={() => {
                dispatch({ type: 'activateTab', id: card.tabId });
                dispatch({ type: 'setView', view: 'tabs' });
              }}
            >
              <span className={styles.cardTop}>
                <StatusDot status={DOT[card.bucket]} size={7} />
                <span className={styles.cardTitle}>{card.title}</span>
                {card.provider ? <ProviderBadge provider={card.provider} /> : null}
              </span>
              <span className={styles.cardMeta}>
                {card.branch ? (
                  <span className={styles.branch}>
                    {card.isWorkspace ? <span className={styles.workspaceMark} title="Workspace session">⑃</span> : null}
                    <BranchLabel branch={card.branch} />
                  </span>
                ) : null}
                {ago(card.lastActivityTs, now) ? <span>{ago(card.lastActivityTs, now)}</span> : null}
                {dur(card, now) ? <span>{dur(card, now)}</span> : null}
              </span>
            </button>
          ))}
          {counts[col.bucket] === 0 ? <div className={styles.colEmpty}>{col.empty}</div> : null}
        </div>
      ))}
    </div>
  );
}

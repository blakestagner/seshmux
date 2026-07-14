'use client';

import type { DragEvent } from 'react';
import { useState } from 'react';
import StatusDot from '../ui/StatusDot/StatusDot';
import ProviderBadge from '../ui/ProviderBadge/ProviderBadge';
import IconButton from '../ui/IconButton/IconButton';
import LinkChip from '../ui/LinkChip/LinkChip';
import { useAppState } from '../../lib/client/store';
import type { Tab } from '../../lib/client/store';
import styles from './Tabs.module.scss';

// Ported from mockup.html renderTabs() (~1398) + aperture pill-tab CSS
// (~805-845). Tab DnD reuses the store's moveTabBlock(from,to) action, which
// already implements buildBlocks()/tabDrop() semantics (~1425-1450) — moving
// a source tab moves its linked (handoff/review) tabs with it as one block.
const NEUTRAL_KINDS = new Set<Tab['kind']>(['transcript', 'settings', 'scratchpad', 'planoff']);

function dotStatus(tab: Tab): 'live' | 'waiting' | 'unviewed' | 'neutral' {
  if (NEUTRAL_KINDS.has(tab.kind)) return 'neutral';
  // Rollup precedence: waiting > done-unviewed > working/live.
  if (tab.status === 'waiting') return 'waiting';
  if (tab.unviewed) return 'unviewed';
  return 'live';
}

export default function Tabs() {
  const { state, dispatch } = useAppState();
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const tabs = state.tabs;

  function handleDrop(e: DragEvent, targetId: string) {
    e.preventDefault();
    if (dragId && dragId !== targetId) {
      dispatch({ type: 'moveTabBlock', from: dragId, to: targetId });
    }
    setDragId(null);
    setDragOverId(null);
  }

  return (
    <div className={styles.tabbar}>
      {tabs.map((t, i) => {
        const prev = tabs[i - 1];
        const isGroupStart = tabs[i + 1] && tabs[i + 1].linked && tabs[i + 1].linkSrc === t.sessionId;
        const isGroupEnd = t.linked && prev && prev.sessionId === t.linkSrc;
        return (
          // role="button" (not <button>) so the close IconButton can nest
          // without producing invalid button-in-button HTML (hydration error).
          <div
            key={t.id}
            role="button"
            tabIndex={0}
            draggable
            className={[
              styles.tab,
              t.id === state.activeTab ? styles.active : '',
              isGroupStart ? styles.groupStart : '',
              isGroupEnd ? styles.groupEnd : '',
              dragOverId === t.id ? styles.dragOver : '',
              dragId === t.id ? styles.dragging : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => dispatch({ type: 'activateTab', id: t.id })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                dispatch({ type: 'activateTab', id: t.id });
              }
            }}
            onDragStart={() => setDragId(t.id)}
            onDragOver={(e: DragEvent) => {
              if (!dragId || dragId === t.id) return;
              e.preventDefault();
              setDragOverId(t.id);
            }}
            onDrop={(e: DragEvent) => handleDrop(e, t.id)}
            onDragLeave={() => setDragOverId(null)}
            onDragEnd={() => {
              setDragId(null);
              setDragOverId(null);
            }}
          >
            <StatusDot status={dotStatus(t)} size={7} pulse={false} />
            {t.linked ? (
              <LinkChip kind={t.linkedKind === 'review' ? 'review' : 'handoff'} />
            ) : t.kind === 'planoff' ? (
              <LinkChip kind="planoff" />
            ) : null}
            {t.provider ? <ProviderBadge provider={t.provider} /> : null}
            <span className={styles.label}>{t.label}</span>
            <span className={styles.closeWrap}>
              <IconButton
                label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  // Closing a live term tab is a UI dismissal — the PTY stays
                  // alive (detach-safe) and the rail still lists it. Remember
                  // the dismissal so the boot rehydrate doesn't reopen it.
                  if (t.kind === 'term' && t.ptyId) {
                    try {
                      const key = 'seshmux-dismissed-ptys';
                      const cur: string[] = JSON.parse(localStorage.getItem(key) || '[]');
                      if (!cur.includes(t.ptyId)) localStorage.setItem(key, JSON.stringify([...cur, t.ptyId]));
                    } catch {
                      /* localStorage unavailable — dismissal just won't persist */
                    }
                  }
                  dispatch({ type: 'closeTab', id: t.id });
                }}
              >
                ✕
              </IconButton>
            </span>
          </div>
        );
      })}
    </div>
  );
}

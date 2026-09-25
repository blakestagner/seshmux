'use client';

import type { DragEvent } from 'react';
import { useState } from 'react';
import StatusDot from '../ui/StatusDot/StatusDot';
import ProviderBadge from '../ui/ProviderBadge/ProviderBadge';
import IconButton from '../ui/IconButton/IconButton';
import LinkChip from '../ui/LinkChip/LinkChip';
import InlineRename from '../ui/InlineRename/InlineRename';
import { useAppState } from '../../lib/client/store';
import {
  SESSION_NAME_MAX,
  customNameFor,
  normalizeSessionName,
  renameSession,
  useSessionNames,
} from '../../lib/client/session-names';
import { endTermSession } from '../../lib/client/api';
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
  // Session rename (issue #63): the tab being edited in place, if any.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const sessionNames = useSessionNames();
  // Leave edit mode; after Enter/Escape put keyboard focus back on the tab (the
  // field unmounts, so it would otherwise drop to <body>).
  function endRename(tabId: string, refocus: boolean) {
    setRenamingId(null);
    if (!refocus) return;
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tabId)}"]`)?.focus(),
    );
  }

  // Minimized tabs keep running (record + PTY alive) but leave the strip; the
  // rail's Sessions panel is where you get them back.
  const tabs = state.tabs.filter((t) => !t.minimized);

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
        // Only a tab that IS a known session can be renamed — a fresh live tab
        // has no sessionId until the agent writes its transcript.
        const canRename = !!t.sessionId && !!t.provider && (t.kind === 'term' || t.kind === 'transcript');
        const custom = customNameFor(sessionNames, t.provider, t.sessionId);
        const label = custom ?? t.label;
        const renaming = renamingId === t.id && canRename;
        return (
          // role="button" (not <button>) so the close IconButton can nest
          // without producing invalid button-in-button HTML (hydration error).
          <div
            key={t.id}
            role="button"
            tabIndex={0}
            draggable={!renaming}
            title={canRename ? `${label} — double-click or F2 to rename` : undefined}
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
            data-tab-id={t.id}
            onDoubleClick={canRename ? () => setRenamingId(t.id) : undefined}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                dispatch({ type: 'activateTab', id: t.id });
              } else if (e.key === 'F2' && canRename) {
                e.preventDefault();
                setRenamingId(t.id);
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
            <span className={styles.label}>
              {renaming ? (
                <InlineRename
                  initial={label}
                  placeholder={t.label}
                  maxLength={SESSION_NAME_MAX}
                  normalize={normalizeSessionName}
                  ariaLabel="Rename session"
                  onCancel={(viaKeyboard) => endRename(t.id, viaKeyboard)}
                  onCommit={(value, viaKeyboard) => {
                    endRename(t.id, viaKeyboard);
                    // Only a transcript tab's label IS the session's auto title; a term
                    // tab is labelled with the project name, which must not count as
                    // "typed the auto title back" (that would clear a deliberate name).
                    renameSession(t.provider!, t.sessionId!, value, t.kind === 'transcript' ? t.label : undefined).catch(
                      (err) => console.error('[seshmux] rename failed:', err),
                    );
                  }}
                />
              ) : (
                label
              )}
            </span>
            <span className={styles.closeWrap}>
              <IconButton
                label="Minimize tab"
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: 'minimizeTab', id: t.id });
                }}
              >
                –
              </IconButton>
              <IconButton
                label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  // Closing a live term tab ENDS the session (kills the PTY and,
                  // on the tmux tier, its tmux session). It used to be a pure UI
                  // dismissal, which left every "closed" agent running.
                  endTermSession(t);
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

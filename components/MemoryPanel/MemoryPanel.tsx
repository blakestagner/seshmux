'use client';

// The full-size memory surface: browsing and curating, where the dropdown is for loading.
//
// Same filters, same rows, same scope semantics — everything visual is composed from
// components/Memory, so the two surfaces cannot drift. What the panel adds is the full
// record body, pin/forget, authoring a fact by hand, and distillation.

import { useCallback, useEffect, useState } from 'react';
import Button from '../ui/Button/Button';
import IconButton from '../ui/IconButton/IconButton';
import TextInput from '../ui/TextInput/TextInput';
import MemoryFilters from '../Memory/MemoryFilters';
import MemoryRowItem from '../Memory/MemoryRowItem';
import { useMemorySearch } from '../Memory/useMemorySearch';
import {
  createMemory,
  deleteMemory,
  distillMemory,
  memoryStats,
  updateMemory,
  type MemoryRow,
  type MemoryStats,
} from '../../lib/client/api';
import type { ProviderId } from '../../lib/client/types';
import styles from './MemoryPanel.module.scss';

export type MemoryPanelProps = {
  projectId?: string;
  /** The session in view — enables distilling just that session. */
  sessionId?: string;
  provider?: ProviderId;
  branch?: string | null;
  /** Bumped by the {event:'memory'} ping. */
  refreshKey?: number;
  onClose?: () => void;
};

export default function MemoryPanel({
  projectId,
  sessionId,
  provider,
  branch,
  refreshKey = 0,
  onClose,
}: MemoryPanelProps) {
  const search = useMemorySearch(projectId, refreshKey, 200);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    memoryStats()
      .then((s) => alive && setStats(s))
      .catch(() => alive && setStats(null));
    return () => {
      alive = false;
    };
  }, [refreshKey, search.rows.length]);

  const act = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(label);
      setNote(null);
      try {
        await fn();
        search.refresh();
      } catch (err) {
        setNote({ text: err instanceof Error ? err.message : `${label} failed`, error: true });
      } finally {
        setBusy(null);
      }
    },
    [search],
  );

  const onPin = (row: MemoryRow) => act('pin', () => updateMemory(row.id, { pinned: !row.pinned }));
  const onDelete = (row: MemoryRow) => act('forget', () => deleteMemory(row.id));

  const onRemember = () => {
    if (!projectId || !draft.trim()) return;
    void act('remember', async () => {
      await createMemory({ projectId, text: draft, kind: 'lesson' });
      setDraft('');
    });
  };

  const onDistill = () => {
    if (!projectId || !sessionId) return;
    void act('distill', async () => {
      const res = await distillMemory({ projectId, sessionId, provider, branch });
      setNote(
        res.error
          ? { text: `distill failed: ${res.error}`, error: true }
          : {
              text: `distilled ${res.facts} fact${res.facts === 1 ? '' : 's'} from ${res.chunks} chunk${res.chunks === 1 ? '' : 's'}`,
              error: false,
            },
      );
    });
  };

  return (
    <div className={styles.panel}>
      {/* Same head as ChangesPanel/PortsPanel/TeamPanel, so the right-pane slot reads as
          one family and the panel is closable from the panel itself, not only its tab. */}
      <div className={styles.head}>
        <span className={styles.headGlyph} aria-hidden="true">
          ◆
        </span>
        <span className={styles.title}>Memory</span>
        {onClose ? (
          <IconButton label="Close memory" onClick={onClose}>
            ✕
          </IconButton>
        ) : null}
      </div>
      <MemoryFilters
        query={search.query}
        onQuery={search.setQuery}
        scope={search.scope}
        onScope={search.setScope}
        kinds={search.kinds}
        onToggleKind={search.toggleKind}
        placeholder="search everything agents have done here…"
      />

      <div className={styles.list}>
        {search.error ? <p className={styles.empty}>{search.error}</p> : null}
        {!search.error && search.rows.length === 0 ? (
          <p className={styles.empty}>
            {search.loading ? 'searching…' : 'Nothing remembered yet — memory fills in as sessions run.'}
          </p>
        ) : null}
        {search.rows.map((row) => (
          <MemoryRowItem
            key={row.id}
            row={row}
            expanded
            onPin={onPin}
            onDelete={onDelete}
            showRepo={search.scope === 'all'}
          />
        ))}
      </div>

      <div className={styles.compose}>
        <TextInput
          value={draft}
          onChange={setDraft}
          placeholder="remember something for future sessions here…"
          multiline={2}
        />
        <div className={styles.composeRow}>
          <Button disabled={!projectId || !draft.trim() || busy === 'remember'} onClick={onRemember}>
            {busy === 'remember' ? 'saving…' : 'Remember'}
          </Button>
          <Button
            disabled={!projectId || !sessionId || busy === 'distill'}
            title={
              sessionId
                ? 'Run the agent over this session to extract decisions and lessons'
                : 'Open a session to distil it'
            }
            onClick={onDistill}
          >
            {busy === 'distill' ? 'distilling…' : 'Distil session'}
          </Button>
          {note ? (
            <span className={note.error ? styles.noteError : styles.note}>{note.text}</span>
          ) : null}
          {stats ? (
            <span className={styles.stats}>
              {search.total} shown · {stats.total} stored · {stats.pinned} pinned
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

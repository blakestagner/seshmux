'use client';

// The statusbar memory dropdown — the primary way memory reaches a live session.
//
// A direct sibling of BridgeMenu: same useDropdown hook, same ui/Menu surface, same `up`
// positioning (the statusbar sits at the pane bottom). What it adds is a picker, because
// loading memory costs context and that cost should be visible BEFORE it is spent — hence
// the running token count in the footer.
//
// It opens on something useful rather than a blank box: with no query the server returns
// pinned records first, then the best of this repo by recency and use.

import { useEffect, useMemo, useState } from 'react';
import Button from '../ui/Button/Button';
import menu from '../ui/Menu/Menu.module.scss';
import { useDropdown } from '../ui/Menu/useDropdown';
import MemoryFilters from '../Memory/MemoryFilters';
import MemoryRowItem from '../Memory/MemoryRowItem';
import { useMemorySearch } from '../Memory/useMemorySearch';
import { packMemory, type MemoryRow } from '../../lib/client/api';
import { budgetLabel, estimateRowTokens, memoryPaste } from '../../lib/client/memory-paste';
import styles from './MemoryMenu.module.scss';

export type MemoryMenuProps = {
  projectId?: string;
  /** Writes into the live PTY. Undefined for a dead session — the trigger disables. */
  onSend?: (data: string) => void;
  /** Bumped by the {event:'memory'} ping so an agent's `remember` shows up live. */
  refreshKey?: number;
  budgetTokens?: number;
  /** Setting: press Enter after loading. Default false — the block is staged, not sent. */
  submitOnLoad?: boolean;
  onOpenPanel?: () => void;
  variant?: 'default' | 'chip';
  className?: string;
  up?: boolean;
};

export default function MemoryMenu({
  projectId,
  onSend,
  refreshKey = 0,
  budgetTokens = 1500,
  submitOnLoad = false,
  onOpenPanel,
  variant = 'chip',
  className,
  up = true,
}: MemoryMenuProps) {
  const { open, setOpen, wrapRef } = useDropdown();
  // The selected ROWS, not just their ids. Keeping ids alone meant the footer's token
  // count was derived by intersecting with the currently visible results, so narrowing the
  // query after selecting silently under-counted while Load still sent everything picked.
  const [selected, setSelected] = useState<MemoryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  const search = useMemorySearch(projectId, refreshKey + (open ? 1 : 0));

  // A fresh open is a fresh decision — carrying a stale selection across sessions or
  // filter states is never what someone means.
  useEffect(() => {
    if (!open) {
      setSelected([]);
      setNote(null);
    }
  }, [open]);

  const selectedIds = useMemo(() => new Set(selected.map((r) => r.id)), [selected]);
  const used = estimateRowTokens(selected);
  const over = used > budgetTokens;

  const toggle = (id: string) => {
    setNote(null);
    const row = search.rows.find((r) => r.id === id);
    setSelected((cur) => {
      if (cur.some((r) => r.id === id)) return cur.filter((r) => r.id !== id);
      return row ? [...cur, row] : cur;
    });
  };

  async function load() {
    if (!onSend || selected.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      // The server composes the block, so what lands here is byte-identical to what an
      // agent gets from recall_memory — one composer, not two.
      const packed = await packMemory(
        selected.map((r) => r.id),
        { budgetTokens, scope: search.scope },
      );
      const payload = memoryPaste(packed.text, { submit: submitOnLoad });
      if (!payload) {
        setNote({ text: 'nothing to load', error: false });
        return;
      }
      onSend(payload);
      setOpen(false);
      setSelected([]);
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : 'load failed', error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={styles.wrap} ref={wrapRef}>
      <Button
        variant={variant}
        className={className}
        title="Load memory from earlier sessions into this one"
        onClick={() => setOpen((v) => !v)}
      >
        ◆ memory <span className={styles.caret}>{up ? '▴' : '▾'}</span>
      </Button>
      {open ? (
        <div
          className={`${menu.menu} ${menu.flush} ${styles.menu} ${up ? styles.up : ''}`}
          role="dialog"
          aria-label="Agent memory"
        >
          <MemoryFilters
            query={search.query}
            onQuery={search.setQuery}
            scope={search.scope}
            onScope={search.setScope}
            kinds={search.kinds}
            onToggleKind={search.toggleKind}
            autoFocus
          />

          <div className={styles.list}>
            {search.error ? <p className={styles.empty}>{search.error}</p> : null}
            {!search.error && search.rows.length === 0 ? (
              <p className={styles.empty}>
                {search.loading
                  ? 'searching…'
                  : search.scope === 'project'
                    ? 'Nothing remembered for this repo yet. Try all repos.'
                    : 'Nothing remembered yet.'}
              </p>
            ) : null}
            {search.rows.map((row) => (
              <MemoryRowItem
                key={row.id}
                row={row}
                selected={selectedIds.has(row.id)}
                onToggle={toggle}
                showRepo={search.scope === 'all'}
              />
            ))}
          </div>

          <div className={styles.footer}>
            <span className={over ? styles.budgetOver : styles.budget}>
              {selected.length === 0
                ? `${search.total} match${search.total === 1 ? '' : 'es'}`
                : `${selected.length} selected · ${budgetLabel(used, budgetTokens)}`}
            </span>
            {note ? (
              <span className={note.error ? styles.noteError : styles.note}>{note.text}</span>
            ) : null}
            <span className={styles.actions}>
              {onOpenPanel ? (
                <button type="button" className={styles.link} onClick={onOpenPanel}>
                  Open panel →
                </button>
              ) : null}
              <Button
                variant="primary"
                disabled={busy || selected.length === 0 || !onSend}
                title={
                  !onSend
                    ? 'this session is not live'
                    : over
                      ? 'over budget — the pack will be trimmed to the highest-ranked records'
                      : 'paste into this session (does not press Enter)'
                }
                onClick={load}
              >
                {busy ? 'loading…' : 'Load into session'}
              </Button>
            </span>
          </div>
        </div>
      ) : null}
    </span>
  );
}

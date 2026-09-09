'use client';

// One memory record, as a selectable row. Shared by the dropdown and the panel; the panel
// passes `expanded` to show the full body and the actions.
//
// The citation is not decoration. Recalled text was written by an earlier agent run, and
// being able to see which agent, which repo and when is what makes a claim checkable rather
// than something to be taken on faith.

import ProviderBadge from '../ui/ProviderBadge/ProviderBadge';
import type { MemoryRow } from '../../lib/client/api';
import styles from './Memory.module.scss';

const KIND_GLYPH: Record<string, string> = {
  decision: '◆',
  lesson: '✦',
  error: '✕',
  artifact: '✎',
  'tool-call': '·',
  prompt: '?',
  outcome: '=',
};

function day(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function leaf(repo: string): string {
  const norm = repo.replace(/\\/g, '/').replace(/\/+$/, '');
  return norm.slice(norm.lastIndexOf('/') + 1) || norm;
}

export type MemoryRowItemProps = {
  row: MemoryRow;
  selected?: boolean;
  onToggle?: (id: string) => void;
  expanded?: boolean;
  /** Shown only in the panel — the dropdown is for loading, not curating. */
  onPin?: (row: MemoryRow) => void;
  onDelete?: (row: MemoryRow) => void;
  /** Show the repo in the citation. On by default; the dropdown hides it when repo-scoped. */
  showRepo?: boolean;
};

export default function MemoryRowItem({
  row,
  selected,
  onToggle,
  expanded,
  onPin,
  onDelete,
  showRepo = true,
}: MemoryRowItemProps) {
  const cite = [row.provider, showRepo ? leaf(row.repo) : null, day(row.ts)].filter(Boolean).join(' · ');

  return (
    <div className={`${styles.row} ${selected ? styles.rowOn : ''} ${row.superseded ? styles.rowStale : ''}`}>
      {onToggle ? (
        <input
          type="checkbox"
          className={styles.check}
          checked={!!selected}
          onChange={() => onToggle(row.id)}
          aria-label={`select ${row.kind}`}
        />
      ) : null}

      <button
        type="button"
        className={styles.rowBody}
        onClick={() => onToggle?.(row.id)}
        title={expanded ? undefined : row.text}
      >
        <span className={styles.rowTop}>
          <span className={`${styles.glyph} ${styles[`k_${row.kind.replace('-', '_')}`] ?? ''}`}>
            {KIND_GLYPH[row.kind] ?? '·'}
          </span>
          <span className={expanded ? styles.textFull : styles.text}>{row.text}</span>
        </span>
        <span className={styles.cite}>
          <ProviderBadge provider={row.provider} />
          <span>{cite}</span>
          {row.pinned ? <span className={styles.pin}>pinned</span> : null}
          {row.superseded ? <span className={styles.stale}>superseded</span> : null}
          <span className={styles.cost}>~{row.tokens} tok</span>
        </span>
      </button>

      {onPin || onDelete ? (
        <span className={styles.rowActions}>
          {onPin ? (
            <button
              type="button"
              className={styles.act}
              onClick={() => onPin(row)}
              title={row.pinned ? 'unpin' : 'pin — always keep this to hand'}
            >
              {row.pinned ? '★' : '☆'}
            </button>
          ) : null}
          {onDelete ? (
            <button type="button" className={styles.act} onClick={() => onDelete(row)} title="forget this">
              ✕
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

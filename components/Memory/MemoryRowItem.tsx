'use client';

// One memory record, as a row. Shared by the dropdown and the panel; the panel passes
// `expanded` for the full body and the curate actions.
//
// The citation is not decoration. Recalled text was written by an earlier agent run, and
// seeing which agent, which repo and when is what makes a claim checkable rather than
// something taken on faith.

import Checkbox from '../ui/Checkbox/Checkbox';
import IconButton from '../ui/IconButton/IconButton';
import MetaLine from '../ui/MetaLine/MetaLine';
import ProviderBadge from '../ui/ProviderBadge/ProviderBadge';
import type { MemoryRow } from '../../lib/client/api';
import styles from './Memory.module.scss';

const KIND_GLYPH: Record<string, string> = {
  decision: '✧',
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
  // Provider identity is the badge's job — repeating it as text renders "✳ claude · claude".
  const cite = [showRepo ? leaf(row.repo) : null, day(row.ts), row.sessionId.slice(0, 8)]
    .filter(Boolean)
    .join(' · ');

  const body = (
    <>
      <span className={styles.rowTop}>
        <span className={`${styles.glyph} ${styles[`k_${row.kind.replace('-', '_')}`] ?? ''}`}>
          {KIND_GLYPH[row.kind] ?? '·'}
        </span>
        <span className={expanded ? styles.textFull : styles.text}>{row.text}</span>
      </span>
      <MetaLine
        left={
          <span className={styles.cite}>
            <ProviderBadge provider={row.provider} />
            <span>{cite}</span>
            {row.pinned ? <span className={styles.pin}>pinned</span> : null}
            {row.superseded ? <span className={styles.stale}>superseded</span> : null}
          </span>
        }
        right={<span className={styles.cost}>~{row.tokens} tok</span>}
      />
    </>
  );

  return (
    <div className={`${styles.row} ${selected ? styles.rowOn : ''} ${row.superseded ? styles.rowStale : ''}`}>
      {onToggle ? (
        <span className={styles.check}>
          <Checkbox checked={!!selected} onChange={() => onToggle(row.id)} label={`select ${row.kind}`} />
        </span>
      ) : null}

      {/* A control only where it does something. In the panel there is nothing to select,
          so a button here would be a focusable no-op in every row. */}
      {onToggle ? (
        <button type="button" className={styles.rowBody} onClick={() => onToggle(row.id)} title={expanded ? undefined : row.text}>
          {body}
        </button>
      ) : (
        <div className={styles.rowBody}>{body}</div>
      )}

      {onPin || onDelete ? (
        <span className={styles.rowActions}>
          {onPin ? (
            <IconButton
              label={row.pinned ? 'Unpin' : 'Pin — always keep this to hand'}
              active={row.pinned}
              onClick={() => onPin(row)}
            >
              ★
            </IconButton>
          ) : null}
          {onDelete ? (
            <IconButton label="Forget this" onClick={() => onDelete(row)}>
              ✕
            </IconButton>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

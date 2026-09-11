'use client';

// One memory record, as a row. `expanded` gives the full body; `onPin`/`onDelete` add the
// curate actions.
//
// Not selectable. The panel hands over a SESSION's memory as one piece, so a checkbox here
// would offer a second, finer unit of choice that nothing downstream honours.
//
// The citation is not decoration. Recalled text was written by an earlier agent run, and
// seeing which agent, which repo and when is what makes a claim checkable rather than
// something taken on faith.

import IconButton from '../ui/IconButton/IconButton';
import MetaLine from '../ui/MetaLine/MetaLine';
import ProviderBadge from '../ui/ProviderBadge/ProviderBadge';
import type { MemoryRow } from '../../lib/client/api';
import { baseName } from '../../lib/client/fs-path';
import { KIND_GLYPH, KIND_LABEL } from './kinds';
import styles from './Memory.module.scss';

function day(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export type MemoryRowItemProps = {
  row: MemoryRow;
  expanded?: boolean;
  /** Curate actions. Present in the panel, which is the only surface that has them. */
  onPin?: (row: MemoryRow) => void;
  onDelete?: (row: MemoryRow) => void;
  /** Show the repo in the citation. On by default; hidden when the search is repo-scoped. */
  showRepo?: boolean;
  /**
   * Rendered under a session group header. The header already names the agent, the repo,
   * the day and the session, so repeating all four on every row is noise — the kind label
   * is what distinguishes one row from its siblings there.
   */
  inGroup?: boolean;
};

export default function MemoryRowItem({
  row,
  expanded,
  onPin,
  onDelete,
  showRepo = true,
  inGroup = false,
}: MemoryRowItemProps) {
  // Provider identity is the badge's job — repeating it as text renders "✳ claude · claude".
  const cite = inGroup
    ? KIND_LABEL[row.kind] ?? row.kind
    : [showRepo ? baseName(row.repo) : null, day(row.ts), row.sessionId.slice(0, 8)].filter(Boolean).join(' · ');

  return (
    <div className={`${styles.row} ${row.superseded ? styles.rowStale : ''}`}>
      <div className={styles.rowBody}>
        <span className={styles.rowTop}>
          <span className={`${styles.glyph} ${styles[`k_${row.kind.replace('-', '_')}`] ?? ''}`}>
            {KIND_GLYPH[row.kind] ?? '·'}
          </span>
          {/* Clamped inside a group: these rows are here to let you check what a session
              holds before handing it on, and one pasted stack trace or JSON blob would
              otherwise push every other session off the screen. Hover gives the lot. */}
          <span
            className={expanded ? `${styles.textFull} ${inGroup ? styles.textClamped : ''}` : styles.text}
            title={row.text}
          >
            {row.text}
          </span>
        </span>
        <MetaLine
          left={
            <span className={styles.cite}>
              {inGroup ? null : <ProviderBadge provider={row.provider} />}
              <span>{cite}</span>
              {/* A pinned row lives in the Pinned group, where the badge would be on every
                  row; elsewhere it is the only thing that says so. */}
              {row.pinned && !inGroup ? <span className={styles.pin}>pinned</span> : null}
              {row.superseded ? <span className={styles.stale}>superseded</span> : null}
            </span>
          }
          right={<span className={styles.cost}>~{row.tokens} tok</span>}
        />
      </div>

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

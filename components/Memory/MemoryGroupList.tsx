'use client';

// The memory list: one row per session, each holding that session's memory as one piece.
//
// A store is written one record at a time, but it is READ and HANDED ON as a session's
// worth of work — "take what that browser-panel run worked out into this one". So the
// session is the unit: it is what you tick, what the token budget counts, and what gets
// copied or loaded. The records underneath are detail you can open to check what you are
// about to hand over; they are not separately selectable, because picking six of a
// session's eleven records is not a thing anyone wants to spend attention on.

import { useMemo, useState } from 'react';
import Checkbox from '../ui/Checkbox/Checkbox';
import ProviderBadge from '../ui/ProviderBadge/ProviderBadge';
import MemoryRowItem from './MemoryRowItem';
import { KIND_GLYPH } from './kinds';
import { defaultOpenGroups, type MemoryGroup } from '../../lib/client/memory-groups';
import type { MemoryKind, MemoryRow } from '../../lib/client/api';
import styles from './Memory.module.scss';

function day(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function leaf(repo: string): string {
  const norm = repo.replace(/\\/g, '/').replace(/\/+$/, '');
  return norm.slice(norm.lastIndexOf('/') + 1) || norm;
}

/** Distinct kinds in the group, in the order they first appear — "what is in here". */
function kindStrip(rows: MemoryRow[]): MemoryKind[] {
  const seen: MemoryKind[] = [];
  for (const r of rows) if (!seen.includes(r.kind)) seen.push(r.kind);
  return seen;
}

function headMeta(group: MemoryGroup, showRepo: boolean): string {
  const n = `${group.rows.length} record${group.rows.length === 1 ? '' : 's'}`;
  if (group.kind === 'pinned') return n;
  const parts = [showRepo ? leaf(group.repo) : null];
  // The session id is the provenance a claim is checked against; it survives here because
  // the rows beneath no longer repeat it.
  if (group.kind === 'session') parts.push(group.sessionId.slice(0, 8));
  else parts.push('written here');
  parts.push(day(group.ts), n);
  return parts.filter(Boolean).join(' · ');
}

export type MemoryGroupListProps = {
  /** Built by the panel, which also reports their count in the load bar. */
  groups: MemoryGroup[];
  /** A query is being run — groups open so a match cannot hide inside a folded one. */
  searching: boolean;
  /** Group ids that are ticked for loading. */
  selectedGroups: Set<string>;
  onToggleGroup: (group: MemoryGroup, select: boolean) => void;
  onPin: (row: MemoryRow) => void;
  onDelete: (row: MemoryRow) => void;
  showRepo: boolean;
};

export default function MemoryGroupList({
  groups,
  searching,
  selectedGroups,
  onToggleGroup,
  onPin,
  onDelete,
  showRepo,
}: MemoryGroupListProps) {
  const seeded = useMemo(() => defaultOpenGroups(groups, searching), [groups, searching]);

  // Explicit opens/closes, kept ALONGSIDE the seed rather than replacing it. Memory is
  // written while you read it — every agent `remember` pings a refresh — and a plain
  // `open` set re-seeded on each refetch would fold the group being read back up.
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const isOpen = (id: string) => overrides.get(id) ?? seeded.has(id);
  const setOpen = (id: string, open: boolean) => setOverrides((cur) => new Map(cur).set(id, open));

  return (
    <>
      {groups.map((group) => {
        const open = isOpen(group.id);
        const picked = selectedGroups.has(group.id);

        return (
          <div key={group.id} className={styles.group}>
            <div
              className={`${styles.groupHead} ${picked ? styles.groupOn : ''} ${
                group.kind === 'pinned' ? styles.groupPinned : ''
              }`}
            >
              <span className={styles.check}>
                <Checkbox
                  checked={picked}
                  onChange={(next) => onToggleGroup(group, next)}
                  label={`share memory from ${group.label}`}
                />
              </span>
              <button
                type="button"
                className={styles.groupToggle}
                aria-expanded={open}
                onClick={() => setOpen(group.id, !open)}
                title={group.label}
              >
                {/* Same caret as the rail's project rows — a filled ▶ that rotates. The
                    ▾/▸ pair the changes tree uses is nearly invisible at this size. */}
                <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`} aria-hidden="true">
                  ▶
                </span>
                {group.kind === 'pinned' ? (
                  <span className={styles.groupStar} aria-hidden="true">
                    ★
                  </span>
                ) : (
                  <ProviderBadge provider={group.provider} />
                )}
                <span className={styles.groupLabel}>{group.label}</span>
              </button>
              {/* Folded, this is the only thing that says what the session contains. */}
              {!open ? (
                <span className={styles.groupKinds} aria-hidden="true">
                  {kindStrip(group.rows).map((k) => (
                    <span key={k} className={styles[`k_${k.replace('-', '_')}`] ?? ''}>
                      {KIND_GLYPH[k]}
                    </span>
                  ))}
                </span>
              ) : null}
              <span className={styles.groupMeta}>{headMeta(group, showRepo)}</span>
            </div>

            {/* Opened for reading, not for picking: no per-record checkbox. Pin and forget
                stay, because curating what a session remembers is a different act from
                choosing which session to hand on. */}
            {open
              ? group.rows.map((row) => (
                  <MemoryRowItem key={row.id} row={row} expanded inGroup onPin={onPin} onDelete={onDelete} />
                ))
              : null}
          </div>
        );
      })}
    </>
  );
}

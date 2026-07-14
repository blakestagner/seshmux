'use client';

import { useEffect, useRef, useState } from 'react';
import IconButton from '../ui/IconButton/IconButton';
import { useAppState } from '../../lib/client/store';
import type { RailSort } from '../../lib/client/store';
import styles from './FilterMenu.module.scss';

// Floating sort/group menu anchored to the filter button at the right of the
// tab row. Sort + Collapse-All are wired against the rail; group-by / show-recent
// render for parity but are inert until their backends exist.
const FILTER_SVG = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="6" x2="20" y2="6" />
    <line x1="7" y1="12" x2="17" y2="12" />
    <line x1="10" y1="18" x2="14" y2="18" />
  </svg>
);

function Check({ on }: { on: boolean }) {
  return <span className={styles.check}>{on ? '✓' : ''}</span>;
}

export default function FilterMenu() {
  const { state, dispatch } = useAppState();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const sort = state.railSort;
  const setSort = (s: RailSort) => dispatch({ type: 'setRailSort', sort: s });

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <IconButton label="Filter & sort" variant="boxed" size={28} active={open} onClick={() => setOpen((v) => !v)}>
        {FILTER_SVG}
      </IconButton>
      {open ? (
        <div className={styles.menu} role="menu">
          {/* ponytail: Filter submenu is inert — no filter facets defined yet. */}
          <button type="button" className={styles.item} disabled role="menuitem">
            <span className={styles.check} />
            <span className={styles.itemLabel}>Filter</span>
            <span className={styles.chevron}>›</span>
          </button>

          <div className={styles.sep} />

          <button type="button" className={styles.item} role="menuitemradio" aria-checked={sort === 'created'} onClick={() => setSort('created')}>
            <Check on={sort === 'created'} />
            <span className={styles.itemLabel}>Sort by Created</span>
          </button>
          <button type="button" className={styles.item} role="menuitemradio" aria-checked={sort === 'updated'} onClick={() => setSort('updated')}>
            <Check on={sort === 'updated'} />
            <span className={styles.itemLabel}>Sort by Updated</span>
          </button>

          <div className={styles.sep} />

          {/* ponytail: group-by is display-only — rail groups by workspace already;
              time-grouping needs a bucketing backend. Wire when added. */}
          <button type="button" className={styles.item} role="menuitemradio" aria-checked disabled>
            <Check on />
            <span className={styles.itemLabel}>Group by Workspace</span>
          </button>
          <button type="button" className={styles.item} role="menuitemradio" aria-checked={false} disabled>
            <span className={styles.check} />
            <span className={styles.itemLabel}>Group by Time</span>
          </button>

          <div className={styles.sep} />

          {/* ponytail: show-recent/all is display-only — rail already paginates
              (load more); a distinct "all" fetch mode is a separate feature. */}
          <button type="button" className={styles.item} role="menuitemradio" aria-checked disabled>
            <Check on />
            <span className={styles.itemLabel}>Show Recent Sessions</span>
          </button>
          <button type="button" className={styles.item} role="menuitemradio" aria-checked={false} disabled>
            <span className={styles.check} />
            <span className={styles.itemLabel}>Show All Sessions</span>
          </button>
          <button
            type="button"
            className={styles.item}
            role="menuitemcheckbox"
            aria-checked={state.showHidden}
            onClick={() => dispatch({ type: 'setShowHidden', on: !state.showHidden })}
          >
            <Check on={state.showHidden} />
            <span className={styles.itemLabel}>Show Hidden Projects</span>
          </button>

          <div className={styles.sep} />

          <button
            type="button"
            className={styles.item}
            role="menuitem"
            onClick={() => {
              dispatch({ type: 'collapseAllProjects' });
              setOpen(false);
            }}
          >
            <span className={styles.check} />
            <span className={styles.itemLabel}>Collapse All Groups</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

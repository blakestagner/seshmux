'use client';

import { useEffect, useRef } from 'react';
import IconButton from '../ui/IconButton/IconButton';
import styles from './RestoredBanner.module.scss';

// Opt-in, auto-dismissing banner shown once at startup when the server
// re-spawned interrupted sessions (auto-restore-sessions Stage 8). Informational
// only — no status color, no jump action — so it does NOT reuse Toast (which is
// the needs-input surface: waiting-amber, repo aggregation, "Jump to it"). It
// borrows Toast's top-center placement (see RestoredBanner.module.scss) but
// stays a separate, smaller composition rather than bolting a plain-message mode
// onto Toast's status-specific internals.

const DISMISS_MS = 6000;

export type RestoredBannerProps = {
  count: number;
  onDone: () => void;
};

export default function RestoredBanner({ count, onDone }: RestoredBannerProps) {
  // Hold onDone in a ref so the auto-dismiss timer resets ONLY on a new restore
  // batch (count change), not on every parent re-render (page.tsx re-renders
  // often and passes a fresh onDone each time).
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const t = setTimeout(() => onDoneRef.current(), DISMISS_MS);
    return () => clearTimeout(t);
  }, [count]);

  return (
    <div className={styles.banner} role="status">
      <span className={styles.text}>
        Restored {count} interrupted session{count === 1 ? '' : 's'}
      </span>
      <IconButton label="Dismiss" onClick={onDone}>
        ✕
      </IconButton>
    </div>
  );
}

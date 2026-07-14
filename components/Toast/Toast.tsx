'use client';

import StatusDot from '../ui/StatusDot/StatusDot';
import Button from '../ui/Button/Button';
import IconButton from '../ui/IconButton/IconButton';
import styles from './Toast.module.scss';

// TODO(wire): subscribe to events-ws status events (Task 15 server side,
// lead-daemon) — parent will call setOpen/setRepo/setReason from the
// {event:'status', ptyId, status} stream. This component only renders.

export type ToastProps = {
  open: boolean;
  repo: string;
  reason: string;
  onJump: () => void;
  onClose: () => void;
};

export default function Toast({ open, repo, reason, onJump, onClose }: ToastProps) {
  return (
    <div className={`${styles.toast} ${open ? styles.show : ''}`}>
      <StatusDot status="waiting" size={9} />
      <span className={styles.text}>
        <strong className={styles.repo}>{repo}</strong> needs your input — {reason}
      </span>
      <span className={styles.jump}>
        <Button variant="primary" onClick={onJump}>
          Jump to it
        </Button>
      </span>
      <IconButton label="Dismiss" onClick={onClose}>
        ✕
      </IconButton>
    </div>
  );
}

// macOS notification is server-side (osascript can't run in the browser). The
// parent (app/page.tsx events consumer) calls api.ts `notify()` when a session
// goes waiting while the document is hidden — the server decides delivery.

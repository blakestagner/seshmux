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
  // Repos of ALL currently-waiting sessions, oldest first. One renders the
  // classic single-session line; more aggregate into a counter.
  repos: string[];
  reason: string;
  onJump: () => void;
  onClose: () => void;
};

// "repo-a · repo-b +2" — first two names, the rest as a count.
function repoSummary(repos: string[]): string {
  const shown = repos.slice(0, 2).join(' · ');
  return repos.length > 2 ? `${shown} +${repos.length - 2}` : shown;
}

export default function Toast({ open, repos, reason, onJump, onClose }: ToastProps) {
  const many = repos.length > 1;
  return (
    <div className={`${styles.toast} ${open ? styles.show : ''}`}>
      <StatusDot status="waiting" size={9} />
      <span className={styles.text}>
        {many ? (
          <>
            <strong className={styles.repo}>{repos.length} sessions</strong> need your input —{' '}
            {repoSummary(repos)}
          </>
        ) : (
          <>
            <strong className={styles.repo}>{repos[0] ?? ''}</strong> needs your input — {reason}
          </>
        )}
      </span>
      <span className={styles.jump}>
        <Button variant="primary" onClick={onJump}>
          {many ? 'Jump to next' : 'Jump to it'}
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

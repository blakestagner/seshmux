import type { ReactNode } from 'react';
import IconButton from '../IconButton/IconButton';
import styles from './Notice.module.scss';

// Notice — a small raised, bordered message for feedback on one action
// (e.g. "upload failed: …"). Visual only: placement (overlay position) comes
// from the caller via className, dismissal is the caller's state.
// `tone="error"` also announces itself to screen readers (role="alert").
// With `onDismiss` it renders a × and its text stays selectable/interactive —
// use that for a notice the user needs to act on (copy a path from).
export type NoticeProps = {
  tone?: 'error' | 'info';
  className?: string;
  onDismiss?: () => void;
  children: ReactNode;
};

export default function Notice({ tone = 'info', className, onDismiss, children }: NoticeProps) {
  return (
    <div
      className={`${styles.notice} ${tone === 'error' ? styles.error : ''} ${onDismiss ? styles.dismissable : ''} ${className ?? ''}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className={styles.body}>{children}</span>
      {onDismiss ? (
        <IconButton label="Dismiss" onClick={onDismiss} className={styles.close}>
          ×
        </IconButton>
      ) : null}
    </div>
  );
}

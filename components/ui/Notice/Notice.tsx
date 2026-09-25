import type { ReactNode } from 'react';
import styles from './Notice.module.scss';

// Notice — a small raised, bordered message for transient feedback on one
// action (e.g. "upload failed: …"). Visual only: placement (overlay position)
// comes from the caller via className, dismissal is the caller's state.
// `tone="error"` also announces itself to screen readers (role="alert").
export type NoticeProps = {
  tone?: 'error' | 'info';
  className?: string;
  children: ReactNode;
};

export default function Notice({ tone = 'info', className, children }: NoticeProps) {
  return (
    <div
      className={`${styles.notice} ${tone === 'error' ? styles.error : ''} ${className ?? ''}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

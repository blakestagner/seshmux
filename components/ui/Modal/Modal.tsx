'use client';
// Reusable modal shell: overlay + centered panel + header (title + close) +
// body slot. Extracted so new modals compose one dialog instead of hand-rolling
// a 5th overlay (hard rule 2). Existing modals (Customizations/NewSession/
// WorkspaceFinish/Settings) still self-roll — retrofitting them is out of scope.
import { useEffect } from 'react';
import IconButton from '../IconButton/IconButton';
import styles from './Modal.module.scss';

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
};

export default function Modal({ open, onClose, title, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.header}>
          <h3 className={styles.title}>{title}</h3>
          <IconButton label="Close" onClick={onClose}>
            ×
          </IconButton>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}

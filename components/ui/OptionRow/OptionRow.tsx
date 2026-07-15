'use client';

import type { MouseEventHandler, ReactNode } from 'react';
import styles from './OptionRow.module.scss';

export type OptionRowProps = {
  icon: ReactNode;
  // ReactNode so callers can compose the title row (e.g. a right-aligned
  // installed chip); plain strings render exactly as before.
  title: ReactNode;
  desc: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
};

// Modal option-row button — icon + title/desc, hover accent tint, optional danger
// treatment + disabled state. Shared by NewSessionModal and WorkspaceFinishPrompt
// (was duplicated near-verbatim in both — primitives-first rule).
export default function OptionRow({ icon, title, desc, danger, disabled, onClick }: OptionRowProps) {
  return (
    <button
      type="button"
      className={`${styles.option} ${danger ? styles.danger : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={styles.icon}>{icon}</span>
      <span className={styles.optBody}>
        <span className={styles.optTitle}>{title}</span>
        <span className={styles.optDesc}>{desc}</span>
      </span>
    </button>
  );
}

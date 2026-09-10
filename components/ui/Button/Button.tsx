'use client';

import type { MouseEventHandler, ReactNode } from 'react';
import styles from './Button.module.scss';

export type ButtonProps = {
  // 'chip' = compact bordered mono pill (terminal statusbar actions) — distinct
  // from default/primary/ghost's body-text button visual.
  // 'link' = a label with no chrome, for an action that must not compete with a real
  // button beside it. TeamPanel/Rail/PrLinks each hand-rolled this; they should move here.
  variant?: 'default' | 'primary' | 'ghost' | 'chip' | 'link';
  disabled?: boolean;
  title?: string;
  className?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  children?: ReactNode;
};

export default function Button({ variant = 'default', disabled, title, className, onClick, children }: ButtonProps) {
  return (
    <button
      type="button"
      className={`${styles.btn} ${styles[variant]} ${className ?? ''}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

'use client';

import type { MouseEventHandler, ReactNode } from 'react';
import styles from './IconButton.module.scss';

export type IconButtonProps = {
  label: string;
  revealOnHover?: boolean;
  active?: boolean;
  // 'boxed' = design's bordered square icon button (top-bar gear 30px,
  // rail filter 28px). Bare (default) = padding-only for × close / reveal pin.
  variant?: 'bare' | 'boxed';
  size?: 28 | 30;
  disabled?: boolean;
  // Overrides the aria-label/title text shown while disabled (e.g. a gate
  // reason) — falls back to `label` when omitted.
  disabledReason?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  children?: ReactNode;
};

export default function IconButton({
  label,
  revealOnHover = false,
  active = false,
  variant = 'bare',
  size = 30,
  disabled = false,
  disabledReason,
  onClick,
  children,
}: IconButtonProps) {
  const boxed = variant === 'boxed' ? styles.boxed : '';
  const sizeStyle = variant === 'boxed' ? { width: size, height: size } : undefined;
  const title = disabled && disabledReason ? disabledReason : label;
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      disabled={disabled}
      className={`${styles.iconBtn} ${boxed} ${revealOnHover ? styles.reveal : ''} ${active ? styles.active : ''} ${disabled ? styles.disabled : ''}`}
      style={sizeStyle}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

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
  onClick?: MouseEventHandler<HTMLButtonElement>;
  children?: ReactNode;
};

export default function IconButton({
  label,
  revealOnHover = false,
  active = false,
  variant = 'bare',
  size = 30,
  onClick,
  children,
}: IconButtonProps) {
  const boxed = variant === 'boxed' ? styles.boxed : '';
  const sizeStyle = variant === 'boxed' ? { width: size, height: size } : undefined;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`${styles.iconBtn} ${boxed} ${revealOnHover ? styles.reveal : ''} ${active ? styles.active : ''}`}
      style={sizeStyle}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

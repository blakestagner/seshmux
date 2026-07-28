'use client';

import type { ReactNode } from 'react';
import styles from './MobileActionSheet.module.scss';

// Bottom action sheet (mockup screen 04). Generic: page.tsx builds the item
// list from the active session's capabilities. Dimmed backdrop taps close it.
export type SheetItem = {
  key: string;
  icon: ReactNode;
  label: string;
  hint?: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
};

export default function MobileActionSheet({
  open,
  title,
  subtitle,
  items,
  onClose,
}: {
  open: boolean;
  title?: string;
  subtitle?: string;
  items: SheetItem[];
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className={styles.overlay} onClick={onClose} role="presentation">
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {title ? (
          <div className={styles.head}>
            <span className={styles.title}>{title}</span>
            {subtitle ? <span className={styles.sub}>{subtitle}</span> : null}
          </div>
        ) : null}
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            className={[styles.item, it.danger ? styles.danger : '', it.disabled ? styles.disabled : '']
              .filter(Boolean)
              .join(' ')}
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              it.onClick?.();
              onClose();
            }}
          >
            <span className={styles.icon}>{it.icon}</span>
            <span className={styles.label}>{it.label}</span>
            {it.hint ? <span className={styles.hint}>{it.hint}</span> : null}
          </button>
        ))}
        <button type="button" className={styles.cancel} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

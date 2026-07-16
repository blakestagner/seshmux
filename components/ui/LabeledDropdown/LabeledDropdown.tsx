'use client';

import type { ReactNode } from 'react';
import Button from '../Button/Button';
import menu from '../Menu/Menu.module.scss';
import { useDropdown } from '../Menu/useDropdown';
import styles from './LabeledDropdown.module.scss';

// Labeled trigger button + ui/Menu dropdown surface — the shared shape of
// AssistMenu, SourceMenu, InstallMenu, and PluginRow's scope menu. Menu
// POSITIONING (top/bottom/left/right, min-width) stays in the consumer's
// module via menuClassName, matching the ui/Menu convention. Children get a
// `close` callback so item clicks can dismiss the menu.
// BridgeMenu stays hand-assembled: its caret shows open DIRECTION (not open
// state) and its trigger takes title/variant/className overrides.
type LabeledDropdownProps = {
  label: ReactNode;
  disabled?: boolean;
  variant?: 'default' | 'primary';
  menuClassName?: string;
  children: (close: () => void) => ReactNode;
};

export default function LabeledDropdown({ label, disabled, variant, menuClassName, children }: LabeledDropdownProps) {
  const { open, setOpen, wrapRef } = useDropdown();

  return (
    <span className={styles.wrap} ref={wrapRef}>
      <Button variant={variant} disabled={disabled} onClick={() => setOpen((v) => !v)}>
        {label} <span>{open ? '▴' : '▾'}</span>
      </Button>
      {open ? (
        <div className={`${menu.menu} ${menuClassName ?? ''}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </span>
  );
}

// Standard row inside the dropdown — composes ui/Menu's item visual.
export function MenuItem({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button type="button" className={menu.item} role="menuitem" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

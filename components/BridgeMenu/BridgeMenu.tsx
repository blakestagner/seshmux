'use client';

import type { ProviderId } from '../../lib/client/types';
import Button from '../ui/Button/Button';
import menu from '../ui/Menu/Menu.module.scss';
import { useDropdown } from '../ui/Menu/useDropdown';
import styles from './BridgeMenu.module.scss';

// Dropdown holding the cross-agent bridge actions (Continue in / Review with),
// replacing the pair of standalone buttons. Same click-outside/Escape pattern
// as FilterMenu.
type BridgeMenuProps = {
  other: { glyph: string; name: string };
  otherProvider: ProviderId;
  hasHandoff?: boolean; // handoff pair already exists — hide "Continue in …"
  disabled?: boolean;
  title?: string; // trigger tooltip override (bridge errors surface here)
  variant?: 'default' | 'chip';
  className?: string; // extra class for the trigger button
  up?: boolean; // open above the trigger (terminal statusbar sits at pane bottom)
  onHandoff: () => void;
  onReview: () => void;
};

export default function BridgeMenu({
  other,
  otherProvider,
  hasHandoff,
  disabled,
  title,
  variant = 'default',
  className,
  up,
  onHandoff,
  onReview,
}: BridgeMenuProps) {
  const { open, setOpen, wrapRef } = useDropdown();

  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <span className={styles.wrap} ref={wrapRef}>
      <Button
        variant={variant}
        className={className}
        disabled={disabled}
        title={title ?? `Continue or review with ${other.name}`}
        onClick={() => setOpen((v) => !v)}
      >
        {other.glyph} {otherProvider} <span className={styles.caret}>{up ? '▴' : '▾'}</span>
      </Button>
      {open ? (
        <div className={`${menu.menu} ${styles.menu} ${up ? styles.up : ''}`} role="menu">
          {!hasHandoff ? (
            <button type="button" className={menu.item} role="menuitem" onClick={() => pick(onHandoff)}>
              ⇄ Continue in {other.glyph} {otherProvider}
            </button>
          ) : null}
          <button type="button" className={menu.item} role="menuitem" onClick={() => pick(onReview)}>
            ⊙ Review with {other.glyph} {otherProvider}
          </button>
        </div>
      ) : null}
    </span>
  );
}

'use client';

// Checkbox — a themed multi-select box.
//
// Exists because a native `<input type="checkbox">` renders UA chrome that ignores every
// token in the system: it will not match the Toggle or Segmented sitting beside it, and it
// takes its shape from the OS rather than from --radius-sm/--border. The native input is
// kept underneath for keyboard, focus and screen-reader behaviour, and hidden visually.

import styles from './Checkbox.module.scss';

export type CheckboxProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name — this control never renders visible text of its own. */
  label: string;
  disabled?: boolean;
};

export default function Checkbox({ checked, onChange, label, disabled }: CheckboxProps) {
  return (
    <span className={styles.wrap}>
      <input
        type="checkbox"
        className={styles.input}
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={`${styles.box} ${checked ? styles.on : ''}`} aria-hidden="true">
        {checked ? '✓' : ''}
      </span>
    </span>
  );
}

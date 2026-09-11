'use client';

// Checkbox — a themed multi-select box.
//
// Exists because a native `<input type="checkbox">` renders UA chrome that ignores every
// token in the system: it will not match the Toggle or Segmented sitting beside it, and it
// takes its shape from the OS rather than from --radius-sm/--border. The native input is
// kept underneath for keyboard, focus and screen-reader behaviour, and hidden visually.

import { useEffect, useRef } from 'react';
import styles from './Checkbox.module.scss';

export type CheckboxProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name — this control never renders visible text of its own. */
  label: string;
  disabled?: boolean;
  /**
   * Some-but-not-all of what this box stands for is selected. Used by group headers that
   * select their whole group; ignored when `checked`.
   *
   * `indeterminate` is a DOM property with no HTML attribute, so it has to be assigned to
   * the node — React will not set it from JSX. Without it the box would look mixed while
   * assistive tech heard a plain unchecked checkbox.
   */
  mixed?: boolean;
};

export default function Checkbox({ checked, onChange, label, disabled, mixed }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  const indeterminate = !!mixed && !checked;

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <span className={styles.wrap}>
      <input
        ref={ref}
        type="checkbox"
        className={styles.input}
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        className={`${styles.box} ${checked ? styles.on : ''} ${indeterminate ? styles.mixed : ''}`}
        aria-hidden="true"
      >
        {checked ? '✓' : indeterminate ? '–' : ''}
      </span>
    </span>
  );
}

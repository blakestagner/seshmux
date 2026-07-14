'use client';

import styles from './Toggle.module.scss';

export type ToggleProps = {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
};

export default function Toggle({ on, onChange, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      className={`${styles.toggle} ${on ? styles.on : ''}`}
      onClick={() => onChange(!on)}
    />
  );
}

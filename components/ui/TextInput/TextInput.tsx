'use client';

import type { ChangeEventHandler } from 'react';
import styles from './TextInput.module.scss';

export type TextInputProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  kbdHint?: string;
  // when set, render a resizable <textarea rows={multiline}> sharing the same
  // input chrome (border/radius/focus/placeholder) — kbdHint is ignored.
  multiline?: number;
  disabled?: boolean;
  // Layout-only passthrough (flex/min-height/resize) for callers embedding
  // TextInput in a custom layout — chrome (border/bg/radius/padding) stays
  // owned by TextInput.module.scss, never overridden by consumers.
  className?: string;
};

export default function TextInput({ value, onChange, placeholder, kbdHint, multiline, disabled, className }: TextInputProps) {
  if (multiline) {
    const onArea: ChangeEventHandler<HTMLTextAreaElement> = (e) => onChange(e.target.value);
    return (
      <textarea
        className={`${styles.input} ${styles.area}${className ? ` ${className}` : ''}`}
        value={value}
        onChange={onArea}
        placeholder={placeholder}
        rows={multiline}
        disabled={disabled}
      />
    );
  }
  const handleChange: ChangeEventHandler<HTMLInputElement> = (e) => onChange(e.target.value);
  return (
    <span className={styles.wrap}>
      <input
        className={`${styles.input}${kbdHint ? ` ${styles.hasHint}` : ''}${className ? ` ${className}` : ''}`}
        type="text"
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        disabled={disabled}
      />
      {kbdHint ? <span className={styles.kbd}>{kbdHint}</span> : null}
    </span>
  );
}

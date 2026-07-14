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
};

export default function TextInput({ value, onChange, placeholder, kbdHint, multiline }: TextInputProps) {
  if (multiline) {
    const onArea: ChangeEventHandler<HTMLTextAreaElement> = (e) => onChange(e.target.value);
    return (
      <textarea
        className={`${styles.input} ${styles.area}`}
        value={value}
        onChange={onArea}
        placeholder={placeholder}
        rows={multiline}
      />
    );
  }
  const handleChange: ChangeEventHandler<HTMLInputElement> = (e) => onChange(e.target.value);
  return (
    <span className={styles.wrap}>
      <input
        className={`${styles.input}${kbdHint ? ` ${styles.hasHint}` : ''}`}
        type="text"
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
      />
      {kbdHint ? <span className={styles.kbd}>{kbdHint}</span> : null}
    </span>
  );
}

'use client';

import type { ChangeEventHandler, KeyboardEventHandler, MouseEventHandler } from 'react';
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
  // Behaviour passthroughs (never chrome): submit-on-Enter, and a <datalist>
  // id for inputs that offer suggestions.
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  list?: string;
  // Click hook for path fields that open the native folder chooser when clicked.
  onClick?: MouseEventHandler<HTMLInputElement>;
  // Focus on mount. Behaviour, not chrome — for inputs that ARE the reason a surface
  // opened (a dropdown whose whole purpose is its search box), where making the user click
  // once more is just friction.
  autoFocus?: boolean;
};

export default function TextInput({
  value,
  onChange,
  placeholder,
  kbdHint,
  multiline,
  disabled,
  className,
  onKeyDown,
  list,
  onClick,
  autoFocus,
}: TextInputProps) {
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
        autoFocus={autoFocus}
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
        onKeyDown={onKeyDown}
        onClick={onClick}
        list={list}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
      />
      {kbdHint ? <span className={styles.kbd}>{kbdHint}</span> : null}
    </span>
  );
}

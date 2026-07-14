'use client';

import type { ChangeEventHandler } from 'react';
import styles from './Select.module.scss';

// Options are either plain strings (value === label) or {value,label} pairs
// when the display text isn't unique — e.g. two projects both named "org".
export type SelectOption = string | { value: string; label: string };

export type SelectProps = {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
};

function normalize(opt: SelectOption): { value: string; label: string } {
  return typeof opt === 'string' ? { value: opt, label: opt } : opt;
}

export default function Select({ options, value, onChange }: SelectProps) {
  const handleChange: ChangeEventHandler<HTMLSelectElement> = (e) => onChange(e.target.value);
  return (
    <select className={styles.select} value={value} onChange={handleChange}>
      {options.map(normalize).map(({ value: v, label }) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}

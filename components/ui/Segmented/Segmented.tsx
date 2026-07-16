'use client';

import styles from './Segmented.module.scss';

export type SegmentedOption = { id: string; label: string };

export type SegmentedProps = {
  options: SegmentedOption[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
  // 'default' = bordered group, accent-soft active (tabs/grid, theme picker).
  // 'raised' = full-width equal thirds, neutral raised-pill active (rail
  // provider filter, mockup .rail-provfilter).
  variant?: 'default' | 'raised';
};

export default function Segmented({
  options,
  value,
  onChange,
  className,
  variant = 'default',
}: SegmentedProps) {
  const root = [styles.seg, styles[variant], className].filter(Boolean).join(' ');
  return (
    <div className={root}>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          className={opt.id === value ? styles.active : ''}
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

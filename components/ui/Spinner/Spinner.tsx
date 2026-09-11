'use client';

// Spinner — the "something is happening and I cannot tell you how far along"
// indicator. A determinate bar belongs in MeterBar; this is for waits with no
// measurable progress (a dev server booting, a request in flight).
//
// Not a glyph: a spinning character reflows text and inherits font metrics,
// which made it jitter next to a label. A bordered circle rotates cleanly at
// any size and sits on the text baseline via vertical-align.

import styles from './Spinner.module.scss';

export type SpinnerProps = {
  /** Diameter in px. 12 sits inside a line of body text, 16 beside a heading. */
  size?: 10 | 12 | 16;
  /** Announced to screen readers; the spinner is otherwise invisible to them. */
  label?: string;
  className?: string;
};

export default function Spinner({ size = 12, label = 'Working', className }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={[styles.spinner, className].filter(Boolean).join(' ')}
      // Border scales with the circle or a 16px ring looks like a hoop and a
      // 10px one like a blob.
      style={{ width: size, height: size, borderWidth: Math.max(1.5, size / 8) }}
    />
  );
}

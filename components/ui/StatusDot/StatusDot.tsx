import styles from './StatusDot.module.scss';

export type StatusDotProps = {
  // 'unviewed' = Spec 3 done-but-unseen (agent finished, tab not focused when
  // it did). Distinct from 'done' (= exited/not-live in TerminalPane).
  status: 'live' | 'waiting' | 'done' | 'unviewed' | 'neutral';
  size?: 7 | 8 | 9;
  // Live dots pulse (design af-pulse) by default. Set false for static live
  // dots (design grid footer / tab strip). No effect on non-live statuses.
  pulse?: boolean;
};

export default function StatusDot({ status, size = 8, pulse = true }: StatusDotProps) {
  const pulsing = status === 'live' && pulse ? ` ${styles.pulsing}` : '';
  return (
    <span
      className={`${styles.dot} ${styles[status]}${pulsing}`}
      style={{ width: size, height: size }}
    />
  );
}

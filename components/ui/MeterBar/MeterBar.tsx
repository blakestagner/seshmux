import styles from './MeterBar.module.scss';

export type MeterBarProps = {
  pct: number;
  tone?: 'ctx' | 'accent';
};

function ctxTone(pct: number): 'hot' | 'warm' | '' {
  if (pct >= 80) return 'hot';
  if (pct >= 60) return 'warm';
  return '';
}

export default function MeterBar({ pct, tone = 'accent' }: MeterBarProps) {
  const clamped = Math.max(0, Math.min(100, pct));
  const fillClass = tone === 'ctx' ? styles[ctxTone(clamped) || 'live'] : styles.accent;
  return (
    <span className={`${styles.track} ${styles[tone]}`}>
      <span className={`${styles.fill} ${fillClass}`} style={{ width: `${clamped}%` }} />
    </span>
  );
}

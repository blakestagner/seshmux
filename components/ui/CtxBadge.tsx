import styles from './CtxBadge.module.scss';

export type CtxBadgeProps = {
  tokens: number;
  window: number;
};

function fmtK(n: number): string {
  return `${Math.round(n / 1000)}k`;
}

function tone(pct: number): 'hot' | 'warm' | '' {
  if (pct >= 80) return 'hot';
  if (pct >= 60) return 'warm';
  return '';
}

export default function CtxBadge({ tokens, window }: CtxBadgeProps) {
  const pct = window > 0 ? Math.round((tokens / window) * 100) : 0;
  const t = tone(pct);
  return (
    <span className={`${styles.badge} ${t ? styles[t] : ''}`}>
      {fmtK(tokens)}/{fmtK(window)} · {pct}%
    </span>
  );
}

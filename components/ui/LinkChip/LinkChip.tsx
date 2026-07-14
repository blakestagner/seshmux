'use client';
// Bridge-pair identity chip: ⇄ handoff (accent) / ⊙ review (amber) / ⚖ plan-off
// (dim). Ported from mockup .link-chip. The KIND colors are approved identity
// hues for bridge pairing — NOT run-status semantics. Composed by Tabs and
// GridView so the visual is drawn once (primitives-first, hard rule 2).

import styles from './LinkChip.module.scss';

const CHIP: Record<'handoff' | 'review' | 'planoff', string> = {
  handoff: '⇄ handoff',
  review: '⊙ review',
  planoff: '⚖ plan-off',
};

export type LinkChipProps = {
  kind: 'handoff' | 'review' | 'planoff';
};

export default function LinkChip({ kind }: LinkChipProps) {
  return <span className={`${styles.chip} ${styles[kind]}`}>{CHIP[kind]}</span>;
}

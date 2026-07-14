import type { ReactNode } from 'react';
import styles from './MetaLine.module.scss';

export type MetaLineProps = {
  left: ReactNode;
  right?: ReactNode;
};

export default function MetaLine({ left, right }: MetaLineProps) {
  return (
    <div className={styles.row}>
      <span>{left}</span>
      {right != null ? <span>{right}</span> : null}
    </div>
  );
}

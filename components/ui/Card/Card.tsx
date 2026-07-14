import type { ReactNode } from 'react';
import styles from './Card.module.scss';

export type CardProps = {
  title?: string;
  note?: string;
  children: ReactNode;
};

export default function Card({ title, note, children }: CardProps) {
  return (
    <section className={styles.card}>
      {title ? (
        <div className={styles.title}>
          {title}
          {note ? <span className={styles.note}>{note}</span> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

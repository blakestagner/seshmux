'use client';

import { Fragment } from 'react';
import type { SearchHit } from '../lib/client/api';
import styles from './SearchDropdown.module.scss';

export type SearchDropdownProps = {
  open: boolean;
  query: string;
  hits: SearchHit[];
  onPick: (hit: SearchHit) => void;
};

// Splits `text` on `query` (case-insensitive) and wraps matches in <mark>,
// mirroring the mockup's server-baked <mark> tags — ours are client-side
// since the real /api/search returns plain text, not HTML.
function highlight(text: string, query: string) {
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text;
  return (
    <Fragment>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </Fragment>
  );
}

export default function SearchDropdown({ open, query, hits, onPick }: SearchDropdownProps) {
  const byProject = new Map<string, SearchHit[]>();
  for (const h of hits) {
    const list = byProject.get(h.project) ?? [];
    list.push(h);
    byProject.set(h.project, list);
  }

  return (
    <div className={`${styles.results} ${open ? styles.open : ''}`}>
      {hits.length === 0 ? (
        <div className={styles.empty}>No matches — searches every transcript in your agent session stores.</div>
      ) : (
        [...byProject.entries()].map(([project, items]) => (
          <div key={project}>
            <div className={styles.group}>{project}</div>
            {items.map((h) => (
              <button key={h.sessionId} type="button" className={styles.item} onClick={() => onPick(h)}>
                <div className={styles.title}>{highlight(h.title || 'untitled', query)}</div>
                <div className={styles.meta}>{h.snippet}</div>
              </button>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

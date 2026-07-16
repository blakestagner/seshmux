'use client';
// PRs created during a session, two renderings sharing one fetch hook:
//   PrChip — terminal statusbar. 1 PR = direct-open chip; >1 = dropdown
//            (same ui/Menu surface + useDropdown behavior as BridgeMenu).
//   PrList — rail session rows. Small anchor list under the row.
// Both open GitHub in a new tab. No PRs = nothing rendered.

import { useEffect, useState } from 'react';
import Button from '../ui/Button/Button';
import menu from '../ui/Menu/Menu.module.scss';
import { useDropdown } from '../ui/Menu/useDropdown';
import { getSessionPrs } from '../../lib/client/api';
import type { PrRef } from '../../lib/client/types';
import styles from './PrLinks.module.scss';

// Lazy poll: mount + window focus (same discipline as the subagent chip —
// best-effort chip data, UI stays usable without it).
export function useSessionPrs(projectId?: string, sessionId?: string): PrRef[] {
  const [prs, setPrs] = useState<PrRef[]>([]);
  useEffect(() => {
    if (!projectId || !sessionId) return;
    let cancelled = false;
    const refresh = () => {
      getSessionPrs(projectId, sessionId)
        .then(({ prs }) => {
          if (!cancelled) setPrs(prs);
        })
        .catch(() => {
          /* best-effort; render nothing on failure */
        });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refresh);
    };
  }, [projectId, sessionId]);
  return prs;
}

function prLabel(pr: PrRef): string {
  return pr.title ? `#${pr.number} ${pr.title}` : `${pr.repo}#${pr.number}`;
}

function openPr(url: string): void {
  window.open(url, '_blank', 'noopener');
}

// Takes the list as a prop (caller runs useSessionPrs) so the statusbar can
// gate its divider on prs.length without a second fetch.
export function PrChip({ prs }: { prs: PrRef[] }) {
  const { open, setOpen, wrapRef } = useDropdown();
  if (!prs.length) return null;

  if (prs.length === 1) {
    return (
      <Button variant="chip" title={prLabel(prs[0])} onClick={() => openPr(prs[0].url)}>
        ↗ PR #{prs[0].number}
      </Button>
    );
  }
  return (
    <span className={styles.wrap} ref={wrapRef}>
      <Button variant="chip" title="Open a pull request" onClick={() => setOpen((v) => !v)}>
        ↗ {prs.length} PRs <span className={styles.caret}>▴</span>
      </Button>
      {open ? (
        <div className={`${menu.menu} ${styles.menu}`} role="menu">
          {prs.map((pr) => (
            <button
              key={pr.url}
              type="button"
              className={menu.item}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openPr(pr.url);
              }}
            >
              {prLabel(pr)}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

export function PrList({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const prs = useSessionPrs(projectId, sessionId);
  if (!prs.length) return null;
  return (
    <div className={styles.list}>
      {prs.map((pr) => (
        <a
          key={pr.url}
          className={styles.link}
          href={pr.url}
          target="_blank"
          rel="noreferrer noopener"
          title={pr.url}
        >
          ↗ {prLabel(pr)}
        </a>
      ))}
    </div>
  );
}

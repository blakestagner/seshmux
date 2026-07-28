'use client';

import StatusDot from '../ui/StatusDot/StatusDot';
import ProviderBadge from '../ui/ProviderBadge/ProviderBadge';
import type { Tab } from '../../lib/client/store';
import styles from './MobileSessionHeader.module.scss';

// Mobile-only session header (mockup screen 02): replaces the desktop tab strip
// on a phone. Back ‹ returns to the Sessions list, ⋯ opens the action sheet.
// Rendered only when isMobile (page.tsx gates it), so no media query needed.
const NEUTRAL_KINDS = new Set<Tab['kind']>(['transcript', 'settings', 'scratchpad', 'planoff']);

function dotStatus(tab: Tab): 'live' | 'waiting' | 'unviewed' | 'neutral' {
  if (NEUTRAL_KINDS.has(tab.kind)) return 'neutral';
  if (tab.status === 'waiting') return 'waiting';
  if (tab.unviewed) return 'unviewed';
  return 'live';
}

export default function MobileSessionHeader({
  tab,
  onBack,
  onMenu,
}: {
  tab: Tab;
  onBack: () => void;
  onMenu: () => void;
}) {
  const sub = [tab.projectId ? tab.label : null, tab.branch].filter(Boolean);
  return (
    <div className={styles.header}>
      <button type="button" className={styles.back} onClick={onBack} aria-label="Back to sessions">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <div className={styles.meta}>
        <div className={styles.titleRow}>
          <StatusDot status={dotStatus(tab)} size={7} pulse={false} />
          <span className={styles.title}>{tab.label}</span>
        </div>
        {tab.branch ? <span className={styles.sub}>{tab.branch}</span> : null}
      </div>
      {tab.provider ? <ProviderBadge provider={tab.provider} /> : null}
      <button type="button" className={styles.menu} onClick={onMenu} aria-label="Session actions">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
    </div>
  );
}

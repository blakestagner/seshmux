'use client';

import styles from './MobileNav.module.scss';

// Mobile-only bottom tab bar (mockup "Seshmux Mobile" screens 01/02). Hidden on
// desktop via CSS. Three destinations map onto the existing app: Sessions = the
// rail (full-screen list), Active = the current session pane, Agents = the
// agents view. Grid/multi-tab are deliberately absent (desktop only).
export type MobileScreen = 'sessions' | 'active' | 'agents';

const ITEMS: { id: MobileScreen; label: string; icon: React.ReactNode }[] = [
  {
    id: 'sessions',
    label: 'Sessions',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="4" y1="18" x2="20" y2="18" />
      </svg>
    ),
  },
  {
    id: 'active',
    label: 'Active',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 9l3 3-3 3" />
        <line x1="13" y1="15" x2="17" y2="15" />
      </svg>
    ),
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 3l7 4v6c0 4-3 6-7 8-4-2-7-4-7-8V7z" />
      </svg>
    ),
  },
];

export default function MobileNav({
  value,
  onChange,
}: {
  value: MobileScreen;
  onChange: (screen: MobileScreen) => void;
}) {
  return (
    <nav className={styles.bar} aria-label="Primary">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={item.id === value ? `${styles.item} ${styles.active}` : styles.item}
          onClick={() => onChange(item.id)}
          aria-current={item.id === value ? 'page' : undefined}
        >
          {item.icon}
          <span className={styles.label}>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

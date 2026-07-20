'use client';

// Dumb tab-strip primitive (scratch-terminal plan decision 5). A horizontal row
// of selectable panel tabs, each optionally closable (× only on `closable`
// tabs — the Terminal pane tab needs one; Segmented has no such affordance and
// renders a pill, not a tab). Pure presentation: all state lives in the caller.
// Text comes ONLY from t-tab/t-tab-active (hard rule 1); this does NOT copy
// components/Tabs/Tabs.module.scss (rule 2 — it becomes the shared primitive if
// the top Tabs feature ever wants to converge).

import IconButton from '../IconButton/IconButton';
import styles from './TabStrip.module.scss';

export type TabStripItem = { id: string; label: string; closable?: boolean };
export type TabStripProps = {
  tabs: TabStripItem[];
  active: string | null;
  onSelect(id: string): void;
  onClose?(id: string): void; // renders × only on closable tabs
};

export default function TabStrip({ tabs, active, onSelect, onClose }: TabStripProps) {
  return (
    <div className={styles.strip} role="tablist">
      {tabs.map((t) => (
        // role="tab" (not <button>) so the close IconButton can nest without
        // producing invalid button-in-button HTML (mirrors Tabs.tsx).
        <div
          key={t.id}
          role="tab"
          tabIndex={0}
          aria-selected={t.id === active}
          className={`${styles.tab} ${t.id === active ? styles.active : ''}`}
          onClick={() => onSelect(t.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(t.id);
            }
          }}
        >
          <span className={styles.label}>{t.label}</span>
          {t.closable && onClose ? (
            <span className={styles.closeWrap}>
              <IconButton
                label="Close panel"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
              >
                ✕
              </IconButton>
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

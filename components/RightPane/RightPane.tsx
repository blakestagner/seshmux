'use client';

// Right-pane host (scratch-terminal plan Stage 2): a TabStrip over a stack of
// panel nodes, sitting in the term↔pane split's right side (app/page.tsx owns
// the split geometry + gate math). Mounting policy per the spec:
//   - keepMounted panels (only `terminal`, Stage 5) render ALWAYS, hidden via
//     display:none when not active — a scratch shell must survive a tab switch.
//   - all others render ONLY when active, preserving today's remount/refetch
//     semantics (ChangesPanel's 10s poll, SubagentViewer/TeamPanel fetch-on-mount).
// Tabs are already gate-filtered by page.tsx; `active` is resolveActive() output.

import type { ReactNode } from 'react';
import type { PanelId } from '../../lib/client/right-pane';
import TabStrip from '../ui/TabStrip/TabStrip';
import styles from './RightPane.module.scss';

export type RightPanePanel = { id: PanelId; node: ReactNode; keepMounted?: boolean };
export type RightPaneProps = {
  tabs: { id: PanelId; label: string; closable?: boolean }[];
  active: PanelId | null;
  onSelect(id: PanelId): void;
  onClose(id: PanelId): void;
  // Present only when this tab can spawn shells — renders the strip's + button.
  onNewTerminal?(): void;
  panels: RightPanePanel[];
};

export default function RightPane({ tabs, active, onSelect, onClose, onNewTerminal, panels }: RightPaneProps) {
  return (
    <div className={styles.host}>
      <TabStrip
        tabs={tabs}
        active={active}
        onSelect={(id) => onSelect(id as PanelId)}
        onClose={(id) => onClose(id as PanelId)}
        action={onNewTerminal ? { label: 'New terminal (⌘T)', glyph: '+', onClick: onNewTerminal } : undefined}
      />
      <div className={styles.body}>
        {panels.map((p) => {
          if (p.keepMounted) {
            return (
              <div key={p.id} className={styles.panel} style={p.id === active ? undefined : { display: 'none' }}>
                {p.node}
              </div>
            );
          }
          return p.id === active ? (
            <div key={p.id} className={styles.panel}>
              {p.node}
            </div>
          ) : null;
        })}
      </div>
    </div>
  );
}

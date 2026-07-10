'use client';
// Grid layout over the open TERM tabs (not /api/sessions/live — that feeds rail
// dots). The tabs⇄grid Segmented toggles this layout over the same tab set;
// clicking a tile selects it in place (activateTab) and stays in grid.
//
// Single-row tile header per redesign (design-markup L178-184): pulsing dot +
// repo name (13px/600) on the left; ctx text ("76k / 200k") + 46×5 meter + pct
// on the right. Provider badge, bridge chip and from-ref are seshmux-functional
// (not in the mock) — kept inline on the left so nothing functional is dropped.
// `waiting` status + NEEDS INPUT wiring lands in the events-ws wave (Task 15);
// the pulse CSS + flag exist here but nothing feeds 'waiting' yet.

import { useAppState, type Tab } from '../lib/client/store';
import TerminalPane from './TerminalPane';
import StatusDot from './ui/StatusDot';
import ProviderBadge, { PROV } from './ui/ProviderBadge';
import MeterBar from './ui/MeterBar';
import LinkChip from './ui/LinkChip';
import styles from './GridView.module.scss';

function fmtK(n: number): string {
  return `${Math.round(n / 1000)}k`;
}

function repoName(tab: Tab, projects: { id: string; name: string }[]): string {
  const p = projects.find((x) => x.id === tab.projectId);
  return p?.name ?? tab.label;
}

export default function GridView() {
  const { state, dispatch } = useAppState();
  const termTabs = state.tabs.filter((t) => t.kind === 'term' && t.ptyId);

  // Resolve a linkSrc (source sessionId) to "<glyph> <source title>" per the
  // mockup, using the source tab still open in state. Falls back to a short id
  // when the source tab isn't present (e.g. it was closed).
  function sourceRef(linkSrc: string): string {
    const src = state.tabs.find((t) => t.sessionId === linkSrc);
    if (src) {
      const glyph = src.provider ? PROV[src.provider].glyph : '';
      const title = src.label.length > 24 ? src.label.slice(0, 24) + '…' : src.label;
      return `${glyph} ${title}`.trim();
    }
    return linkSrc.slice(0, 8);
  }

  if (termTabs.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.mark}>▦</div>
        <div>No live sessions — start one from the rail.</div>
      </div>
    );
  }

  return (
    <div className={styles.grid}>
      {termTabs.map((tab) => {
        const waiting = tab.status === 'waiting';
        const selected = tab.id === state.activeTab;
        return (
          <div
            key={tab.id}
            className={[
              styles.tile,
              waiting ? styles.waiting : '',
              tab.linkedKind ? styles.bridged : '',
              selected ? styles.selected : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {/* Header is the select target — a live terminal can't sit inside a
                <button>, so only the header row is the clickable control. */}
            <button
              type="button"
              className={styles.head}
              onClick={() => dispatch({ type: 'activateTab', id: tab.id })}
            >
              <StatusDot status={waiting ? 'waiting' : 'live'} size={7} />
              <span className={styles.repo}>{repoName(tab, state.projects)}</span>
              {tab.linkedKind ? <LinkChip kind={tab.linkedKind} /> : null}
              {tab.provider ? <ProviderBadge provider={tab.provider} /> : null}
              {tab.linkSrc ? <span className={styles.from}>from {sourceRef(tab.linkSrc)}</span> : null}
              {waiting ? <span className={styles.flag}>needs input</span> : null}
              {tab.ctx ? (
                <span className={styles.ctx}>
                  <span className={styles.ctxText}>
                    {fmtK(tab.ctx.tokens)} / {fmtK(tab.ctx.window)}
                  </span>
                  <span className={styles.meterSlot}>
                    <MeterBar pct={Math.round((tab.ctx.tokens / tab.ctx.window) * 100)} tone="ctx" />
                  </span>
                  <span className={styles.pct}>{Math.round((tab.ctx.tokens / tab.ctx.window) * 100)}%</span>
                </span>
              ) : null}
            </button>
            {/* Each tile hosts a live terminal; selecting stays in grid. */}
            <div className={styles.body}>
              <TerminalPane
                ptyId={tab.ptyId!}
                projectId={tab.projectId}
                sessionId={tab.sessionId}
                provider={tab.provider}
                branch={tab.branch}
                variant="grid"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

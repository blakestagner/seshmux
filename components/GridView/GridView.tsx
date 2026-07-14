'use client';
// Tiled grid workspace (design-3, docs/local/prototypes/grid-layout/design-3.html).
// The split tree from lib/client/grid-layout.ts drives absolutely positioned
// panels; panels are stable DOM nodes keyed by tab.id and are NEVER reparented
// (xterm would remount with a backfill flash). Tree persists via /api/config.

import { useEffect, useRef, useState } from 'react';
import { useAppState, type Tab } from '../../lib/client/store';
import { putConfig } from '../../lib/client/api';
import {
  computeLayout, reconcile, cloneNode, seamFractions, PAD,
  type LayoutNode, type Rect,
} from '../../lib/client/grid-layout';
import TerminalPane from '../TerminalPane/TerminalPane';
import StatusDot from '../ui/StatusDot/StatusDot';
import ProviderBadge, { PROV } from '../ui/ProviderBadge/ProviderBadge';
import MeterBar from '../ui/MeterBar/MeterBar';
import LinkChip from '../ui/LinkChip/LinkChip';
import styles from './GridView.module.scss';

function fmtK(n: number): string {
  return `${Math.round(n / 1000)}k`;
}

function repoName(tab: Tab, projects: { id: string; name: string }[]): string {
  const p = projects.find((x) => x.id === tab.projectId);
  return p?.name ?? tab.label;
}

// Structural check on a persisted (untrusted JSON) tree.
function parseTree(raw: unknown): LayoutNode | null {
  const ok = (n: unknown): n is LayoutNode => {
    if (!n || typeof n !== 'object') return false;
    const o = n as Record<string, unknown>;
    if (o.t === 'l') return typeof o.id === 'string';
    if (o.t === 's')
      return (
        (o.dir === 'h' || o.dir === 'v') &&
        Array.isArray(o.f) && o.f.every((x) => typeof x === 'number' && x > 0) &&
        Array.isArray(o.c) && o.c.length === o.f.length && o.c.every(ok)
      );
    return false;
  };
  return ok(raw) ? raw : null;
}

export default function GridView() {
  const { state, dispatch } = useAppState();
  const termTabs = state.tabs.filter((t) => t.kind === 'term' && t.ptyId);
  const openIds = termTabs.map((t) => t.id);

  const wsRef = useRef<HTMLDivElement>(null);
  const [wsSize, setWsSize] = useState({ w: 0, h: 0 });
  const [tree, setTree] = useState<LayoutNode | null>(() =>
    reconcile(parseTree(state.config.gridLayout), openIds),
  );

  // Persist (debounced) — the whole config object rides along, same pattern as
  // Rail/Settings putConfig callers.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configRef = useRef(state.config);
  configRef.current = state.config;
  function saveTree(t: LayoutNode | null) {
    setTree(t);
    // Dispatch into the store synchronously so any Settings/Rail putConfig
    // (a full overwrite) during the 500ms debounce window can't clobber this
    // layout with a stale gridLayout. The debounced PUT rebuilds from
    // configRef at fire time (not the object captured here) so it still
    // carries whatever else changed in that window, with gridLayout pinned
    // to this tree.
    dispatch({ type: 'setConfig', config: { ...configRef.current, gridLayout: t } });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      putConfig({ ...configRef.current, gridLayout: t });
    }, 500);
  }
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  // Track workspace size (rail resize, window resize, sidebar toggle).
  useEffect(() => {
    const el = wsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWsSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setWsSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Reconcile when the open tab set changes (session opened/closed elsewhere).
  const openKey = openIds.join(',');
  useEffect(() => {
    // A seam drag holds a clone of `tree` in seamDrag.current and mutates it
    // in place via rAF. If reconcile swaps in a new tree mid-drag, further
    // pointermoves would mutate a detached object, and if the seam's DOM
    // node goes away (e.g. its panel closed), pointerup may never fire,
    // leaving seamDrag.current dangling and `interacting` stuck true
    // forever. Cancel any in-flight drag first — dropping a resize because
    // the layout changed underneath it is rare and acceptable.
    endDrag(false);
    const next = reconcile(tree, openIds);
    if (JSON.stringify(next) !== JSON.stringify(tree)) saveTree(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  const ws: Rect = { x: PAD, y: PAD, w: wsSize.w - PAD * 2, h: wsSize.h - PAD * 2 };
  // Not memoized: seam drag mutates fractions in place on the tree (see
  // seamDrag below) and bumps `tick` to force a recompute. computeLayout on
  // <20 panels is microseconds; memoizing here risks rendering stale rects.
  const layout = tree && ws.w > 10
    ? computeLayout(tree, ws)
    : { rects: new Map<string, Rect>(), seams: [] };

  // ── Seam drag (resize) ─────────────────────────────────────────────────
  const [, setTick] = useState(0);
  const [interacting, setInteracting] = useState(false); // suppress panel transitions
  const seamDrag = useRef<{
    node: Extract<LayoutNode, { t: 's' }>;
    i: number;
    dir: 'h' | 'v';
    start: number;
    f0: number;
    f1: number;
    span: number;
    raf: number | null;
    lastPos: number;
  } | null>(null);

  // Ends (or cancels) an in-flight seam drag. `commit` persists the mutated
  // tree (normal pointerup/pointercancel); `commit: false` just discards the
  // in-progress resize (reconcile mid-drag, unmount). Single choke point so
  // pointerup, pointercancel, the window-level fallback, the reconcile
  // guard, and unmount all share one path — no risk of seamDrag.current or
  // `interacting` dangling if any one of them fires without the others.
  function endDrag(commit: boolean) {
    const d = seamDrag.current;
    if (!d) return;
    if (d.raf != null) cancelAnimationFrame(d.raf);
    seamDrag.current = null;
    setInteracting(false);
    if (commit) saveTree(tree ? cloneNode(tree) : null); // commit + persist (new identity)
  }

  // Safety net: if the seam element is removed mid-drag (e.g. its panel
  // closed), the captured pointerup/pointercancel on that element may never
  // fire. Window-level listeners guarantee the drag always ends.
  useEffect(() => {
    if (!interacting) return;
    const onWindowUp = () => endDrag(true);
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('pointercancel', onWindowUp);
    return () => {
      window.removeEventListener('pointerup', onWindowUp);
      window.removeEventListener('pointercancel', onWindowUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interacting]);

  // Unmount safety: cancel any pending rAF / drag state, no persist.
  useEffect(() => () => endDrag(false), []);

  function onSeamPointerDown(e: React.PointerEvent, seamIdx: number) {
    const sm = layout.seams[seamIdx];
    if (!sm || !tree) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // Clone up front so the committed `tree` stays untouched until pointer-up;
    // find the matching seam on the CLONE (same index — computeLayout walks
    // the tree deterministically) and mutate its fractions in place while
    // dragging.
    const t = cloneNode(tree);
    setTree(t);
    const cloneSeams = computeLayout(t, ws).seams;
    const cs = cloneSeams[seamIdx];
    if (!cs) return;
    seamDrag.current = {
      node: cs.node,
      i: cs.i,
      dir: cs.dir,
      start: cs.dir === 'h' ? e.clientX : e.clientY,
      f0: cs.node.f[cs.i],
      f1: cs.node.f[cs.i + 1],
      span: cs.span,
      raf: null,
      lastPos: 0,
    };
    setInteracting(true);
  }

  function onSeamPointerMove(e: React.PointerEvent) {
    const d = seamDrag.current;
    if (!d) return;
    d.lastPos = d.dir === 'h' ? e.clientX : e.clientY;
    if (d.raf == null) {
      d.raf = requestAnimationFrame(() => {
        d.raf = null;
        const axis = d.dir === 'h' ? ws.w : ws.h;
        const [f0, f1] = seamFractions(d.f0, d.f1, d.lastPos - d.start, d.span, axis);
        d.node.f[d.i] = f0;
        d.node.f[d.i + 1] = f1;
        setTick((n) => n + 1); // re-render: computeLayout picks up mutated fractions
      });
    }
  }

  function onSeamPointerUp() {
    endDrag(true);
  }

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
    <div ref={wsRef} className={styles.workspace}>
      {termTabs.map((tab) => {
        const r = layout.rects.get(tab.id);
        const waiting = tab.status === 'waiting';
        const selected = tab.id === state.activeTab;
        return (
          <div
            key={tab.id}
            className={[
              styles.panel,
              waiting ? styles.waiting : '',
              tab.linkedKind ? styles.bridged : '',
              selected ? styles.selected : '',
              interacting ? styles.noAnim : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={
              r
                ? { left: r.x, top: r.y, width: r.w, height: r.h }
                : { left: 0, top: 0, width: 0, height: 0, visibility: 'hidden' }
            }
          >
            {/* Header is the select target — a live terminal can't sit inside a
                <button>, so only the header row is the clickable control. */}
            <button
              type="button"
              className={styles.head}
              onClick={() => dispatch({ type: 'activateTab', id: tab.id })}
            >
              <span className={styles.grip}>⠿</span>
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
      {layout.seams.map((s, i) => (
        <div
          key={`seam-${i}`}
          className={[
            styles.seam,
            s.dir === 'h' ? styles.seamH : styles.seamV,
            seamDrag.current ? styles.seamActive : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ left: s.x, top: s.y, width: s.w, height: s.h }}
          data-seam={i}
          onPointerDown={(e) => onSeamPointerDown(e, i)}
          onPointerMove={onSeamPointerMove}
          onPointerUp={onSeamPointerUp}
          onPointerCancel={onSeamPointerUp}
        />
      ))}
    </div>
  );
}

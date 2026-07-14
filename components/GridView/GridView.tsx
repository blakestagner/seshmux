'use client';
// Tiled grid workspace (design-3, docs/local/prototypes/grid-layout/design-3.html).
// The split tree from lib/client/grid-layout.ts drives absolutely positioned
// panels; panels are stable DOM nodes keyed by tab.id and are NEVER reparented
// (xterm would remount with a backfill flash). Tree persists via /api/config.

import { useEffect, useRef, useState } from 'react';
import { useAppState, type Tab } from '../../lib/client/store';
import { putConfig } from '../../lib/client/api';
import {
  computeLayout, reconcile, cloneNode, seamFractions, hitZone, applyDrop, focusRects, preset, PAD,
  type LayoutNode, type Rect, type DropZone,
} from '../../lib/client/grid-layout';
import TerminalPane from '../TerminalPane/TerminalPane';
import StatusDot from '../ui/StatusDot/StatusDot';
import ProviderBadge, { PROV } from '../ui/ProviderBadge/ProviderBadge';
import MeterBar from '../ui/MeterBar/MeterBar';
import LinkChip from '../ui/LinkChip/LinkChip';
import Button from '../ui/Button/Button';
import IconButton from '../ui/IconButton/IconButton';
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
  const pendingSave = useRef<LayoutNode | null>(null);
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
    pendingSave.current = t;
    saveTimer.current = setTimeout(() => {
      pendingSave.current = null;
      putConfig({ ...configRef.current, gridLayout: t });
    }, 500);
  }
  useEffect(() => () => {
    // Flush, don't cancel: a bare clearTimeout would drop a pending PUT if the
    // user seam-drags then immediately switches away from grid view (unmount)
    // before the 500ms debounce fires — the resize would never hit disk.
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      putConfig({ ...configRef.current, gridLayout: pendingSave.current });
    }
  }, []);

  // True once the user has made a layout change themselves (seam drag, panel
  // drag/drop, or a toolbar action). Gates the hydration effect below: a late
  // config/tabs arrival may adopt the persisted tree only while this is
  // false, so it can never stomp a layout the user just made.
  const userTouchedRef = useRef(false);

  // ── Focus mode (component-local — NOT persisted; a reload lands on the
  // saved tree, unfocused) ────────────────────────────────────────────────
  const [focusId, setFocusId] = useState<string | null>(null);
  const preFocus = useRef<LayoutNode | null>(null);
  // Click-without-move (onHeadPointerUp) may refocus a *different* panel
  // while focus mode is active; it never toggles the already-focused one.
  // Enter/exit toggling belongs to onDoubleClick/⛶/Esc only. A double-click
  // on a strip panel fires as click1 (refocus) then dblclick — without this
  // guard the dblclick would immediately toggle the panel it just refocused
  // right back out of focus. Record the refocus so dblclick can skip its
  // toggle when it lands on the same panel within a double-click window.
  const lastRefocus = useRef<{ id: string; time: number } | null>(null);

  function toggleFocus(id: string) {
    if (focusId === id) {
      setFocusId(null);
      if (preFocus.current) {
        // Persist, not a bare setTree — exiting focus restores the
        // pre-focus tree as the real layout and it must reach disk like any
        // other layout change, else a reload after exiting focus loses it.
        saveTree(preFocus.current);
        preFocus.current = null;
      }
    } else {
      if (!focusId) preFocus.current = cloneNode(tree!);
      setFocusId(id);
      dispatch({ type: 'activateTab', id });
    }
  }

  // ── Named layouts menu ──────────────────────────────────────────────────
  const [layoutsOpen, setLayoutsOpen] = useState(false);
  const layoutsRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!layoutsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (layoutsRef.current && !layoutsRef.current.contains(e.target as Node)) setLayoutsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLayoutsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [layoutsOpen]);

  function saveNamed() {
    const name = window.prompt('Layout name');
    if (!name || !tree) return;
    const next = { ...configRef.current, gridNamedLayouts: { ...configRef.current.gridNamedLayouts, [name]: cloneNode(tree) } };
    dispatch({ type: 'setConfig', config: next });
    putConfig(next);
    setLayoutsOpen(false);
  }

  function applyNamed(name: string) {
    const t = reconcile(parseTree(configRef.current.gridNamedLayouts[name]), openIds);
    if (t) {
      // Clear focus first (same as reset) — otherwise the persisted tree
      // diverges from focus/preFocus state: preFocus.current would still
      // point at the tree from before this named layout was applied, and
      // exiting focus later would restore that stale tree over it.
      userTouchedRef.current = true;
      setFocusId(null);
      preFocus.current = null;
      saveTree(t);
    }
    setLayoutsOpen(false);
  }

  function deleteNamed(name: string) {
    const nextLayouts = { ...configRef.current.gridNamedLayouts };
    delete nextLayouts[name];
    const next = { ...configRef.current, gridNamedLayouts: nextLayouts };
    dispatch({ type: 'setConfig', config: next });
    putConfig(next);
  }

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
    // the layout changed underneath it is rare and acceptable. Same reasoning
    // applies to an in-flight header drag (zone references a leaf id that
    // may no longer exist post-reconcile).
    endDrag(false);
    endHeadDrag(false);
    // Seed from the persisted config when there's no live tree yet. At first
    // mount openIds is [] (tabs load async after getLive), so the initial
    // useState's reconcile(parseTree(config.gridLayout), []) returns null and
    // the saved tree looks lost. By the time tabs arrive here, fall back to
    // the persisted tree instead of starting from null (which would preset()
    // and PUT over the user's saved layout).
    const base = tree ?? parseTree(configRef.current.gridLayout);
    const next = reconcile(base, openIds);
    const changed = JSON.stringify(next) !== JSON.stringify(base);
    if (changed) {
      // Genuine structural change (ids added/removed) — persist it.
      userTouchedRef.current = true;
      saveTree(next);
    } else if (JSON.stringify(next) !== JSON.stringify(tree)) {
      // Adopting the persisted tree unchanged (first hydration) — update
      // local state/store so it renders, but no PUT: nothing to save that
      // isn't already on disk.
      setTree(next);
      dispatch({ type: 'setConfig', config: { ...configRef.current, gridLayout: next } });
    }
    if (focusId && !openIds.includes(focusId)) {
      setFocusId(null);
      preFocus.current = null;
    }
    if (preFocus.current) preFocus.current = reconcile(preFocus.current, openIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  // Hydrate from persisted config whenever it changes after mount (getConfig
  // can resolve after the tree was already seeded/preset from an empty/stale
  // config). Only adopts while the user hasn't touched the layout themselves
  // — once they have, a late config arrival must never stomp it. No saveTree
  // here: adopting the user's own already-persisted layout is not a change.
  useEffect(() => {
    if (userTouchedRef.current) return;
    const persisted = parseTree(state.config.gridLayout);
    if (!persisted) return;
    const next = reconcile(persisted, openIds);
    if (!next) return;
    if (JSON.stringify(next) === JSON.stringify(tree)) return;
    setTree(next);
    dispatch({ type: 'setConfig', config: { ...configRef.current, gridLayout: next } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.config.gridLayout]);

  const ws: Rect = { x: PAD, y: PAD, w: wsSize.w - PAD * 2, h: wsSize.h - PAD * 2 };

  // ── Header drag (move panel → drop zones) ──────────────────────────────
  const [dragId, setDragId] = useState<string | null>(null);
  const [zone, setZone] = useState<DropZone | null>(null);
  // Readable inside endHeadDrag without closing over stale `zone` state — the
  // window-level pointerup fallback below captures endHeadDrag once when the
  // drag starts, when zone is still null.
  const zoneRef = useRef(zone);
  zoneRef.current = zone;
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);
  const headDrag = useRef<{
    id: string; sx: number; sy: number; active: boolean; pid: number;
    raf: number | null; lastX: number; lastY: number;
  } | null>(null);
  // Readable inside rAF/setTimeout callbacks without re-binding to a stale
  // render closure (mirrors layoutRef below).
  const treeRef = useRef(tree);
  treeRef.current = tree;

  // Layout always renders from the real tree — a header drag never reflows
  // the panels, only the zone highlight + drag ghost move. The layout
  // changes once, on drop (endHeadDrag's commit path). Not memoized: seam
  // drag mutates fractions in place on the tree (see seamDrag below) and
  // bumps `tick` to force a recompute. computeLayout on <20 panels is
  // microseconds; memoizing here risks rendering stale rects.
  const layout = tree && ws.w > 10
    ? focusId && !dragId
      ? { rects: focusRects(tree, focusId, ws), seams: [] }
      : computeLayout(tree, ws)
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
    if (commit) {
      userTouchedRef.current = true;
      saveTree(tree ? cloneNode(tree) : null); // commit + persist (new identity)
    }
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
    if (dragId) return; // a header drag is in flight — seams don't get to start a resize
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

  // Last computed layout, readable inside rAF callbacks (hitZone needs rects
  // for the CURRENT render, not whatever was captured when the handler closure
  // was created).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Ends (or cancels) an in-flight header drag. `commit` applies the last
  // hovered zone (normal pointerup/window fallback); `commit: false` discards
  // it (Esc, pointercancel, reconcile mid-drag, unmount). Single choke point,
  // same pattern as seam's endDrag — no risk of headDrag.current, the zone/
  // preview overlays, or `interacting` dangling if any one caller fires
  // without the others.
  function endHeadDrag(commit: boolean) {
    const d = headDrag.current;
    if (!d) return;
    if (d.raf != null) cancelAnimationFrame(d.raf);
    headDrag.current = null;
    const z = zoneRef.current;
    setDragId(null);
    setZone(null);
    setGhostPos(null);
    setInteracting(false);
    if (commit && d.active && z) {
      const cur = treeRef.current;
      if (cur) {
        const t = applyDrop(cloneNode(cur), d.id, z);
        if (t) {
          userTouchedRef.current = true;
          saveTree(t);
        }
      }
    }
  }

  function onHeadPointerDown(e: React.PointerEvent, tab: Tab) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-nodrag]')) return; // future header buttons
    // Still arm the press even with <2 panels so pointerup's no-move branch
    // can select — only drag activation (below, in onHeadPointerMove) is
    // gated on having another panel to drop onto.
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    headDrag.current = { id: tab.id, sx: e.clientX, sy: e.clientY, active: false, pid: e.pointerId, raf: null, lastX: e.clientX, lastY: e.clientY };
  }

  // Dedup zone updates so identical hover results don't re-render. No layout
  // preview here — the panels never move mid-drag, only the zone highlight
  // and drag ghost track the pointer. The actual layout change happens once,
  // on drop (endHeadDrag's commit path applies the drop to the real tree).
  function setZoneDebounced(z: DropZone | null) {
    setZone((prev) => {
      const key = (v: DropZone | null) => (v ? `${v.kind}:${v.target ?? ''}:${v.side}` : 'none');
      if (key(prev) === key(z)) return prev;
      return z;
    });
  }

  function onHeadPointerMove(e: React.PointerEvent) {
    const d = headDrag.current;
    if (!d) return;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    if (!d.active) {
      if (focusId) return; // focus mode: header press is select/toggle only, never a drag
      if (termTabs.length < 2) return; // nothing to drop onto — press stays select-only
      if (Math.abs(e.clientX - d.sx) < 4 && Math.abs(e.clientY - d.sy) < 4) return;
      d.active = true;
      setDragId(d.id);
      setInteracting(true);
    }
    if (d.raf == null) {
      d.raf = requestAnimationFrame(() => {
        d.raf = null;
        const dd = headDrag.current;
        const el = wsRef.current;
        if (!el || !dd?.active) return;
        const b = el.getBoundingClientRect();
        const x = dd.lastX - b.left;
        const y = dd.lastY - b.top;
        setGhostPos({ x, y });
        const z = hitZone(x, y, ws, layoutRef.current.rects, dd.id);
        setZoneDebounced(z);
      });
    }
  }

  function onHeadPointerUp(e: React.PointerEvent, tab: Tab) {
    const d = headDrag.current;
    if (!d) return;
    if (!d.active) {
      // Click without move: plain select — or, in focus mode, refocus a
      // *different* panel. Never toggles the already-focused panel itself;
      // that's onDoubleClick/⛶/Esc's job (see lastRefocus above).
      headDrag.current = null;
      if (focusId) {
        if (focusId !== tab.id) {
          lastRefocus.current = { id: tab.id, time: Date.now() };
          toggleFocus(tab.id);
        }
        return;
      }
      dispatch({ type: 'activateTab', id: tab.id });
      return;
    }
    endHeadDrag(true);
  }

  // Esc priority: cancel an in-flight header drag first, else exit focus mode.
  // Single listener — not duplicated per state — calls the same choke points
  // (endHeadDrag / toggleFocus) directly rather than fabricating pointer events.
  useEffect(() => {
    if (!dragId && !focusId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (dragId) { endHeadDrag(false); return; }
      if (focusId) toggleFocus(focusId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragId, focusId]);

  // Safety net mirroring the seam drag: if the header element loses the
  // pointer (e.g. capture lost, element unmounted mid-drag) the captured
  // pointerup/pointercancel may never fire. Window-level listeners guarantee
  // the drag always ends.
  useEffect(() => {
    if (!dragId) return;
    const onWindowUp = () => endHeadDrag(true);
    const onWindowCancel = () => endHeadDrag(false);
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('pointercancel', onWindowCancel);
    return () => {
      window.removeEventListener('pointerup', onWindowUp);
      window.removeEventListener('pointercancel', onWindowCancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragId]);

  // Unmount safety: cancel any pending rAF/timer, no persist.
  useEffect(() => () => endHeadDrag(false), []);

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
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <span className={styles.toolbarInfo}>{termTabs.length} sessions</span>
        <span className={styles.toolbarActions}>
          <Button
            variant="chip"
            onClick={() => {
              // Clear focus first (same as reset) — otherwise focusId/preFocus
              // keep pointing at pre-auto-arrange state while the persisted
              // tree has moved on, and exiting focus later would restore the
              // stale tree over the freshly auto-arranged one.
              userTouchedRef.current = true;
              setFocusId(null);
              preFocus.current = null;
              saveTree(preset(openIds));
            }}
          >
            auto-arrange
          </Button>
          <Button
            variant="chip"
            onClick={() => {
              userTouchedRef.current = true;
              setFocusId(null);
              preFocus.current = null;
              saveTree(preset(openIds));
            }}
          >
            reset
          </Button>
          <span className={styles.layoutsWrap} ref={layoutsRef}>
            <Button variant="chip" onClick={() => setLayoutsOpen((v) => !v)}>layouts ▾</Button>
            {layoutsOpen ? (
              <div className={styles.layoutsMenu}>
                {Object.keys(state.config.gridNamedLayouts).map((name) => (
                  <div key={name} className={styles.layoutRow}>
                    <button type="button" className={styles.layoutApply} onClick={() => applyNamed(name)}>{name}</button>
                    <button type="button" className={styles.layoutDel} onClick={() => deleteNamed(name)}>×</button>
                  </div>
                ))}
                <button type="button" className={styles.layoutSave} onClick={saveNamed}>save current as…</button>
              </div>
            ) : null}
          </span>
        </span>
      </div>
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
              dragId === tab.id ? styles.ghosted : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={
              r
                ? { left: r.x, top: r.y, width: r.w, height: r.h }
                : { left: 0, top: 0, width: 0, height: 0, visibility: 'hidden' }
            }
          >
            {/* Header is the select target and the drag handle — a live
                terminal can't sit inside a <button>, so only the header row
                is the clickable/draggable control. It's a div (not a
                <button>) because it now hosts the nested ⛶ focus IconButton
                — a <button> can't nest another interactive control. Selection
                happens on pointerup with no movement (see onHeadPointerUp);
                there's no onClick so a completed drag never also fires a
                select. Dblclick and the ⛶ button both toggle focus mode. */}
            <div
              role="button"
              tabIndex={0}
              className={styles.head}
              onPointerDown={(e) => onHeadPointerDown(e, tab)}
              onPointerMove={onHeadPointerMove}
              onPointerUp={(e) => onHeadPointerUp(e, tab)}
              onPointerCancel={() => endHeadDrag(false)}
              onDoubleClick={() => {
                // Skip the toggle if the first click of this double-click
                // just refocused this exact panel (see lastRefocus above) —
                // otherwise focused-A -> click-B -> dblclick-B would refocus
                // B then immediately exit focus instead of staying focused.
                const lr = lastRefocus.current;
                if (lr && lr.id === tab.id && Date.now() - lr.time < 400) {
                  lastRefocus.current = null;
                  return;
                }
                toggleFocus(tab.id);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                if (focusId) toggleFocus(tab.id);
                else dispatch({ type: 'activateTab', id: tab.id });
              }}
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
              <span
                data-nodrag
                className={styles.headBtns}
                // Stop dblclick from bubbling to the header's onDoubleClick —
                // two quick clicks on ⛶ (each a full toggleFocus via onClick)
                // must not ALSO fire the header's toggle a third time.
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <IconButton
                  label={focusId === tab.id ? 'Exit focus' : 'Focus'}
                  variant="bare"
                  onClick={() => toggleFocus(tab.id)}
                >⛶</IconButton>
              </span>
            </div>
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
      {zone ? (
        <div className={styles.zone} style={{ left: zone.x, top: zone.y, width: zone.w, height: zone.h }} />
      ) : null}
      {(() => {
        // Resolve to a variable and only render if found — the dragged tab
        // can be removed (session closed) mid-drag in the same render, and
        // the old non-null assertion would throw instead of just skipping
        // the ghost.
        const dragTab = dragId ? termTabs.find((t) => t.id === dragId) : undefined;
        return dragTab && ghostPos ? (
          <div className={styles.dragGhost} style={{ left: ghostPos.x, top: ghostPos.y }}>
            {repoName(dragTab, state.projects)}
          </div>
        ) : null;
      })()}
      {dragId ? (
        <div className={styles.hint}>drop on an edge to split · center to swap · esc to cancel</div>
      ) : null}
      </div>
    </div>
  );
}

// Scratch-terminal Stage 1: the pure {open, active} per-tab right-pane panel
// model. No React, no imports — reducer-style immutable helpers mirroring
// store.ts, unit-tested before any render-path surgery (Stage 2). Nothing
// imports this yet at Stage 1.
//
// A right pane is a strip of panel tabs (agents / team / changes / terminal)
// scoped to ONE workspace tab. `open` is the insertion-ordered list of panels
// the user has opened (= tab-strip render order); `active` is the one shown.
// The whole record is keyed by workspace tab id so each tab keeps its own set
// (edge H isolation). An empty pane deletes its record entry so the split
// collapses back to a solo terminal.

export type PanelId = 'agents' | 'team' | 'changes' | 'terminal';
export interface PaneState {
  open: PanelId[];
  active: PanelId | null;
}
export type RightPaneRecord = Record<string, PaneState>; // keyed by tab id

// add if absent, always set active.
export function openPanel(rec: RightPaneRecord, tabId: string, id: PanelId): RightPaneRecord {
  const pane = rec[tabId];
  const open = pane && pane.open.includes(id) ? pane.open : [...(pane?.open ?? []), id];
  return { ...rec, [tabId]: { open, active: id } };
}

// absent → open+activate; present+active → close it (remove, active falls back);
// present+inactive → activate only.
export function togglePanel(rec: RightPaneRecord, tabId: string, id: PanelId): RightPaneRecord {
  const pane = rec[tabId];
  if (!pane || !pane.open.includes(id)) return openPanel(rec, tabId, id);
  if (pane.active === id) return closePanel(rec, tabId, id);
  return { ...rec, [tabId]: { ...pane, active: id } };
}

// remove from open; if it was active, active falls back to the last remaining
// open panel (or null); an emptied pane deletes its record entry so the split
// collapses.
export function closePanel(rec: RightPaneRecord, tabId: string, id: PanelId): RightPaneRecord {
  const pane = rec[tabId];
  if (!pane || !pane.open.includes(id)) return rec;
  const open = pane.open.filter((p) => p !== id);
  if (open.length === 0) return pruneTab(rec, tabId);
  const active = pane.active === id ? open[open.length - 1] : pane.active;
  return { ...rec, [tabId]: { open, active } };
}

// closeTab hook (edge D "prune the record"): drop only that tab's entry.
export function pruneTab(rec: RightPaneRecord, tabId: string): RightPaneRecord {
  if (!(tabId in rec)) return rec;
  const next = { ...rec };
  delete next[tabId];
  return next;
}

// Gate-fails-while-open fallthrough (edge D): the render calls this every pass
// to decide which panel to actually show. Returns `active` if its gate passes,
// else the LAST panel in `open` whose gate passes, else null (pane collapses to
// a solo terminal). `open` is PRESERVED — a recovered gate re-shows its panel.
export function resolveActive(
  pane: PaneState | undefined,
  gates: Record<PanelId, boolean>,
): PanelId | null {
  if (!pane) return null;
  if (pane.active && gates[pane.active]) return pane.active;
  for (let i = pane.open.length - 1; i >= 0; i--) {
    if (gates[pane.open[i]]) return pane.open[i];
  }
  return null;
}

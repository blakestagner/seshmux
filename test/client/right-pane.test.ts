import { describe, it, expect } from 'vitest';
import {
  togglePanel,
  openPanel,
  closePanel,
  pruneTab,
  resolveActive,
  type PanelId,
  type RightPaneRecord,
} from '../../lib/client/right-pane';

const allGatesPass: Record<PanelId, boolean> = { agents: true, team: true, changes: true, terminal: true };

describe('openPanel', () => {
  it('adds the first panel to open and makes it active', () => {
    const rec = openPanel({}, 'tab-1', 'agents');
    expect(rec['tab-1']).toEqual({ open: ['agents'], active: 'agents' });
  });

  it('adds a second panel and makes it active, preserving insertion order', () => {
    let rec = openPanel({}, 'tab-1', 'agents');
    rec = openPanel(rec, 'tab-1', 'changes');
    expect(rec['tab-1']).toEqual({ open: ['agents', 'changes'], active: 'changes' });
  });

  it('re-opening an already-open panel just re-activates it (no duplicate)', () => {
    let rec = openPanel({}, 'tab-1', 'agents');
    rec = openPanel(rec, 'tab-1', 'changes');
    rec = openPanel(rec, 'tab-1', 'agents');
    expect(rec['tab-1']).toEqual({ open: ['agents', 'changes'], active: 'agents' });
  });

  it('is immutable (returns a new record + pane)', () => {
    const rec: RightPaneRecord = {};
    const next = openPanel(rec, 'tab-1', 'agents');
    expect(next).not.toBe(rec);
    expect(rec).toEqual({});
  });
});

describe('togglePanel', () => {
  it('absent → add to open + set active', () => {
    const rec = togglePanel({}, 'tab-1', 'agents');
    expect(rec['tab-1']).toEqual({ open: ['agents'], active: 'agents' });
  });

  it('present + active → closes it (removed from open, active falls back)', () => {
    let rec = openPanel({}, 'tab-1', 'agents');
    rec = openPanel(rec, 'tab-1', 'changes'); // active = changes
    rec = togglePanel(rec, 'tab-1', 'changes'); // toggle active → close
    expect(rec['tab-1']).toEqual({ open: ['agents'], active: 'agents' });
  });

  it('present + inactive → activates without removing', () => {
    let rec = openPanel({}, 'tab-1', 'agents');
    rec = openPanel(rec, 'tab-1', 'changes'); // active = changes, agents inactive
    rec = togglePanel(rec, 'tab-1', 'agents'); // toggle inactive → activate
    expect(rec['tab-1']).toEqual({ open: ['agents', 'changes'], active: 'agents' });
  });

  it('toggle the only open panel → record entry deleted (pane collapses)', () => {
    let rec = openPanel({}, 'tab-1', 'agents');
    rec = togglePanel(rec, 'tab-1', 'agents');
    expect(rec['tab-1']).toBeUndefined();
  });
});

describe('closePanel', () => {
  it('removes from open; active falls back to last remaining', () => {
    let rec = openPanel({}, 'tab-1', 'agents');
    rec = openPanel(rec, 'tab-1', 'changes'); // active = changes
    rec = closePanel(rec, 'tab-1', 'changes');
    expect(rec['tab-1']).toEqual({ open: ['agents'], active: 'agents' });
  });

  it('closing an inactive panel keeps the active one', () => {
    let rec = openPanel({}, 'tab-1', 'agents');
    rec = openPanel(rec, 'tab-1', 'changes'); // active = changes
    rec = closePanel(rec, 'tab-1', 'agents');
    expect(rec['tab-1']).toEqual({ open: ['changes'], active: 'changes' });
  });

  it('closing the last panel deletes the record entry (pane collapses)', () => {
    let rec = openPanel({}, 'tab-1', 'agents');
    rec = closePanel(rec, 'tab-1', 'agents');
    expect(rec['tab-1']).toBeUndefined();
  });

  it('closing a panel not in open is a no-op', () => {
    const rec = openPanel({}, 'tab-1', 'agents');
    const next = closePanel(rec, 'tab-1', 'changes');
    expect(next['tab-1']).toEqual({ open: ['agents'], active: 'agents' });
  });

  it('closing on an absent tab is a no-op', () => {
    const next = closePanel({}, 'tab-x', 'agents');
    expect(next).toEqual({});
  });
});

describe('pruneTab', () => {
  it('removes only that tab entry, leaving other tabs untouched (edge H)', () => {
    let rec = openPanel({}, 'tab-1', 'agents');
    rec = openPanel(rec, 'tab-2', 'changes');
    const next = pruneTab(rec, 'tab-1');
    expect(next['tab-1']).toBeUndefined();
    expect(next['tab-2']).toEqual({ open: ['changes'], active: 'changes' });
  });

  it('pruning an absent tab returns the same record identity', () => {
    const rec = openPanel({}, 'tab-1', 'agents');
    expect(pruneTab(rec, 'tab-nope')).toBe(rec);
  });
});

describe('resolveActive', () => {
  it('returns null for an absent pane', () => {
    expect(resolveActive(undefined, allGatesPass)).toBeNull();
  });

  it('returns the active panel when its gate passes', () => {
    const pane = { open: ['agents', 'changes'] as PanelId[], active: 'changes' as PanelId };
    expect(resolveActive(pane, allGatesPass)).toBe('changes');
  });

  it('active gate fails → falls through to the LAST open panel whose gate passes', () => {
    const pane = { open: ['agents', 'team', 'changes'] as PanelId[], active: 'changes' as PanelId };
    const gates = { ...allGatesPass, changes: false };
    expect(resolveActive(pane, gates)).toBe('team');
  });

  it('all gates fail → null (pane collapses to solo terminal)', () => {
    const pane = { open: ['agents', 'changes'] as PanelId[], active: 'changes' as PanelId };
    const gates: Record<PanelId, boolean> = { agents: false, team: false, changes: false, terminal: false };
    expect(resolveActive(pane, gates)).toBeNull();
  });

  it('gate recovery → original active shows again (open list untouched)', () => {
    const pane = { open: ['agents', 'changes'] as PanelId[], active: 'changes' as PanelId };
    // gate fails, falls through
    expect(resolveActive(pane, { ...allGatesPass, changes: false })).toBe('agents');
    // gate recovers, original active shows again — pane object never mutated
    expect(resolveActive(pane, allGatesPass)).toBe('changes');
    expect(pane.open).toEqual(['agents', 'changes']);
  });
});

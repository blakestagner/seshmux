import { describe, it, expect } from 'vitest';
import { reducer, initialState, shouldMarkUnviewed, findTabToBindSession, activeTeam, type Tab } from '../../lib/client/store';

function tab(overrides: Partial<Tab> & Pick<Tab, 'id' | 'kind' | 'label'>): Tab {
  return overrides;
}

describe('openSession', () => {
  it('dedupes by sessionId', () => {
    let state = initialState();
    state = reducer(state, { type: 'openSession', sessionId: 's1', projectId: 'p1', label: 'p1', kind: 'term' });
    state = reducer(state, { type: 'openSession', sessionId: 's1', projectId: 'p1', label: 'p1', kind: 'term' });
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTab).toBe(state.tabs[0].id);
  });

  // Grid bug: grid renders ONLY term tabs, so activating a transcript tab
  // while in grid view showed nothing at all. Opening a non-term tab must
  // leave grid; landing on a term tab stays (the tile highlights in place).
  it('opening a transcript while in grid view switches to tabs view', () => {
    let state = initialState({ view: 'grid' });
    state = reducer(state, { type: 'openSession', sessionId: 's1', projectId: 'p1', label: 'p1', kind: 'transcript' });
    expect(state.view).toBe('tabs');
  });

  it('dedup onto an existing TERM tab stays in grid view', () => {
    const term = tab({ id: 'term-pty-1', kind: 'term', label: 'p1', ptyId: 'pty-1', sessionId: 's1' });
    let state = initialState({ tabs: [term], view: 'grid' });
    state = reducer(state, { type: 'openSession', sessionId: 's1', projectId: 'p1', label: 'p1', kind: 'transcript' });
    expect(state.view).toBe('grid');
    expect(state.activeTab).toBe('term-pty-1');
  });

  it('dedup onto an existing TRANSCRIPT tab while in grid also leaves grid', () => {
    const tr = tab({ id: 'tab-s1', kind: 'transcript', label: 'p1', sessionId: 's1' });
    let state = initialState({ tabs: [tr], view: 'grid' });
    state = reducer(state, { type: 'openSession', sessionId: 's1', projectId: 'p1', label: 'p1', kind: 'transcript' });
    expect(state.view).toBe('tabs');
  });
});

describe('closeTab', () => {
  it('picks neighbor tabs[max(0,i-1)] as new active', () => {
    let state = initialState();
    state = reducer(state, { type: 'openSession', sessionId: 'a', projectId: 'p', label: 'a', kind: 'term' });
    state = reducer(state, { type: 'openSession', sessionId: 'b', projectId: 'p', label: 'b', kind: 'term' });
    state = reducer(state, { type: 'openSession', sessionId: 'c', projectId: 'p', label: 'c', kind: 'term' });
    // active is 'c' (index 2); close it -> neighbor at max(0, 2-1) = index 1 = 'b'
    state = reducer(state, { type: 'closeTab', id: 'tab-c' });
    expect(state.tabs.map((t) => t.id)).toEqual(['tab-a', 'tab-b']);
    expect(state.activeTab).toBe('tab-b');
  });

  it('closing the first tab picks index 0 (the new first tab)', () => {
    let state = initialState();
    state = reducer(state, { type: 'openSession', sessionId: 'a', projectId: 'p', label: 'a', kind: 'term' });
    state = reducer(state, { type: 'openSession', sessionId: 'b', projectId: 'p', label: 'b', kind: 'term' });
    state = reducer(state, { type: 'activateTab', id: 'tab-a' });
    state = reducer(state, { type: 'closeTab', id: 'tab-a' });
    expect(state.tabs.map((t) => t.id)).toEqual(['tab-b']);
    expect(state.activeTab).toBe('tab-b');
  });
});

describe('moveTabBlock', () => {
  it('moves a linked handoff pair together and keeps them adjacent', () => {
    const src = tab({ id: 'tab-src', kind: 'term', label: 'src', sessionId: 'src' });
    const handoff = tab({ id: 'tab-handoff', kind: 'term', label: 'handoff', sessionId: 'handoff', linked: true, linkedKind: 'handoff', linkSrc: 'src' });
    const other = tab({ id: 'tab-other', kind: 'term', label: 'other', sessionId: 'other' });
    let state = initialState({ tabs: [src, handoff, other] });

    // drag the block (identified by its source tab id) to sit at 'other'
    state = reducer(state, { type: 'moveTabBlock', from: 'tab-src', to: 'tab-other' });

    const ids = state.tabs.map((t) => t.id);
    // block was already immediately before 'other' -- net position unchanged,
    // but the pair must stay adjacent and intact either way
    const srcIdx = ids.indexOf('tab-src');
    const handoffIdx = ids.indexOf('tab-handoff');
    expect(handoffIdx).toBe(srcIdx + 1);
    expect(ids).toContain('tab-other');
  });

  it('never splits or straddles the block when dragging the linked tab itself', () => {
    const src = tab({ id: 'tab-src', kind: 'term', label: 'src', sessionId: 'src' });
    const review = tab({ id: 'tab-review', kind: 'term', label: 'review', sessionId: 'review', linked: true, linkedKind: 'review', linkSrc: 'src' });
    const middle = tab({ id: 'tab-middle', kind: 'term', label: 'middle', sessionId: 'middle' });
    const last = tab({ id: 'tab-last', kind: 'term', label: 'last', sessionId: 'last' });
    let state = initialState({ tabs: [src, review, middle, last] });

    // drag the linked (review) tab -- should move the whole block, not just itself
    state = reducer(state, { type: 'moveTabBlock', from: 'tab-review', to: 'tab-last' });

    const ids = state.tabs.map((t) => t.id);
    expect(ids).toEqual(['tab-middle', 'tab-src', 'tab-review', 'tab-last']);
    const srcIdx = ids.indexOf('tab-src');
    const reviewIdx = ids.indexOf('tab-review');
    expect(reviewIdx).toBe(srcIdx + 1); // still adjacent, never straddled by 'last'
  });

  it('dropping a lone tab between block members does not split the block', () => {
    const lone = tab({ id: 'tab-lone', kind: 'term', label: 'lone', sessionId: 'lone' });
    const mid = tab({ id: 'tab-mid', kind: 'term', label: 'mid', sessionId: 'mid' });
    const src = tab({ id: 'tab-src', kind: 'term', label: 'src', sessionId: 'src' });
    const handoff = tab({ id: 'tab-handoff', kind: 'term', label: 'handoff', sessionId: 'handoff', linked: true, linkedKind: 'handoff', linkSrc: 'src' });
    let state = initialState({ tabs: [lone, mid, src, handoff] });

    // drop 'lone' onto the linked 'handoff' tab -- if the block logic were
    // broken, 'lone' would land BETWEEN src and handoff (straddling them);
    // instead the whole [src,handoff] block must move as one unit
    state = reducer(state, { type: 'moveTabBlock', from: 'tab-lone', to: 'tab-handoff' });

    const ids = state.tabs.map((t) => t.id);
    expect(ids).toEqual(['tab-mid', 'tab-lone', 'tab-src', 'tab-handoff']);
    const srcIdx = ids.indexOf('tab-src');
    const handoffIdx = ids.indexOf('tab-handoff');
    expect(handoffIdx).toBe(srcIdx + 1); // block never straddled by 'lone'
  });

  it('no-op when from and to are in the same block', () => {
    const src = tab({ id: 'tab-src', kind: 'term', label: 'src', sessionId: 'src' });
    const handoff = tab({ id: 'tab-handoff', kind: 'term', label: 'handoff', sessionId: 'handoff', linked: true, linkedKind: 'handoff', linkSrc: 'src' });
    const state = initialState({ tabs: [src, handoff] });
    const next = reducer(state, { type: 'moveTabBlock', from: 'tab-src', to: 'tab-handoff' });
    expect(next.tabs).toEqual(state.tabs);
  });
});

describe('setProvFilter', () => {
  it('leaves tabs untouched, only changes provFilter', () => {
    let state = initialState();
    state = reducer(state, { type: 'openSession', sessionId: 's1', projectId: 'p1', label: 'p1', kind: 'term' });
    const tabsBefore = state.tabs;
    state = reducer(state, { type: 'setProvFilter', filter: 'codex' });
    expect(state.provFilter).toBe('codex');
    expect(state.tabs).toBe(tabsBefore);
  });
});

describe('setConfig', () => {
  it('normalizes a legacy/older-server config missing newer fields (hidden crash regression)', () => {
    let state = initialState();
    // an old server's /api/config payload: no `hidden`, no `settings`
    state = reducer(state, {
      type: 'setConfig',
      config: { pins: ['p1'], projectOrder: [], theme: 'dark', accent: 'iris' } as never,
    });
    expect(state.config.hidden).toEqual([]);
    expect(state.config.pins).toEqual(['p1']);
    expect(state.config.settings).toEqual({});
  });
});

describe('setTermStatus', () => {
  it('updates only the matching term tab by ptyId', () => {
    const t1 = tab({ id: 'term-a', kind: 'term', label: 'a', ptyId: 'a', status: 'live' });
    const t2 = tab({ id: 'term-b', kind: 'term', label: 'b', ptyId: 'b', status: 'live' });
    let state = initialState({ tabs: [t1, t2] });
    state = reducer(state, { type: 'setTermStatus', ptyId: 'b', status: 'waiting' });
    expect(state.tabs.find((t) => t.ptyId === 'a')!.status).toBe('live');
    expect(state.tabs.find((t) => t.ptyId === 'b')!.status).toBe('waiting');
  });

  it('ignores non-term tabs and unknown ptyIds', () => {
    const doc = tab({ id: 'tab-t', kind: 'transcript', label: 't', ptyId: 'a', status: 'done' });
    let state = initialState({ tabs: [doc] });
    state = reducer(state, { type: 'setTermStatus', ptyId: 'a', status: 'waiting' });
    expect(state.tabs[0].status).toBe('done'); // transcript tab untouched
    const same = reducer(state, { type: 'setTermStatus', ptyId: 'zzz', status: 'waiting' });
    expect(same.tabs).toEqual(state.tabs);
  });
});

describe('setTermCtx', () => {
  it('sets ctx on the tab matching sessionId', () => {
    const t = tab({ id: 'term-a', kind: 'term', label: 'a', sessionId: 's1', ptyId: 'a' });
    let state = initialState({ tabs: [t] });
    state = reducer(state, { type: 'setTermCtx', sessionId: 's1', ctx: { tokens: 100_000, window: 200_000 } });
    expect(state.tabs[0].ctx).toEqual({ tokens: 100_000, window: 200_000 });
  });
});

// Spec 3 — done (unviewed) state.
describe('shouldMarkUnviewed (pure transition decision)', () => {
  it('marks on working -> idle when not the active tab', () => {
    expect(shouldMarkUnviewed('working', 'idle', false, false)).toBe(true);
  });

  it('marks on working -> waiting when not the active tab', () => {
    expect(shouldMarkUnviewed('working', 'waiting', false, false)).toBe(true);
  });

  it('marks when the tab IS active but the browser tab is hidden', () => {
    expect(shouldMarkUnviewed('working', 'idle', true, true)).toBe(true);
  });

  it('never marks a transition in the focused, visible tab', () => {
    expect(shouldMarkUnviewed('working', 'idle', true, false)).toBe(false);
  });

  it('never marks when there was no prior status (first event / reconnect replay)', () => {
    expect(shouldMarkUnviewed(undefined, 'idle', false, false)).toBe(false);
    expect(shouldMarkUnviewed(undefined, 'waiting', false, true)).toBe(false);
  });

  it('never marks a non-transition (idle -> idle replay, waiting -> waiting)', () => {
    expect(shouldMarkUnviewed('idle', 'idle', false, true)).toBe(false);
    expect(shouldMarkUnviewed('waiting', 'waiting', false, true)).toBe(false);
  });

  it('never marks working -> working', () => {
    expect(shouldMarkUnviewed('working', 'working', false, true)).toBe(false);
  });
});

describe('markUnviewed', () => {
  it('flips unviewed on the matching term tab only', () => {
    const t1 = tab({ id: 'term-a', kind: 'term', label: 'a', ptyId: 'a' });
    const t2 = tab({ id: 'term-b', kind: 'term', label: 'b', ptyId: 'b' });
    let state = initialState({ tabs: [t1, t2] });
    state = reducer(state, { type: 'markUnviewed', ptyId: 'a' });
    expect(state.tabs.find((t) => t.ptyId === 'a')!.unviewed).toBe(true);
    expect(state.tabs.find((t) => t.ptyId === 'b')!.unviewed).toBeFalsy();
  });
});

describe('activateTab clears unviewed', () => {
  it('clears unviewed on the tab being focused', () => {
    const t1 = tab({ id: 'term-a', kind: 'term', label: 'a', ptyId: 'a', unviewed: true });
    let state = initialState({ tabs: [t1], activeTab: null });
    state = reducer(state, { type: 'activateTab', id: 'term-a' });
    expect(state.tabs[0].unviewed).toBe(false);
    expect(state.activeTab).toBe('term-a');
  });

  it('openTerm on an already-open ptyId (re-focus) also clears unviewed', () => {
    const t1 = tab({ id: 'term-a', kind: 'term', label: 'a', ptyId: 'a', unviewed: true, projectId: 'p1' });
    let state = initialState({ tabs: [t1] });
    state = reducer(state, { type: 'openTerm', ptyId: 'a', projectId: 'p1', label: 'a' });
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].unviewed).toBe(false);
  });

  it('openSession on an already-open sessionId (re-focus) also clears unviewed', () => {
    const t1 = tab({ id: 'tab-s1', kind: 'transcript', label: 'a', sessionId: 's1', unviewed: true, projectId: 'p1' });
    let state = initialState({ tabs: [t1] });
    state = reducer(state, { type: 'openSession', sessionId: 's1', projectId: 'p1', label: 'a', kind: 'transcript' });
    expect(state.tabs[0].unviewed).toBe(false);
  });
});

// BUG A (subagent chip never appears live): the live term tab has no sessionId
// until a) openTerm is given one (reload enrichment) or b) setTabSession backfills
// it (fresh-spawn session-new/touch bind). Both are the fix for
// docs/plans/2026-07-10-subagent-attach-bugs-rootcause.md BUG A.
describe('openTerm + setTabSession: sessionId', () => {
  it('openTerm sets sessionId on the new tab when provided (reload enrichment)', () => {
    let state = initialState();
    state = reducer(state, { type: 'openTerm', ptyId: 'a', projectId: 'p1', label: 'a', sessionId: 's1' });
    expect(state.tabs[0].sessionId).toBe('s1');
  });

  it('openTerm omits sessionId when not provided (fresh spawn, unknown yet)', () => {
    let state = initialState();
    state = reducer(state, { type: 'openTerm', ptyId: 'a', projectId: 'p1', label: 'a' });
    expect(state.tabs[0].sessionId).toBeUndefined();
  });

  it('setTabSession backfills sessionId on the matching tab', () => {
    const t1 = tab({ id: 'term-a', kind: 'term', label: 'a', ptyId: 'a', projectId: 'p1' });
    let state = initialState({ tabs: [t1] });
    state = reducer(state, { type: 'setTabSession', tabId: 'term-a', sessionId: 's1' });
    expect(state.tabs[0].sessionId).toBe('s1');
  });

  it('setTabSession never touches a different tab', () => {
    const t1 = tab({ id: 'term-a', kind: 'term', label: 'a', ptyId: 'a', projectId: 'p1' });
    const t2 = tab({ id: 'term-b', kind: 'term', label: 'b', ptyId: 'b', projectId: 'p1' });
    let state = initialState({ tabs: [t1, t2] });
    state = reducer(state, { type: 'setTabSession', tabId: 'term-a', sessionId: 's1' });
    expect(state.tabs.find((t) => t.id === 'term-b')?.sessionId).toBeUndefined();
  });
});

describe('findTabToBindSession (BUG A part 1: fresh-spawn live bind)', () => {
  it('binds the only unbound term tab matching the projectId', () => {
    const t1 = tab({ id: 'term-a', kind: 'term', label: 'a', ptyId: 'a', projectId: 'p1' });
    expect(findTabToBindSession([t1], 'p1')).toBe('term-a');
  });

  it('never rebinds a tab that already has a sessionId', () => {
    const t1 = tab({ id: 'term-a', kind: 'term', label: 'a', ptyId: 'a', projectId: 'p1', sessionId: 'existing' });
    expect(findTabToBindSession([t1], 'p1')).toBeNull();
  });

  it('ignores tabs from a different project', () => {
    const t1 = tab({ id: 'term-a', kind: 'term', label: 'a', ptyId: 'a', projectId: 'p2' });
    expect(findTabToBindSession([t1], 'p1')).toBeNull();
  });

  it('ignores non-term tabs', () => {
    const t1 = tab({ id: 'tab-s1', kind: 'transcript', label: 'a', projectId: 'p1' });
    expect(findTabToBindSession([t1], 'p1')).toBeNull();
  });

  it('picks the last (most-recently-opened) unbound tab on ambiguity', () => {
    const t1 = tab({ id: 'term-a', kind: 'term', label: 'a', ptyId: 'a', projectId: 'p1' });
    const t2 = tab({ id: 'term-b', kind: 'term', label: 'b', ptyId: 'b', projectId: 'p1' });
    expect(findTabToBindSession([t1, t2], 'p1')).toBe('term-b');
  });

  it('returns null when no tab matches', () => {
    expect(findTabToBindSession([], 'p1')).toBeNull();
  });
});

describe('Hidden projects', () => {
  it('toggleHidden adds then removes a project id', () => {
    let state = initialState();
    state = reducer(state, { type: 'toggleHidden', id: 'p1' });
    expect(state.config.hidden).toEqual(['p1']);
    state = reducer(state, { type: 'toggleHidden', id: 'p1' });
    expect(state.config.hidden).toEqual([]);
  });

  it('setShowHidden toggles the session-local bypass', () => {
    const state = reducer(initialState(), { type: 'setShowHidden', on: true });
    expect(state.showHidden).toBe(true);
  });
});

describe('agents view store support', () => {
  it('setTermStatus records raw ni + timestamp on the tab', () => {
    const t = tab({ id: 'term-p1', kind: 'term', label: 'x', ptyId: 'p1' });
    let state = initialState({ tabs: [t] });
    state = reducer(state, { type: 'setTermStatus', ptyId: 'p1', status: 'live', ni: 'working', ts: 123 });
    expect(state.tabs[0].ni).toBe('working');
    expect(state.tabs[0].lastStatusTs).toBe(123);
  });

  it('setTermStatus without ni/ts (legacy caller) still works', () => {
    const t = tab({ id: 'term-p1', kind: 'term', label: 'x', ptyId: 'p1' });
    let state = initialState({ tabs: [t] });
    state = reducer(state, { type: 'setTermStatus', ptyId: 'p1', status: 'waiting' });
    expect(state.tabs[0].status).toBe('waiting');
    expect(state.tabs[0].ni).toBeUndefined();
  });

  it('openSession onto a non-term tab while in AGENTS view drops to tabs view', () => {
    let state = initialState({ view: 'agents' });
    state = reducer(state, { type: 'openSession', sessionId: 's1', projectId: 'p1', label: 'p1', kind: 'transcript' });
    expect(state.view).toBe('tabs');
  });
});

describe('activeTeam (Task 6, mirrors activePair)', () => {
  it('null when there is no active tab', () => {
    expect(activeTeam([], null)).toBeNull();
  });

  it('null for a normal (non-team) term tab', () => {
    const t = tab({ id: 'term-p1', kind: 'term', label: 'x', ptyId: 'p1', sessionId: 's1' });
    expect(activeTeam([t], 'term-p1')).toBeNull();
  });

  it('null when isTeamLead but sessionId not yet bound (fresh spawn, pre session-new)', () => {
    const t = tab({ id: 'term-p1', kind: 'term', label: 'x', ptyId: 'p1', isTeamLead: true });
    expect(activeTeam([t], 'term-p1')).toBeNull();
  });

  it('resolves once isTeamLead + sessionId are both set — leadSessionId mirrors sessionId', () => {
    const t = tab({ id: 'term-p1', kind: 'term', label: 'x', ptyId: 'p1', sessionId: 's1', isTeamLead: true });
    const result = activeTeam([t], 'term-p1');
    expect(result).not.toBeNull();
    expect(result!.tab.id).toBe('term-p1');
    expect(result!.leadSessionId).toBe('s1');
  });

  it('does not gate on teamName — the split must not wait on the async roster fetch', () => {
    const t = tab({ id: 'term-p1', kind: 'term', label: 'x', ptyId: 'p1', sessionId: 's1', isTeamLead: true });
    expect(t.teamName).toBeUndefined();
    expect(activeTeam([t], 'term-p1')).not.toBeNull();
  });

  it('null for a transcript-kind tab even if isTeamLead somehow set', () => {
    const t = tab({ id: 'tab-s1', kind: 'transcript', label: 'x', sessionId: 's1', isTeamLead: true });
    expect(activeTeam([t], 'tab-s1')).toBeNull();
  });
});

describe('setTabTeam', () => {
  it('marks isTeamLead + teamName on the matching tab, leaves others untouched', () => {
    const a = tab({ id: 'term-a', kind: 'term', label: 'a', ptyId: 'a', sessionId: 's1' });
    const b = tab({ id: 'term-b', kind: 'term', label: 'b', ptyId: 'b', sessionId: 's2' });
    let state = initialState({ tabs: [a, b] });
    state = reducer(state, { type: 'setTabTeam', tabId: 'term-a', teamName: 'session-abc123' });
    expect(state.tabs[0].isTeamLead).toBe(true);
    expect(state.tabs[0].teamName).toBe('session-abc123');
    expect(state.tabs[1].isTeamLead).toBeUndefined();
  });
});

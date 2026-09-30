// InlineRename end-of-edit decision (PR #67 review): committing the untouched prefill
// must be a CANCEL, never a save — otherwise opening rename on a term tab (prefilled
// with the project name) and clicking away pinned the project name as a custom name.
//
// InlineRename.finish() is a thin wrapper: it calls onCommit only when
// editOutcome({ wantCommit, value, openedWith, current, dirty, normalize }) is
// 'commit' — `openedWith` a mount-time snapshot, `current` the live `initial` prop,
// `dirty` whether the user typed — and both hosts (Rail, Tabs) only PUT from
// onCommit. The repo has no DOM test environment, so the component wiring itself
// (Enter/blur/Escape, focus restore) is covered by the Playwright run in the PR;
// this pins the decision it delegates to.
import { describe, it, expect } from 'vitest';
import { editOutcome, isUnchangedEdit, type EditState } from '../../components/ui/InlineRename/inline-edit';
import { normalizeSessionName, SESSION_NAME_MAX } from '../../lib/client/session-names';

const n = normalizeSessionName;
const st = (over: Partial<EditState>): EditState => ({
  wantCommit: true,
  value: 'x',
  openedWith: 'x',
  current: 'x',
  dirty: true,
  normalize: n,
  ...over,
});

describe('isUnchangedEdit (with the save-path normalizer)', () => {
  it('whitespace-only differences are no change; case and content are', () => {
    expect(isUnchangedEdit('  seshmux ', 'seshmux', n)).toBe(true);
    expect(isUnchangedEdit('a   b', 'a b', n)).toBe(true);
    expect(isUnchangedEdit('Seshmux', 'seshmux', n)).toBe(false);
    expect(isUnchangedEdit('', 'seshmux', n)).toBe(false);
  });

  it('agrees with renameSession on long / control-char prefills', () => {
    const long = 'x'.repeat(SESSION_NAME_MAX + 30);
    expect(isUnchangedEdit(long + 'y', long, n)).toBe(true); // past the cap = no change
    expect(isUnchangedEdit('a\u0001b', 'a b', n)).toBe(true);
    expect(isUnchangedEdit('z' + long.slice(1), long, n)).toBe(false);
  });
});

describe('editOutcome (what finish() does)', () => {
  it('Enter/blur on an UNTOUCHED field → cancel (no onCommit → no PUT)', () => {
    // term tab prefilled with the project name
    expect(editOutcome(st({ value: 'seshmux', openedWith: 'seshmux', current: 'seshmux', dirty: false }))).toBe('cancel');
    // resumed-in-place tab prefilled with the auto title
    expect(editOutcome(st({ value: 'auto', openedWith: 'auto', current: 'auto', dirty: false }))).toBe('cancel');
  });

  it('untouched field whose host prop changed mid-edit → still cancel (no stale-prefill save)', () => {
    // opened on an 'untitled' row; a rescan then gave the row its real title
    expect(editOutcome(st({ value: 'untitled', openedWith: 'untitled', current: 'the real prompt', dirty: false }))).toBe('cancel');
  });

  it('Escape → cancel even after a change', () => {
    expect(editOutcome(st({ wantCommit: false, value: 'new', openedWith: 'old', current: 'old' }))).toBe('cancel');
  });

  it('edited then restored to the opened value, host unchanged → cancel', () => {
    expect(editOutcome(st({ value: 'seshmux', openedWith: 'seshmux', current: 'seshmux' }))).toBe('cancel');
  });

  it('a real change → commit (incl. clearing)', () => {
    expect(editOutcome(st({ value: 'Live renamed', openedWith: 'seshmux', current: 'seshmux' }))).toBe('commit');
    expect(editOutcome(st({ value: '', openedWith: 'My custom', current: 'My custom' }))).toBe('commit');
  });

  it('typing the auto title back over a custom name → commit (renameSession then clears)', () => {
    expect(editOutcome(st({ value: 'auto title', openedWith: 'My custom', current: 'My custom' }))).toBe('commit');
  });

  it('restoring the opened name after another client renamed it meanwhile → commit', () => {
    // opened with 'Foo'; a WS rename made the host show 'Bar'; the user edits back to 'Foo'
    expect(editOutcome(st({ value: 'Foo', openedWith: 'Foo', current: 'Bar' }))).toBe('commit');
  });
});

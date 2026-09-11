// memory-groups: turning a ranked run of records into session groups. Pure, so this is the
// whole specification of the panel's list order — which group leads, what a group is called
// when nothing named it, and that pinning still means "kept to hand" after grouping.
import { describe, it, expect } from 'vitest';
import {
  defaultOpenGroups,
  groupBySession,
  sessionLabel,
  PINNED_GROUP,
  UI_SESSION_ID,
} from '../../lib/client/memory-groups';
import type { MemoryRow } from '../../lib/client/api';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);

function row(over: Partial<MemoryRow> & { id: string }): MemoryRow {
  return {
    kind: 'outcome',
    text: `text ${over.id}`,
    provider: 'claude',
    sessionId: 'sess-a',
    ts: T0,
    repo: '/home/b/seshmux',
    projectId: 'proj-1',
    branch: null,
    files: [],
    commands: [],
    pinned: false,
    hits: 0,
    superseded: false,
    score: 1,
    tokens: 10,
    ...over,
  };
}

describe('groupBySession', () => {
  it('collects a session’s records into one group', () => {
    const groups = groupBySession([
      row({ id: '1', sessionId: 'a' }),
      row({ id: '2', sessionId: 'b' }),
      row({ id: '3', sessionId: 'a' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.sessionId === 'a')?.rows.map((r) => r.id)).toEqual(['1', '3']);
  });

  it('keeps the server’s ranking inside a group', () => {
    // The best record of a session must still lead that session; re-sorting here would
    // throw away the only relevance signal the list has.
    const groups = groupBySession([
      row({ id: 'best', score: 9 }),
      row({ id: 'mid', score: 5 }),
      row({ id: 'worst', score: 1 }),
    ]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(['best', 'mid', 'worst']);
  });

  it('orders groups newest-first while browsing', () => {
    // "What was I working on" is a question about time. The server ranks RECORDS by
    // standing value — a lesson outweighs a prompt — which is right for a list of records
    // and would otherwise open a list of SESSIONS on a three-day-old one.
    const groups = groupBySession([
      row({ id: '1', sessionId: 'recent', score: 2, ts: T0 }),
      row({ id: '2', sessionId: 'valuable', score: 8, ts: T0 - 5 * DAY }),
      row({ id: '3', sessionId: 'recent', score: 1, ts: T0 }),
    ]);
    expect(groups.map((g) => g.sessionId)).toEqual(['recent', 'valuable']);
  });

  it('orders groups by their best match while searching', () => {
    // Once there is something to rank against, the best match has to lead.
    const groups = groupBySession(
      [
        row({ id: '1', sessionId: 'recent', score: 2, ts: T0 }),
        row({ id: '2', sessionId: 'matching', score: 8, ts: T0 - 5 * DAY }),
      ],
      { searching: true },
    );
    expect(groups.map((g) => g.sessionId)).toEqual(['matching', 'recent']);
  });

  it('separates the same session id in two repos', () => {
    // 'all repos' puts two stores in one list, and a session id is unique only within the
    // store that issued it.
    const groups = groupBySession([
      row({ id: '1', sessionId: 'same', projectId: 'p1', repo: '/a' }),
      row({ id: '2', sessionId: 'same', projectId: 'p2', repo: '/b' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('lifts pinned records out of their sessions into one leading group', () => {
    // With an empty query the server ranks pinned records absolutely first. Leaving them
    // inside collapsed session groups would quietly undo that.
    const groups = groupBySession([
      row({ id: 'p1', sessionId: 'a', pinned: true, score: 0.1 }),
      row({ id: 'n1', sessionId: 'a', score: 5 }),
      row({ id: 'p2', sessionId: 'b', pinned: true, score: 0.1 }),
    ]);
    expect(groups[0].id).toBe(PINNED_GROUP);
    expect(groups[0].kind).toBe('pinned');
    expect(groups[0].rows.map((r) => r.id)).toEqual(['p1', 'p2']);
    // and not left behind in the session they came from
    expect(groups[1].rows.map((r) => r.id)).toEqual(['n1']);
  });

  it('marks hand-authored notes as their own kind of group', () => {
    const groups = groupBySession([row({ id: '1', sessionId: UI_SESSION_ID })]);
    expect(groups[0].kind).toBe('authored');
  });

  it('sums tokens and spans the time range of its records', () => {
    const groups = groupBySession([
      row({ id: '1', ts: T0, tokens: 10 }),
      row({ id: '2', ts: T0 - DAY, tokens: 30 }),
    ]);
    expect(groups[0].tokens).toBe(40);
    expect(groups[0].ts).toBe(T0);
    expect(groups[0].from).toBe(T0 - DAY);
  });

  it('returns nothing for no rows', () => {
    expect(groupBySession([])).toEqual([]);
  });
});

describe('sessionLabel', () => {
  it('names a session after its opening prompt', () => {
    expect(
      sessionLabel([
        row({ id: '1', kind: 'outcome', text: 'the port scrape works', ts: T0 }),
        row({ id: '2', kind: 'prompt', text: 'make the ports panel work on windows', ts: T0 - DAY }),
        row({ id: '3', kind: 'prompt', text: 'now fix the spinner', ts: T0 }),
      ]),
    ).toBe('make the ports panel work on windows');
  });

  it('falls back to the best-ranked record when prompts are filtered out', () => {
    expect(
      sessionLabel([
        row({ id: '1', kind: 'error', text: 'lsof returns nothing on win32', score: 9 }),
        row({ id: '2', kind: 'outcome', text: 'probed 3 ports', score: 1 }),
      ]),
    ).toBe('lsof returns nothing on win32');
  });

  it('flattens and clips a long multi-line prompt to one line', () => {
    const label = sessionLabel([row({ id: '1', kind: 'prompt', text: `a${'b'.repeat(200)}\nsecond line` })]);
    expect(label).not.toContain('\n');
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('defaultOpenGroups', () => {
  const groups = groupBySession([
    row({ id: '1', sessionId: 'a', score: 9 }),
    row({ id: '2', sessionId: 'b', score: 5 }),
    row({ id: '3', sessionId: 'c', score: 1 }),
  ]);

  it('opens only the leading group while browsing', () => {
    const open = defaultOpenGroups(groups, false);
    expect([...open]).toEqual([groups[0].id]);
  });

  it('opens every group while searching', () => {
    // A folded group would hide the match that was searched for.
    expect(defaultOpenGroups(groups, true).size).toBe(3);
  });
});

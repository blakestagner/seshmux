// Memory rows -> session groups, for the memory panel's list.
//
// A memory store is a stream of individual records, and a flat list of them reads as one:
// a decision from this afternoon sits next to an error from last week with nothing saying
// they came from different pieces of work. The unit a person actually reasons about is the
// SESSION — "what did that browser-panel run work out?" — so that is the unit the list is
// built from, with the record kinds staying what they have always been: a filter, not the
// organising axis.
//
// Pure, and separate from the components, for the same reason git-tree.ts is: the ordering
// and labelling rules below are the part worth testing, and they are testable only while
// nothing here needs a DOM.

import type { MemoryRow } from './api';
import type { ProviderId } from './types';

/** The origin the POST /api/memory route stamps on a hand-authored record. */
export const UI_SESSION_ID = 'seshmux-ui';

/** Leading space keeps it out of any `projectId sessionId` key's namespace. */
export const PINNED_GROUP = ' pinned';

export type MemoryGroupKind = 'pinned' | 'authored' | 'session';

export interface MemoryGroup {
  /** Stable across refetches — it is the open/closed key. */
  id: string;
  kind: MemoryGroupKind;
  sessionId: string;
  provider: ProviderId;
  projectId: string;
  repo: string;
  branch: string | null;
  /** What this session was about, in one line. */
  label: string;
  rows: MemoryRow[];
  /** Newest record in the group — what the group is dated and sorted by. */
  ts: number;
  /** Oldest record — the session's start, as memory saw it. */
  from: number;
  tokens: number;
  /** Best rank score in the group, so a query's ordering survives grouping. */
  score: number;
}

const LABEL_MAX = 80;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1)}…` : flat;
}

/**
 * A one-line name for a session, derived from its own records.
 *
 * Deliberately NOT the provider's SessionMeta.title, which would cost a fetch per project
 * and would be missing for exactly the sessions memory outlives — the ones whose transcript
 * has been pruned off disk. The earliest `prompt` record IS the opening ask, which is what
 * the providers title a session from anyway; the ranked-best record is the fallback for a
 * group whose prompts the kind filter has hidden.
 */
export function sessionLabel(rows: MemoryRow[]): string {
  const prompts = rows.filter((r) => r.kind === 'prompt');
  if (prompts.length) {
    const first = prompts.reduce((a, b) => (b.ts < a.ts ? b : a));
    return oneLine(first.text);
  }
  const best = rows.reduce((a, b) => (b.score > a.score ? b : a));
  return oneLine(best.text);
}

function newGroup(row: MemoryRow, kind: MemoryGroupKind, id: string): MemoryGroup {
  return {
    id,
    kind,
    sessionId: row.sessionId,
    provider: row.provider,
    projectId: row.projectId,
    repo: row.repo,
    branch: row.branch,
    label: '',
    rows: [],
    ts: row.ts,
    from: row.ts,
    tokens: 0,
    score: row.score,
  };
}

export interface GroupOpts {
  /**
   * A query is running, so groups are ordered by their best match. Browsing orders them
   * by recency instead.
   *
   * The server ranks RECORDS by standing value — a lesson outweighs a prompt, so an
   * empty-query list legitimately opens on a three-day-old lesson. That is right for a
   * list of records and wrong for a list of sessions: "what was I working on" is a
   * question about time, and every other session list in the app (the rail, the agents
   * view) answers it newest-first. Ranking still decides the order INSIDE each group, and
   * takes over between groups the moment there is something to rank against.
   */
  searching?: boolean;
}

/**
 * Group ranked rows by the session that produced them.
 *
 * Pinned records are lifted OUT of their sessions into one group at the top. Not a
 * cosmetic choice: with an empty query the server ranks pinned records absolutely first
 * ("always keep this to hand"), and leaving them scattered through collapsed session
 * groups would quietly undo the one guarantee pinning makes.
 *
 * Rows keep their incoming order inside a group, which is the server's ranking — so the
 * most relevant record of a session still leads that session.
 */
export function groupBySession(rows: MemoryRow[], opts: GroupOpts = {}): MemoryGroup[] {
  const byKey = new Map<string, MemoryGroup>();
  let pinned: MemoryGroup | null = null;

  for (const row of rows) {
    if (row.pinned) {
      if (!pinned) pinned = newGroup(row, 'pinned', PINNED_GROUP);
      pinned.rows.push(row);
      pinned.ts = Math.max(pinned.ts, row.ts);
      pinned.from = Math.min(pinned.from, row.ts);
      pinned.tokens += row.tokens;
      pinned.score = Math.max(pinned.score, row.score);
      continue;
    }
    // Scoped by project as well as session: 'all repos' can put two repos' sessions in one
    // list, and a session id is only unique within the store that issued it.
    const key = `${row.projectId} ${row.sessionId}`;
    let group = byKey.get(key);
    if (!group) {
      group = newGroup(row, row.sessionId === UI_SESSION_ID ? 'authored' : 'session', key);
      byKey.set(key, group);
    }
    group.rows.push(row);
    group.ts = Math.max(group.ts, row.ts);
    group.from = Math.min(group.from, row.ts);
    group.tokens += row.tokens;
    group.score = Math.max(group.score, row.score);
  }

  const groups = [...byKey.values()].sort((a, b) =>
    opts.searching ? b.score - a.score || b.ts - a.ts : b.ts - a.ts || b.score - a.score,
  );
  for (const g of groups) g.label = sessionLabel(g.rows);

  if (pinned) {
    pinned.label = 'Pinned';
    groups.unshift(pinned);
  }
  return groups;
}

/**
 * Which groups start open.
 *
 * Searching is hunting: every group opens, because a collapsed group hides the match that
 * was searched for. Browsing is scanning: only the leading group opens, which is the whole
 * point of grouping — the rest are one line each until asked for.
 */
export function defaultOpenGroups(groups: MemoryGroup[], searching: boolean): Set<string> {
  if (searching) return new Set(groups.map((g) => g.id));
  return new Set(groups.slice(0, 1).map((g) => g.id));
}

import { describe, it, expect } from 'vitest';
import { rollup } from '../../lib/client/status-rollup';
import type { Tab } from '../../lib/client/store';
import type { SessionMeta } from '../../lib/client/types';

const term = (over: Partial<Tab>): Tab => ({
  id: 'term-' + (over.ptyId ?? 'p'), kind: 'term', label: 'proj', ptyId: 'p', ...over,
});

describe('rollup buckets', () => {
  it('maps raw ni working/waiting/idle', () => {
    const r = rollup([
      term({ ptyId: 'a', ni: 'working' }),
      term({ ptyId: 'b', ni: 'waiting' }),
      term({ ptyId: 'c', ni: 'idle' }),
    ]);
    expect(r.counts).toEqual({ working: 1, waiting: 1, done: 0, idle: 1 });
  });

  it('unviewed + idle = done (attention beats quiet)', () => {
    const r = rollup([term({ ptyId: 'a', ni: 'idle', unviewed: true })]);
    expect(r.counts.done).toBe(1);
    expect(r.counts.idle).toBe(0);
  });

  it('unviewed + waiting stays WAITING (blocked-on-you outranks unseen-finish)', () => {
    const r = rollup([term({ ptyId: 'a', ni: 'waiting', unviewed: true })]);
    expect(r.counts.waiting).toBe(1);
    expect(r.counts.done).toBe(0);
  });

  it('tabs without ni fall back to legacy status mapping (live→working, waiting→waiting, done→idle)', () => {
    const r = rollup([
      term({ ptyId: 'a', status: 'live' }),
      term({ ptyId: 'b', status: 'waiting' }),
      term({ ptyId: 'c', status: 'done' }),
    ]);
    expect(r.counts).toEqual({ working: 1, waiting: 1, done: 0, idle: 1 });
  });

  it('non-term tabs and ptyId-less tabs are excluded', () => {
    const r = rollup([
      { id: 't1', kind: 'transcript', label: 'x', sessionId: 's' } as Tab,
      { id: 't2', kind: 'term', label: 'x' } as Tab, // no ptyId yet
    ]);
    expect(r.cards).toHaveLength(0);
  });

  it('joins title/startedAt/durationMs from session meta by sessionId; falls back to tab label', () => {
    const meta: SessionMeta = {
      id: 's1', provider: 'claude', projectId: 'p1', title: 'Check out a new branch',
      branch: 'main', mtime: 111, startedAt: 100, durationMs: 5000, live: true,
    };
    const r = rollup(
      [term({ ptyId: 'a', ni: 'idle', sessionId: 's1' }), term({ ptyId: 'b', ni: 'idle' })],
      new Map([['s1', meta]]),
    );
    const joined = r.cards.find((c) => c.tabId === 'term-a')!;
    expect(joined.title).toBe('Check out a new branch');
    expect(joined.startedAt).toBe(100);
    expect(joined.durationMs).toBe(5000);
    const fallback = r.cards.find((c) => c.tabId === 'term-b')!;
    expect(fallback.title).toBe('proj');
    expect(fallback.startedAt).toBeNull();
  });

  it('lastActivityTs prefers tab.lastStatusTs, falls back to session mtime, else null', () => {
    const meta = { id: 's1', provider: 'claude', projectId: 'p1', title: 't', branch: null, mtime: 42, startedAt: null, durationMs: null, live: true } as SessionMeta;
    const r = rollup(
      [
        term({ ptyId: 'a', ni: 'idle', lastStatusTs: 99, sessionId: 's1' }),
        term({ ptyId: 'b', ni: 'idle', sessionId: 's1' }),
        term({ ptyId: 'c', ni: 'idle' }),
      ],
      new Map([['s1', meta]]),
    );
    expect(r.cards.find((c) => c.tabId === 'term-a')!.lastActivityTs).toBe(99);
    expect(r.cards.find((c) => c.tabId === 'term-b')!.lastActivityTs).toBe(42);
    expect(r.cards.find((c) => c.tabId === 'term-c')!.lastActivityTs).toBeNull();
  });

  it('isWorkspace = branch starts with agent/', () => {
    const r = rollup([term({ ptyId: 'a', ni: 'idle', branch: 'agent/quiet-otter-1' })]);
    expect(r.cards[0].isWorkspace).toBe(true);
  });

  it('counts always equal cards-per-bucket', () => {
    const r = rollup([
      term({ ptyId: 'a', ni: 'working' }),
      term({ ptyId: 'b', ni: 'idle', unviewed: true }),
    ]);
    for (const b of ['working', 'waiting', 'done', 'idle'] as const) {
      expect(r.counts[b]).toBe(r.cards.filter((c) => c.bucket === b).length);
    }
  });
});

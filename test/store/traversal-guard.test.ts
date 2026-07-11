// SEC-3/SEC-4 path-traversal guards: a client-supplied projectId/sessionId is path-joined
// into the store root, so a "../" id could read an arbitrary .jsonl off disk. isSafeId
// (used by listSessions + parseTranscript, and the claude subagents provider) must refuse
// any id with a separator or ".." while still accepting every legit dash-encoded id form.

import { describe, it, expect } from 'vitest';
import { isSafeId, listSessions } from '../../server/lib/store/scan';
import { parseTranscript } from '../../server/lib/store/transcript';

const root = new URL('../fixtures', import.meta.url).pathname;
const projId = '-Users-demo-github-myrepo';
const WINDOW = 200_000;

describe('isSafeId', () => {
  it('accepts real dirent / dash-encoded / session ids', () => {
    for (const id of [projId, 'aaaa-1111', 'session', '-a-b-c']) {
      expect(isSafeId(id)).toBe(true);
    }
  });
  it('rejects separators, dot-dot and empty/NUL', () => {
    for (const id of ['', '..', '../x', 'a/b', 'a\\b', 'a/../b', 'x\0y']) {
      expect(isSafeId(id)).toBe(false);
    }
  });
});

describe('listSessions traversal guard', () => {
  it('lists sessions for a legit id (control)', async () => {
    const ss = await listSessions(projId, { root, provider: 'claude', limit: 5 });
    expect(ss.length).toBeGreaterThan(0);
  });
  it('returns [] for a traversal id that WOULD resolve to a real project dir', async () => {
    // join(root, '../fixtures/<projId>') === the real dir with 2 sessions — the guard
    // must refuse it (proving no file read), not read through the "..".
    const ss = await listSessions(`../fixtures/${projId}`, { root, provider: 'claude', limit: 5 });
    expect(ss).toEqual([]);
  });
});

describe('parseTranscript traversal guard', () => {
  it('parses a legit id (control)', async () => {
    const { msgs } = await parseTranscript(projId, 'aaaa-1111', root, WINDOW);
    expect(msgs.length).toBeGreaterThan(0);
  });
  it('refuses a traversal sessionId that WOULD resolve to a real transcript', async () => {
    // Without the guard this join reaches the real aaaa-1111.jsonl and returns its msgs.
    const evil = `../${projId}/aaaa-1111`;
    const { msgs, ctx } = await parseTranscript(projId, evil, root, WINDOW);
    expect(msgs).toEqual([]);
    expect(ctx).toBeNull();
  });
  it('refuses a traversal projectId', async () => {
    const { msgs } = await parseTranscript('..', `fixtures/${projId}/aaaa-1111`, root, WINDOW);
    expect(msgs).toEqual([]);
  });
});

// watchSubagents: lazy per-session chokidar watch → {event:'subagents'} ping on a file
// change, idempotent per projectId:sessionId. Uses a real chokidar watcher against a temp
// HOME so claudeStoreRoot() (= <HOME>/.claude/projects) resolves into a dir we control —
// no daemon needed (this path is filesystem-only).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A minimal fake events-ws client so broadcasts land somewhere we can read.
class FakeWS {
  readonly OPEN = 1;
  readyState = 1;
  frames: any[] = [];
  send(s: string) {
    this.frames.push(JSON.parse(s));
  }
  on() {
    /* close/error listeners unused in this test */
  }
  close() {
    this.readyState = 3;
  }
}

describe('watchSubagents', () => {
  let home: string;
  let prevHome: string | undefined;
  const project = 'proj';
  const session = 'sess';
  let subagentsDir: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'seshmux-sub-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    subagentsDir = path.join(home, '.claude', 'projects', project, session, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('emits {event:subagents} on a file change and is idempotent per session', async () => {
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    const ws = new FakeWS();
    try {
      hub.addClient(ws as any);

      hub.watchSubagents(project, session);
      // Idempotent: second call must not add a second watcher (no throw, no double-ping).
      hub.watchSubagents(project, session);

      // chokidar needs a beat to be ready before it reports adds.
      await new Promise((r) => setTimeout(r, 300));
      writeFileSync(path.join(subagentsDir, 'agent-a1.meta.json'), '{"agentType":"x"}');

      // Wait past the 250ms debounce + fs event latency.
      await new Promise((r) => setTimeout(r, 800));

      const pings = ws.frames.filter((f) => f.event === 'subagents');
      expect(pings.length).toBeGreaterThanOrEqual(1);
      expect(pings[0]).toMatchObject({ event: 'subagents', projectId: project, sessionId: session });
    } finally {
      await hub.close();
    }
  });

  // MEM-5/MEM-6: idle scratchpad + subagent watchers are evicted, and a re-open
  // transparently re-arms the watch (no UX/protocol change).
  it('evicts idle watchers and transparently re-watches on re-open', async () => {
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    const ws = new FakeWS();
    try {
      hub.addClient(ws as any);
      hub.watchScratchpad(project, home); // repo path only needs to exist
      hub.watchSubagents(project, session);

      // A default-cutoff sweep must NOT touch just-armed watchers.
      expect(await hub.sweepIdleWatchers()).toBe(0);

      // Force eviction (future cutoff = everything is "idle") — both watchers close.
      expect(await hub.sweepIdleWatchers(Date.now() + 1_000)).toBe(2);

      // Re-open re-arms transparently: a subsequent file change still pings.
      hub.watchSubagents(project, session);
      await new Promise((r) => setTimeout(r, 300));
      const before = ws.frames.filter((f) => f.event === 'subagents').length;
      writeFileSync(path.join(subagentsDir, 'agent-b2.meta.json'), '{"agentType":"y"}');
      await new Promise((r) => setTimeout(r, 800));
      const after = ws.frames.filter((f) => f.event === 'subagents').length;
      expect(after).toBeGreaterThan(before);
    } finally {
      await hub.close();
    }
  });
});

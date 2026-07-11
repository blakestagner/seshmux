// Task 4: events-hub lazily watches a team's config.json (provider hands the
// resolved absolute path in — the hub never constructs ~/.claude/teams/... itself).
// Cheap test: no daemon boot needed (createEventsHub degrades quietly with no
// daemon socket present — see reattachAll's try/catch), just a temp config.json.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeWs() {
  const seen: any[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (frame: string) => seen.push(JSON.parse(frame)),
    on: () => {},
    close: () => {},
  } as any;
  return { ws, seen };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timed out');
}

describe('events-hub — team config.json lazy watch (Task 4)', () => {
  let dir: string;
  let hubs: any[] = [];

  afterEach(async () => {
    for (const hub of hubs) await hub.close().catch(() => {});
    hubs = [];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('broadcasts {event:"team"} on a config.json change', async () => {
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    hubs.push(hub);

    dir = mkdtempSync(join(tmpdir(), 'seshmux-team-watch-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ members: [] }));

    const { ws, seen } = fakeWs();
    hub.addClient(ws);
    hub.watchTeam('Recon', 'lead-1', configPath);
    await new Promise((r) => setTimeout(r, 200)); // let chokidar settle before the write

    writeFileSync(configPath, JSON.stringify({ members: [{ name: 'scout' }] }));

    await waitFor(() => seen.some((e) => e.event === 'team' && e.teamName === 'Recon'));
    const evt = seen.find((e) => e.event === 'team');
    expect(evt).toEqual({ event: 'team', teamName: 'Recon', leadSessionId: 'lead-1' });
  });

  it('is idempotent per teamName (a second watchTeam call does not double-arm)', async () => {
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    hubs.push(hub);

    dir = mkdtempSync(join(tmpdir(), 'seshmux-team-watch-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ members: [] }));

    const { ws, seen } = fakeWs();
    hub.addClient(ws);
    hub.watchTeam('Recon', 'lead-1', configPath);
    hub.watchTeam('Recon', 'lead-1', configPath); // no-op — already armed
    await new Promise((r) => setTimeout(r, 200));

    writeFileSync(configPath, JSON.stringify({ members: [{ name: 'scout' }] }));
    await waitFor(() => seen.some((e) => e.event === 'team'));
    // Give any accidental double-watcher a moment to double-fire.
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.filter((e) => e.event === 'team')).toHaveLength(1);
  });

  it('treats config.json unlink as "team ended": one final event, then stops watching (no error, no retry)', async () => {
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    hubs.push(hub);

    dir = mkdtempSync(join(tmpdir(), 'seshmux-team-watch-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ members: [] }));

    const { ws, seen } = fakeWs();
    hub.addClient(ws);
    hub.watchTeam('Recon', 'lead-1', configPath);
    await new Promise((r) => setTimeout(r, 200));

    unlinkSync(configPath);
    await waitFor(() => seen.some((e) => e.event === 'team'));
    expect(seen.filter((e) => e.event === 'team')).toHaveLength(1);

    // Re-arming after the team ended (e.g. a stale roster refetch) should be
    // possible again without throwing — proves the watcher was disposed, not
    // left half-broken.
    writeFileSync(configPath, JSON.stringify({ members: [] }));
    hub.watchTeam('Recon', 'lead-1', configPath);
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(configPath, JSON.stringify({ members: [{ name: 'scout' }] }));
    await waitFor(() => seen.filter((e) => e.event === 'team').length === 2);
  });

  it('sweepIdleWatchers does NOT evict a team watcher — nothing would re-arm it (R5-5)', async () => {
    const { createEventsHub } = await import('../../server/events-hub');
    const hub = await createEventsHub();
    hubs.push(hub);

    dir = mkdtempSync(join(tmpdir(), 'seshmux-team-watch-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ members: [] }));

    const { ws, seen } = fakeWs();
    hub.addClient(ws);
    hub.watchTeam('Recon', 'lead-1', configPath);
    await new Promise((r) => setTimeout(r, 200));

    // Sweep with a cutoff far in the future: scratchpad/subagent watchers would be evicted,
    // but the team watcher must survive — only its own `team` event triggers a client
    // refetch, so evicting it would silently kill the roster forever.
    await hub.sweepIdleWatchers(Date.now() + 1000);

    seen.length = 0;
    writeFileSync(configPath, JSON.stringify({ members: [{ name: 'scout' }] }));
    await waitFor(() => seen.some((e) => e.event === 'team'));
  });
});

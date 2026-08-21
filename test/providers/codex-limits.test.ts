import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexRateLimits, resetCodexLimitCache } from '../../server/lib/providers/codex-limits';

// Fixtures mirror REAL rollout lines captured from ~/.codex/sessions (hard rule 6). Both
// slot layouts observed in the wild are represented: older CLIs put the 5h window in
// `primary` with weekly in `secondary`; newer ones put weekly in `primary` and null out
// `secondary`. Classification must key off window_minutes, never the slot name.
const NOW = Date.parse('2026-08-21T12:00:00Z');
const soon = (h: number) => Math.floor((NOW + h * 3600_000) / 1000); // resets_at is unix SECONDS

function tokenCount(rate_limits: unknown, timestamp = '2026-08-21T11:55:00.000Z') {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'token_count', info: { model_context_window: 258_400 }, rate_limits },
  });
}

const homes: string[] = [];
async function store(lines: string[], day = '2026/08/21'): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'shmx-cdx-'));
  homes.push(home);
  const dir = join(home, '.codex', 'sessions', ...day.split('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rollout-${day.replace(/\//g, '-')}T10-00-00-abc.jsonl`), lines.join('\n'));
  return home;
}

beforeEach(() => resetCodexLimitCache());
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

describe('readCodexRateLimits', () => {
  it('reads the old layout: primary=5h, secondary=weekly', async () => {
    const homeDir = await store([
      tokenCount({
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: soon(2) },
        secondary: { used_percent: 40, window_minutes: 10_080, resets_at: soon(50) },
        credits: { has_credits: false, unlimited: false, balance: '0' },
      }),
    ]);
    const r = await readCodexRateLimits({ homeDir, now: NOW });
    expect(r?.meters).toEqual([
      { windowMinutes: 300, pct: 12.5, resetsAt: new Date(soon(2) * 1000).toISOString() },
      { windowMinutes: 10_080, pct: 40, resetsAt: new Date(soon(50) * 1000).toISOString() },
    ]);
    expect(r?.capturedAt).toBe('2026-08-21T11:55:00.000Z');
  });

  it('reads the new layout: primary=weekly, secondary=null (slot name must not decide)', async () => {
    const homeDir = await store([
      tokenCount({
        limit_id: 'codex',
        limit_name: null,
        primary: { used_percent: 8, window_minutes: 10_080, resets_at: soon(100) },
        secondary: null,
        plan_type: 'plus',
      }),
    ]);
    const r = await readCodexRateLimits({ homeDir, now: NOW });
    // One meter, and it is the WEEKLY one — not mislabelled as the session window.
    expect(r?.meters).toEqual([
      { windowMinutes: 10_080, pct: 8, resetsAt: new Date(soon(100) * 1000).toISOString() },
    ]);
  });

  it('drops a window that has already reset instead of reporting a dead number', async () => {
    const homeDir = await store([
      tokenCount({
        primary: { used_percent: 90, window_minutes: 300, resets_at: soon(-6) }, // expired
        secondary: { used_percent: 33, window_minutes: 10_080, resets_at: soon(30) },
      }),
    ]);
    const r = await readCodexRateLimits({ homeDir, now: NOW });
    expect(r?.meters).toEqual([
      { windowMinutes: 10_080, pct: 33, resetsAt: new Date(soon(30) * 1000).toISOString() },
    ]);
  });

  it('returns null when every window has expired', async () => {
    const homeDir = await store([
      tokenCount({
        primary: { used_percent: 90, window_minutes: 300, resets_at: soon(-200) },
        secondary: { used_percent: 33, window_minutes: 10_080, resets_at: soon(-100) },
      }),
    ]);
    expect(await readCodexRateLimits({ homeDir, now: NOW })).toBeNull();
  });

  it('takes the LAST rate_limits event in the file, not the first', async () => {
    const homeDir = await store([
      tokenCount({ primary: { used_percent: 5, window_minutes: 300, resets_at: soon(2) } }, '2026-08-21T10:00:00.000Z'),
      tokenCount({ primary: { used_percent: 61, window_minutes: 300, resets_at: soon(2) } }, '2026-08-21T11:59:00.000Z'),
    ]);
    const r = await readCodexRateLimits({ homeDir, now: NOW });
    expect(r?.meters[0].pct).toBe(61);
    expect(r?.capturedAt).toBe('2026-08-21T11:59:00.000Z');
  });

  it('skips torn JSON and events that carry no rate_limits', async () => {
    const homeDir = await store([
      tokenCount({ primary: { used_percent: 7, window_minutes: 300, resets_at: soon(2) } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
      '{"type":"event_msg","payload":{"rate_limits":{"primary":{"used_perc', // truncated line
    ]);
    const r = await readCodexRateLimits({ homeDir, now: NOW });
    expect(r?.meters[0].pct).toBe(7);
  });

  it('clamps a percentage and tolerates a missing resets_at', async () => {
    const homeDir = await store([
      tokenCount({ primary: { used_percent: 250, window_minutes: 300 } }),
    ]);
    const r = await readCodexRateLimits({ homeDir, now: NOW });
    expect(r?.meters).toEqual([{ windowMinutes: 300, pct: 100, resetsAt: null }]);
  });

  it('returns null with no codex store at all', async () => {
    const home = await mkdtemp(join(tmpdir(), 'shmx-cdx-'));
    homes.push(home);
    expect(await readCodexRateLimits({ homeDir: home, now: NOW })).toBeNull();
  });

  it('prefers the newest day directory over older ones', async () => {
    const homeDir = await store(
      [tokenCount({ primary: { used_percent: 99, window_minutes: 300, resets_at: soon(2) } })],
      '2026/07/02',
    );
    // Same home, a later day — must win despite the older dir being created first.
    const dir = join(homeDir, '.codex', 'sessions', '2026', '08', '20');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'rollout-2026-08-20T09-00-00-def.jsonl'),
      tokenCount({ primary: { used_percent: 21, window_minutes: 300, resets_at: soon(2) } }),
    );
    const r = await readCodexRateLimits({ homeDir, now: NOW });
    expect(r?.meters[0].pct).toBe(21);
  });

  it('falls back to an older rollout when the newest one has only dead windows', async () => {
    // Newest file: everything expired. Older file: weekly still open. The older number is
    // the only true one available, so it should surface rather than nothing.
    const homeDir = await store(
      [
        tokenCount({
          primary: { used_percent: 44, window_minutes: 10_080, resets_at: soon(60) },
        }),
      ],
      '2026/08/19',
    );
    const dir = join(homeDir, '.codex', 'sessions', '2026', '08', '21');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'rollout-2026-08-21T09-00-00-zzz.jsonl'),
      tokenCount({ primary: { used_percent: 90, window_minutes: 300, resets_at: soon(-3) } }),
    );
    const r = await readCodexRateLimits({ homeDir, now: NOW });
    expect(r?.meters).toEqual([
      { windowMinutes: 10_080, pct: 44, resetsAt: new Date(soon(60) * 1000).toISOString() },
    ]);
  });

  it('memoises inside the TTL so every polling tab does not re-walk the store', async () => {
    const homeDir = await store([
      tokenCount({ primary: { used_percent: 11, window_minutes: 300, resets_at: soon(2) } }),
    ]);
    expect((await readCodexRateLimits({ homeDir, now: NOW }))?.meters[0].pct).toBe(11);

    // Rewrite the store, then read again inside the TTL — the stale memo must win, which
    // is only observable because the file changed underneath it.
    await writeFile(
      join(homeDir, '.codex', 'sessions', '2026', '08', '21', 'rollout-2026-08-21T10-00-00-abc.jsonl'),
      tokenCount({ primary: { used_percent: 77, window_minutes: 300, resets_at: soon(2) } }),
    );
    expect((await readCodexRateLimits({ homeDir, now: NOW + 30_000 }))?.meters[0].pct).toBe(11);
    expect((await readCodexRateLimits({ homeDir, now: NOW + 61_000 }))?.meters[0].pct).toBe(77);
  });
});

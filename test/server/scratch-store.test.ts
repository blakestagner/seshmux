// scratch-store: the scratch-terminal association map over json-store. Each case
// runs against a fresh tmp SESHMUX_CONFIG_DIR with the memoized store reset, so
// the on-disk write/serialization mechanics are exercised for real.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevConfigDir: string | undefined;

async function fresh() {
  const mod = await import('../../server/lib/scratch-store');
  mod._resetScratchStoreForTest();
  return mod;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'smx-scratch-'));
  prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
  process.env.SESHMUX_CONFIG_DIR = dir;
  (await import('../../server/lib/scratch-store'))._resetScratchStoreForTest();
});

afterEach(async () => {
  (await import('../../server/lib/scratch-store'))._resetScratchStoreForTest();
  if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
  else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

const rec = (ownerPtyId: string, extra: Partial<{ ownerTmuxName: string | null; cwd: string }> = {}) => ({
  ownerPtyId,
  ownerTmuxName: extra.ownerTmuxName ?? null,
  cwd: extra.cwd ?? '/repo/a',
  createdAt: 1,
});

describe('scratch-store', () => {
  it('read on a missing file returns an empty map', async () => {
    const s = await fresh();
    expect(await s.readScratchMap()).toEqual({});
    expect(await s.scratchPtyIds()).toEqual(new Set());
  });

  it('add / read / remove round-trips', async () => {
    const s = await fresh();
    await s.addScratch('scratch-1', rec('owner-1'));
    expect(await s.readScratchMap()).toEqual({ 'scratch-1': rec('owner-1') });
    expect(await s.scratchPtyIds()).toEqual(new Set(['scratch-1']));

    await s.removeScratch('scratch-1');
    expect(await s.readScratchMap()).toEqual({});
    expect(await s.scratchPtyIds()).toEqual(new Set());
  });

  it('removeScratch on an unknown id is a no-op (does not throw)', async () => {
    const s = await fresh();
    await s.addScratch('scratch-1', rec('owner-1'));
    await s.removeScratch('nope');
    expect(await s.scratchPtyIds()).toEqual(new Set(['scratch-1']));
  });

  it('findByOwner matches by ownerPtyId', async () => {
    const s = await fresh();
    await s.addScratch('scratch-1', rec('owner-1'));
    expect(await s.findByOwner('owner-1', null)).toBe('scratch-1');
    expect(await s.findByOwner('owner-2', null)).toBeNull();
  });

  it('findByOwner matches by tmuxName when the ptyId changed (daemon restart)', async () => {
    const s = await fresh();
    await s.addScratch('scratch-1', rec('old-owner', { ownerTmuxName: 'seshmux-repo-1' }));
    // Owner came back under a new ptyId; the tmux name still matches.
    expect(await s.findByOwner('new-owner', 'seshmux-repo-1')).toBe('scratch-1');
    // A null tmux name must NOT match the recorded null-vs-null by accident.
    expect(await s.findByOwner('new-owner', null)).toBeNull();
  });

  it('updateScratch patches an existing record in place; no-op if absent', async () => {
    const s = await fresh();
    await s.addScratch('scratch-1', rec('old-owner', { ownerTmuxName: 'seshmux-repo-1' }));
    await s.updateScratch('scratch-1', { ownerPtyId: 'new-owner' });
    expect((await s.readScratchMap())['scratch-1'].ownerPtyId).toBe('new-owner');
    await s.updateScratch('ghost', { ownerPtyId: 'x' }); // absent — no throw, no create
    expect(Object.keys(await s.readScratchMap())).toEqual(['scratch-1']);
  });

  it('a corrupt file reads as an empty map (parse-tolerant via json-store)', async () => {
    writeFileSync(join(dir, 'scratch-terminals.json'), '{not valid json');
    const s = await fresh();
    expect(await s.readScratchMap()).toEqual({});
    // ...and a subsequent write self-heals the file.
    await s.addScratch('scratch-1', rec('owner-1'));
    expect(await s.scratchPtyIds()).toEqual(new Set(['scratch-1']));
  });

  it('concurrent interleaved add/remove lose nothing (serialized queue)', async () => {
    const s = await fresh();
    const ops: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) ops.push(s.addScratch(`scratch-${i}`, rec(`owner-${i}`)));
    // Remove the even ids concurrently with the adds still in flight.
    for (let i = 0; i < 25; i += 2) ops.push(s.removeScratch(`scratch-${i}`));
    await Promise.all(ops);
    const ids = await s.scratchPtyIds();
    // Serialized queue → every add lands before every remove, and no write is
    // lost: all odd ids survive, all even ids were removed.
    for (let i = 1; i < 25; i += 2) expect(ids.has(`scratch-${i}`)).toBe(true);
    for (let i = 0; i < 25; i += 2) expect(ids.has(`scratch-${i}`)).toBe(false);
  });
});

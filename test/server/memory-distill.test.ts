// memory/distill: the opt-in LLM pass that turns deterministic records into decisions and
// lessons. The agent call is always injected — no test ever spawns one. What is actually
// under test is the parsing (models do not reliably return clean JSON) and the supersession
// planning, which is where conflict resolution lives.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProvider } from '../../server/lib/providers/types';
import {
  buildPrompt,
  chunkRecords,
  distillSession,
  mergeFacts,
  parseDistilled,
  planDistillWrite,
  type DistilledFact,
} from '../../server/lib/memory/distill';
import { MEMORY_SCHEMA, type MemoryKind, type MemoryRecord } from '../../server/lib/memory/types';

let dir: string;
let prevConfigDir: string | undefined;

async function fresh() {
  const s = await import('../../server/lib/memory/store');
  s._resetMemoryForTest();
  return s;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'smx-dist-'));
  prevConfigDir = process.env.SESHMUX_CONFIG_DIR;
  process.env.SESHMUX_CONFIG_DIR = dir;
  await fresh();
});

afterEach(async () => {
  await fresh();
  if (prevConfigDir === undefined) delete process.env.SESHMUX_CONFIG_DIR;
  else process.env.SESHMUX_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 8, 9);

let seq = 0;
function rec(text: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  seq++;
  return {
    v: MEMORY_SCHEMA,
    id: over.id ?? `r${seq}`,
    kind: (over.kind ?? 'tool-call') as MemoryKind,
    text,
    scope: over.scope ?? { projectId: 'p1', repo: '/repo/alpha', branch: 'main' },
    origin: over.origin ?? { provider: 'claude', sessionId: 's1', ts: NOW },
    entities: over.entities ?? { files: [], commands: [], symbols: [] },
    validFrom: over.validFrom ?? NOW,
    hits: 0,
    lastHit: 0,
    ...over,
  } as MemoryRecord;
}

const fakeProvider = { id: 'claude', commands: {} } as unknown as AgentProvider;

const targetOf = () => ({
  provider: fakeProvider,
  sessionId: 's1',
  projectId: 'p1',
  repo: '/repo/alpha',
  branch: 'main',
});

const FACTS_JSON = JSON.stringify([
  { kind: 'lesson', key: 'windows-build-needs-stop', text: 'Stop seshmux before npm run build; Windows locks .next/standalone.', files: ['scripts/build-standalone.sh'] },
  { kind: 'decision', key: 'ndjson-over-sqlite', text: 'Chose append-only NDJSON over sqlite because the bridge is a second process.' },
]);

// ---------------------------------------------------------------------------

describe('chunkRecords', () => {
  it('keeps everything in one chunk when it fits', () => {
    expect(chunkRecords([rec('a'), rec('b')], 1000)).toHaveLength(1);
  });

  it('splits once the budget is exceeded, preserving order', () => {
    const records = Array.from({ length: 10 }, (_, i) => rec(`record ${i} ${'x'.repeat(80)}`));
    const chunks = chunkRecords(records, 300);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().map((r) => r.id)).toEqual(records.map((r) => r.id));
  });

  it('never emits an empty chunk, even for one oversized record', () => {
    const chunks = chunkRecords([rec('x'.repeat(9999))], 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
  });

  it('is empty for no records', () => {
    expect(chunkRecords([], 100)).toEqual([]);
  });
});

describe('buildPrompt', () => {
  const prompt = buildPrompt([rec('ran `npm run build`'), rec('edited a.ts', { kind: 'artifact' })], 'seshmux');

  it('names the repo and includes the activity', () => {
    expect(prompt).toContain('seshmux');
    expect(prompt).toContain('ran `npm run build`');
    expect(prompt).toContain('[artifact] edited a.ts');
  });

  it('tells the model an empty answer is acceptable', () => {
    // Without this, models invent lessons to fill the list.
    expect(prompt).toContain('It is correct to return an empty list.');
  });

  it('asks for a bare JSON array', () => {
    expect(prompt).toContain('ONLY a JSON array');
  });
});

describe('parseDistilled', () => {
  it('parses a clean array', () => {
    const facts = parseDistilled(FACTS_JSON);
    expect(facts.map((f) => f.key)).toEqual(['windows-build-needs-stop', 'ndjson-over-sqlite']);
    expect(facts[0].files).toEqual(['scripts/build-standalone.sh']);
  });

  it('digs the array out of a code fence', () => {
    expect(parseDistilled('Sure!\n```json\n' + FACTS_JSON + '\n```\nHope that helps.')).toHaveLength(2);
  });

  it('digs the array out of surrounding prose', () => {
    expect(parseDistilled('Here you go: ' + FACTS_JSON + ' — let me know.')).toHaveLength(2);
  });

  it('returns nothing rather than throwing on malformed JSON', () => {
    expect(parseDistilled('[{"kind":"lesson",')).toEqual([]);
    expect(parseDistilled('no json at all')).toEqual([]);
    expect(parseDistilled('')).toEqual([]);
  });

  it('drops entries with an unknown kind or a stub text', () => {
    const raw = JSON.stringify([
      { kind: 'observation', key: 'a', text: 'a valid looking sentence' },
      { kind: 'lesson', key: 'b', text: 'tiny' },
      { kind: 'lesson', key: 'c', text: 'a genuinely useful sentence' },
    ]);
    expect(parseDistilled(raw).map((f) => f.key)).toEqual(['c']);
  });

  it('slugifies a key the model wrote loosely', () => {
    const raw = JSON.stringify([{ kind: 'lesson', key: 'Windows Build: Needs Stop!', text: 'something durable here' }]);
    expect(parseDistilled(raw)[0].key).toBe('windows-build-needs-stop');
  });

  it('falls back to the text when no key was given', () => {
    const raw = JSON.stringify([{ kind: 'lesson', text: 'Stop the app first' }]);
    expect(parseDistilled(raw)[0].key).toBe('stop-the-app-first');
  });

  it('caps how many facts one chunk may contribute', () => {
    const raw = JSON.stringify(
      Array.from({ length: 50 }, (_, i) => ({ kind: 'lesson', key: `k${i}`, text: `durable fact number ${i}` })),
    );
    expect(parseDistilled(raw).length).toBeLessThanOrEqual(6);
  });
});

describe('mergeFacts', () => {
  it('lets a later batch revise an earlier one for the same key', () => {
    const a: DistilledFact[] = [{ kind: 'lesson', key: 'k', text: 'first' }];
    const b: DistilledFact[] = [{ kind: 'lesson', key: 'k', text: 'second' }];
    expect(mergeFacts([a, b])).toEqual([{ kind: 'lesson', key: 'k', text: 'second' }]);
  });
});

describe('planDistillWrite — conflict resolution', () => {
  const ctx = { provider: 'claude' as const, sessionId: 's2', projectId: 'p1', repo: '/repo/alpha', branch: 'main', now: NOW };

  it('writes a brand-new fact with no supersession', () => {
    const out = planDistillWrite([{ kind: 'lesson', key: 'k', text: 'a durable fact' }], [], ctx);
    expect(out.records).toHaveLength(1);
    expect(out.records[0].key).toBe('k');
    expect(out.overlay).toEqual([]);
  });

  it('supersedes rather than deletes when a fact is revised', () => {
    // The old belief stays on disk and stays answerable through asOf; it is just no longer
    // current. This is the whole point of the validity-window design.
    const old = rec('the build takes three minutes', { id: 'old', kind: 'lesson', key: 'build-time' });
    const out = planDistillWrite([{ kind: 'lesson', key: 'build-time', text: 'the build takes forty seconds' }], [old], ctx);
    expect(out.records).toHaveLength(1);
    expect(out.overlay).toEqual([{ op: 'supersede', id: 'old', at: NOW, by: out.records[0].id }]);
  });

  it('is a no-op when the same fact is distilled again', () => {
    const existing = rec('a durable fact', { id: 'x', kind: 'lesson', key: 'k' });
    const out = planDistillWrite([{ kind: 'lesson', key: 'k', text: 'a durable fact' }], [existing], ctx);
    expect(out.records).toEqual([]);
    expect(out.overlay).toEqual([]);
  });

  it('does not supersede the same key in a different project', () => {
    const elsewhere = rec('other repo belief', {
      id: 'other',
      kind: 'lesson',
      key: 'k',
      scope: { projectId: 'p2', repo: '/repo/beta', branch: null },
    });
    const out = planDistillWrite([{ kind: 'lesson', key: 'k', text: 'this repo belief' }], [elsewhere], ctx);
    expect(out.overlay).toEqual([]);
  });

  it('does not re-supersede a record already superseded', () => {
    const stale = rec('older', { id: 'stale', kind: 'lesson', key: 'k', supersededBy: 'newer' });
    const out = planDistillWrite([{ kind: 'lesson', key: 'k', text: 'newest belief here' }], [stale], ctx);
    expect(out.overlay).toEqual([]);
  });

  it('normalizes windows separators in fact files', () => {
    const out = planDistillWrite(
      [{ kind: 'decision', key: 'k', text: 'a durable choice', files: ['server\\lib\\x.ts'] }],
      [],
      ctx,
    );
    expect(out.records[0].entities.files).toEqual(['server/lib/x.ts']);
  });
});

describe('distillSession', () => {
  it('writes decisions and lessons from the agent reply', async () => {
    const s = await fresh();
    await s.appendRecords([rec('ran `npm run build`'), rec('edited scripts/build-standalone.sh', { kind: 'artifact' })]);

    const res = await distillSession(targetOf(), { ask: async () => ({ text: FACTS_JSON, ok: true }), now: () => NOW });
    expect(res.facts).toBe(2);

    const stored = await s.readAllRecords();
    const distilled = stored.filter((r) => r.kind === 'lesson' || r.kind === 'decision');
    expect(distilled.map((r) => r.key).sort()).toEqual(['ndjson-over-sqlite', 'windows-build-needs-stop']);
  });

  it('does nothing when the session has no harvested records', async () => {
    await fresh();
    let called = false;
    const res = await distillSession(targetOf(), {
      ask: async () => {
        called = true;
        return { text: FACTS_JSON, ok: true };
      },
    });
    expect(res).toEqual({ facts: 0, superseded: 0, chunks: 0 });
    expect(called).toBe(false); // never spend a call on an empty session
  });

  it('leaves the deterministic records untouched when the agent call fails', async () => {
    // Distillation is strictly additive: a rate limit must cost nothing but the attempt.
    const s = await fresh();
    await s.appendRecords([rec('ran `npm run build`')]);
    const before = await s.readAllRecords();

    const res = await distillSession(targetOf(), { ask: async () => ({ text: '', ok: false }) });
    expect(res.facts).toBe(0);
    s._resetMemoryForTest();
    expect(await s.readAllRecords()).toHaveLength(before.length);
  });

  it('survives an agent call that throws', async () => {
    const s = await fresh();
    await s.appendRecords([rec('ran `npm run build`')]);
    const res = await distillSession(targetOf(), {
      ask: async () => {
        throw new Error('spawn ENOENT');
      },
      log: () => {},
    });
    expect(res.error).toBe('agent call failed');
    expect(res.facts).toBe(0);
  });

  it('ignores a reply that is not JSON', async () => {
    const s = await fresh();
    await s.appendRecords([rec('ran `npm run build`')]);
    const res = await distillSession(targetOf(), { ask: async () => ({ text: 'I could not find anything.', ok: true }) });
    expect(res.facts).toBe(0);
  });

  it('never re-distils its own output', async () => {
    // Otherwise each run would feed the previous run's lessons back in and compound.
    const s = await fresh();
    await s.appendRecords([rec('ran `npm run build`')]);
    const prompts: string[] = [];
    const ask = async (_p: unknown, _cwd: string, prompt: string) => {
      prompts.push(prompt);
      return { text: FACTS_JSON, ok: true };
    };
    await distillSession(targetOf(), { ask, now: () => NOW });
    s._resetMemoryForTest();
    await distillSession(targetOf(), { ask, now: () => NOW });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain('ndjson-over-sqlite');
  });

  it('supersedes a prior belief on re-distillation rather than duplicating it', async () => {
    const s = await fresh();
    await s.appendRecords([rec('ran `npm run build`')]);
    await distillSession(targetOf(), {
      ask: async () => ({ text: JSON.stringify([{ kind: 'lesson', key: 'build-time', text: 'the build takes three minutes' }]), ok: true }),
      now: () => NOW,
    });
    s._resetMemoryForTest();
    await distillSession(targetOf(), {
      ask: async () => ({ text: JSON.stringify([{ kind: 'lesson', key: 'build-time', text: 'the build takes forty seconds' }]), ok: true }),
      now: () => NOW + 1000,
    });

    s._resetMemoryForTest();
    const lessons = (await s.readAllRecords()).filter((r) => r.kind === 'lesson');
    expect(lessons).toHaveLength(2); // both kept
    expect(lessons.filter((r) => !r.supersededBy)).toHaveLength(1); // one current
    expect(lessons.find((r) => !r.supersededBy)!.text).toContain('forty seconds');
  });

  it('caps the number of agent calls for a very large session', async () => {
    const s = await fresh();
    await s.appendRecords(Array.from({ length: 200 }, (_, i) => rec(`activity ${i} ${'x'.repeat(200)}`, { id: `b${i}` })));
    let calls = 0;
    await distillSession(targetOf(), {
      ask: async () => {
        calls++;
        return { text: '[]', ok: true };
      },
      chunkChars: 300,
      maxChunks: 3,
    });
    expect(calls).toBe(3);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProvider } from '../../server/lib/providers/codex';
import { pricingFor } from '../../server/lib/store/usage';

describe('pricingFor — gpt/codex families', () => {
  it('prices gpt-5.5 at $5/$30 input/output with 10% cached', () => {
    const r = pricingFor('gpt-5.5');
    expect(r.input).toBe(5);
    expect(r.output).toBe(30);
    expect(r.cacheRead).toBe(0.5);
  });

  it('prices gpt-5.1-codex at the $1.25/$10 codex rate', () => {
    const r = pricingFor('gpt-5.1-codex');
    expect(r.input).toBe(1.25);
    expect(r.output).toBe(10);
  });

  it('falls back to the gpt-5.4 default rate for an unknown gpt model', () => {
    const r = pricingFor('gpt-6-mini');
    expect(r.input).toBe(2.5);
    expect(r.output).toBe(15);
  });
});

describe('CodexProvider.usage', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'seshmux-codex-usage-'));
    const dir = join(root, '2026', '07', '02');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rollout-2026-07-02-cccc-3333.jsonl');
    const lines = [
      {
        timestamp: '2026-07-02T12:00:00.000Z',
        type: 'session_meta',
        payload: { session_id: 'cccc-3333', cwd: '/Users/demo/github/myrepo', git: { branch: 'main' } },
      },
      {
        timestamp: '2026-07-02T12:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.5' },
      },
      // fresh input = 1000 - 200 = 800, cached = 200, output = 100
      {
        timestamp: '2026-07-02T12:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100, total_tokens: 1100 },
          },
        },
      },
      // second request delta: fresh = 500 - 50 = 450, cached = 50, output = 60
      {
        timestamp: '2026-07-02T12:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 500, cached_input_tokens: 50, output_tokens: 60, total_tokens: 1660 },
          },
        },
      },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const now = new Date();
    utimesSync(file, now, now);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('sums last_token_usage deltas and prices fresh vs cached input at distinct rates', async () => {
    const cx = new CodexProvider(root);
    const u = await cx.usage(30);
    expect(u.sessions).toBe(1);
    // fresh total = 800 + 450 = 1250, output total = 100 + 60 = 160
    expect(u.totalTokens).toBe(1250 + 160);
    // cached total = 200 + 50 = 250
    expect(u.cacheReads).toBe(250);
    // cost: gpt-5.5 rate input=5, cacheRead=0.5, output=30 (per million)
    const expectedCost = (1250 / 1_000_000) * 5 + (250 / 1_000_000) * 0.5 + (160 / 1_000_000) * 30;
    expect(u.estCostUsd).toBeCloseTo(expectedCost, 10);
    expect(u.byProject).toEqual([{ name: 'myrepo', pct: 100 }]);
  });
});

// Usage aggregator. PROVIDER-AGNOSTIC by design (hard rule 3): no `~/.claude`/`~/.codex`
// path and no `'claude'`/`'codex'` binary name appear here — the caller supplies both
// `root` and `provider`, same as scan.ts/transcript.ts. Reuses scanProjects/decodeProjectDir
// from scan.ts for project discovery so this file never re-reads a store layout on its own.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { scanProjects, type ProviderId } from './scan';
import { Lru } from './lru';

export interface UsageSummary {
  sessions: number;
  totalTokens: number;
  cacheReads: number;
  estCostUsd: number;
  byProject: { name: string; pct: number }[];
  byProvider: { provider: ProviderId; pct: number }[];
}

const ZERO_SUMMARY: UsageSummary = {
  sessions: 0,
  totalTokens: 0,
  cacheReads: 0,
  estCostUsd: 0,
  byProject: [],
  byProvider: [],
};

// Family pricing table, USD per million tokens, current published rates. Matched by
// substring (case-insensitive) against the model string so date-suffixed ids
// (claude-haiku-4-5-20251001) and bare aliases ("opus"/"sonnet"/"haiku") resolve to the
// right family without an ever-growing exact-match list. cacheRead = input * 0.1;
// cacheWrite = input * 1.25 (5-minute ephemeral cache rate).
// ponytail: cache-write priced at the 5-min-ephemeral 1.25x rate; 1h TTL would be 2x —
// acceptable approximation since usage.ts can't tell which TTL a session used.
interface Rate {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}
function rate(input: number, output: number): Rate {
  return { input, cacheWrite: input * 1.25, cacheRead: input * 0.1, output };
}
const FAMILY_PRICING = {
  opus: rate(5, 25),
  sonnet: rate(3, 15),
  haiku: rate(1, 5),
  fable: rate(10, 50),
} as const;
const DEFAULT_PRICING = FAMILY_PRICING.sonnet; // mid-tier default for unknown/synthetic models

// OpenAI (Codex) rates, USD per million tokens. cacheRead = input * 0.1 (published discount);
// OpenAI has no cache-write charge, so cacheWrite here is unused for gpt models — set to
// input as a harmless placeholder bucket (codex rollouts never report cache-creation tokens).
function gptRate(input: number, output: number): Rate {
  return { input, cacheWrite: input, cacheRead: input * 0.1, output };
}
const GPT_PRICING = {
  '5.5': gptRate(5, 30),
  '5.4': gptRate(2.5, 15),
  '5.3-codex': gptRate(1.75, 14),
  codex: gptRate(1.25, 10), // gpt-5.1-codex / gpt-5.1 family
} as const;
const GPT_DEFAULT = GPT_PRICING['5.4']; // ponytail: mid-tier default

function pricingFor(model: string): Rate {
  const m = model.toLowerCase();
  // gate gpt/codex checks on the string actually being an OpenAI model id, so "codex"
  // never accidentally matches a claude model (none of opus/sonnet/haiku/fable contain it).
  if (m.includes('gpt') || m.includes('codex')) {
    if (m.includes('5.5')) return GPT_PRICING['5.5'];
    if (m.includes('5.3-codex')) return GPT_PRICING['5.3-codex'];
    if (m.includes('5.4')) return GPT_PRICING['5.4'];
    if (m.includes('codex') || m.includes('5.1')) return GPT_PRICING.codex;
    return GPT_DEFAULT;
  }
  if (m.includes('opus')) return FAMILY_PRICING.opus;
  if (m.includes('sonnet')) return FAMILY_PRICING.sonnet;
  if (m.includes('haiku')) return FAMILY_PRICING.haiku;
  if (m.includes('fable') || m.includes('mythos')) return FAMILY_PRICING.fable;
  return DEFAULT_PRICING;
}

export { pricingFor };
export type { Rate };

// Definition (documented per task spec):
//   totalTokens = sum(output_tokens) + sum(input_tokens + cache_creation_input_tokens)
//   cacheReads  = sum(cache_read_input_tokens)   -- tracked separately, NOT in totalTokens
interface FileUsageTotals {
  tokens: number;
  cacheReads: number;
  costUsd: number;
}

// Cache parsed per-file usage totals keyed by (file, mtime), like scan.ts's headCache.
// LRU-bounded (sessions × recency): each turn bumps mtime and orphans the old key, so an
// unbounded Map grew forever over server uptime.
const usageCache = new Lru<FileUsageTotals>(2000);

async function readFileUsage(filePath: string, mtime: number): Promise<FileUsageTotals> {
  return usageCache.get(`${filePath}:${mtime}`, () => computeFileUsage(filePath));
}

async function computeFileUsage(filePath: string): Promise<FileUsageTotals> {
  let tokens = 0;
  let cacheReads = 0;
  let costUsd = 0;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (!line.trim() || line.indexOf('"usage"') === -1) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // tolerate malformed lines
      }
      if (obj.type !== 'assistant') continue;
      const usage = obj.message?.usage;
      if (!usage || typeof usage !== 'object') continue;

      const input = usage.input_tokens ?? 0;
      const cacheCreate = usage.cache_creation_input_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;

      tokens += input + cacheCreate + output;
      cacheReads += cacheRead;

      const model = typeof obj.message.model === 'string' ? obj.message.model : '';
      const r = pricingFor(model);
      costUsd +=
        (input / 1_000_000) * r.input +
        (cacheCreate / 1_000_000) * r.cacheWrite +
        (cacheRead / 1_000_000) * r.cacheRead +
        (output / 1_000_000) * r.output;
    }
  } finally {
    rl.close();
  }

  return { tokens, cacheReads, costUsd };
}

// ponytail: parses Claude-shaped `type:assistant / message.usage` lines only. Codex
// rollouts store usage as `event_msg token_count` — a codex root aggregates to 0 tokens
// here. Fine for v1 (usage card is Claude-dominant); wire a per-provider usage reader
// through the provider interface if codex spend needs to show. Task 7 merges providers.
export async function aggregateUsage(
  days: number,
  root: string,
  provider: ProviderId,
): Promise<UsageSummary> {
  const projects = await scanProjects(root, provider);
  if (projects.length === 0) return { ...ZERO_SUMMARY, byProject: [], byProvider: [] };

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  let sessions = 0;
  let totalTokens = 0;
  let cacheReads = 0;
  let estCostUsd = 0;
  const perProjectTokens = new Map<string, number>();

  for (const project of projects) {
    const dirPath = join(root, project.id);
    let files: string[];
    try {
      files = (await readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(dirPath, file);
      let mtime: number;
      try {
        mtime = Math.floor((await stat(filePath)).mtimeMs);
      } catch {
        continue;
      }
      if (mtime < cutoff) continue;

      const usage = await readFileUsage(filePath, mtime);
      sessions += 1;
      totalTokens += usage.tokens;
      cacheReads += usage.cacheReads;
      estCostUsd += usage.costUsd;
      perProjectTokens.set(project.name, (perProjectTokens.get(project.name) ?? 0) + usage.tokens);
    }
  }

  if (sessions === 0 || totalTokens === 0) {
    return { sessions, totalTokens, cacheReads, estCostUsd, byProject: [], byProvider: [] };
  }

  const byProject = [...perProjectTokens.entries()]
    .map(([name, tokens]) => ({ name, pct: Math.round((tokens / totalTokens) * 100) }))
    .sort((a, b) => b.pct - a.pct);

  return {
    sessions,
    totalTokens,
    cacheReads,
    estCostUsd,
    byProject,
    byProvider: [{ provider, pct: 100 }],
  };
}

// Usage aggregator. PROVIDER-AGNOSTIC by design (hard rule 3): no `~/.claude`/`~/.codex`
// path and no `'claude'`/`'codex'` binary name appear here — the caller supplies both
// `root` and `provider`, same as scan.ts/transcript.ts. Reuses scanProjects/decodeProjectDir
// from scan.ts for project discovery so this file never re-reads a store layout on its own.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { scanProjects, type ProviderId } from './scan';

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

// Static per-model pricing table, USD per million tokens. Approximate ("est.") published
// rates as of this writing — input covers input_tokens + cache_creation_input_tokens,
// cacheRead covers cache_read_input_tokens (billed far cheaper than fresh input), output
// covers output_tokens. Unknown models fall back to the opus rate.
const PRICING_PER_MILLION: Record<string, { input: number; cacheRead: number; output: number }> = {
  'claude-opus-4-8': { input: 15, cacheRead: 1.5, output: 75 },
  'claude-sonnet-5': { input: 3, cacheRead: 0.3, output: 15 },
  'claude-haiku-4-5': { input: 0.8, cacheRead: 0.08, output: 4 },
};
const DEFAULT_PRICING = PRICING_PER_MILLION['claude-opus-4-8'];

function pricingFor(model: string) {
  return PRICING_PER_MILLION[model] ?? DEFAULT_PRICING;
}

// Definition (documented per task spec):
//   totalTokens = sum(output_tokens) + sum(input_tokens + cache_creation_input_tokens)
//   cacheReads  = sum(cache_read_input_tokens)   -- tracked separately, NOT in totalTokens
interface FileUsageTotals {
  tokens: number;
  cacheReads: number;
  costUsd: number;
}

// Cache parsed per-file usage totals keyed by (file, mtime), like scan.ts's headCache.
const usageCache = new Map<string, FileUsageTotals>();

async function readFileUsage(filePath: string, mtime: number): Promise<FileUsageTotals> {
  const cacheKey = `${filePath}:${mtime}`;
  const cached = usageCache.get(cacheKey);
  if (cached) return cached;

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
      const rate = pricingFor(model);
      costUsd +=
        ((input + cacheCreate) / 1_000_000) * rate.input +
        (cacheRead / 1_000_000) * rate.cacheRead +
        (output / 1_000_000) * rate.output;
    }
  } finally {
    rl.close();
  }

  const totals: FileUsageTotals = { tokens, cacheReads, costUsd };
  usageCache.set(cacheKey, totals);
  return totals;
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

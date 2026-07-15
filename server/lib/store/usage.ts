// Usage aggregator. PROVIDER-AGNOSTIC by design (hard rule 3): no `~/.claude`/`~/.codex`
// path and no `'claude'`/`'codex'` binary name appear here — the caller supplies both
// `root` and `provider`, same as scan.ts/transcript.ts. Reuses scanProjects/decodeProjectDir
// from scan.ts for project discovery so this file never re-reads a store layout on its own.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { projectSessionDirs, scanProjects, type ProviderId } from './scan';
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
// One parsed assistant turn. `ts` is the line's own timestamp (ms) so a "last N days"
// window filters per TURN, not per file — a resumed old session with one new turn must
// contribute only that turn, not the whole file (S4-1).
interface Turn {
  ts: number; // Date.parse(line.timestamp); NaN if absent/unparseable
  tokens: number;
  cacheReads: number;
  costUsd: number;
}

// Cache the parsed per-turn array keyed by (file, mtime), like scan.ts's headCache. The
// cache is deliberately window-INDEPENDENT: it holds every turn, and aggregateUsage()
// applies the days cutoff after the cache read — so the same cached parse serves a 7-day
// and a 30-day query without cross-window corruption. LRU-bounded (sessions × recency):
// each append bumps mtime and orphans the old key, so an unbounded Map grew forever.
const usageCache = new Lru<Turn[]>(2000);

async function readFileTurns(filePath: string, mtime: number): Promise<Turn[]> {
  return usageCache.get(`${filePath}:${mtime}`, () => computeFileTurns(filePath));
}

async function computeFileTurns(filePath: string): Promise<Turn[]> {
  const turns: Turn[] = [];

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

      const model = typeof obj.message.model === 'string' ? obj.message.model : '';
      const r = pricingFor(model);
      const costUsd =
        (input / 1_000_000) * r.input +
        (cacheCreate / 1_000_000) * r.cacheWrite +
        (cacheRead / 1_000_000) * r.cacheRead +
        (output / 1_000_000) * r.output;

      const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
      turns.push({ ts, tokens: input + cacheCreate + output, cacheReads: cacheRead, costUsd });
    }
  } finally {
    rl.close();
  }

  return turns;
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
    // projectSessionDirs, not readdir(join(root, project.id)): a project's sessions can
    // live in FOLDED worktree dirents (and a workspace-only parent's id is synthesized,
    // with no dirent of its own — the direct readdir threw and skipped the whole
    // project). Listing and usage must resolve ids identically or they disagree.
    const filePaths: string[] = [];
    for (const dirPath of await projectSessionDirs(project.id, root, provider)) {
      try {
        filePaths.push(...(await readdir(dirPath)).filter((f) => f.endsWith('.jsonl')).map((f) => join(dirPath, f)));
      } catch {
        continue; // dirent vanished mid-scan — skip it, not the project
      }
    }

    for (const filePath of filePaths) {
      let mtime: number;
      let touchedAt: number;
      try {
        const st = await stat(filePath);
        mtime = Math.floor(st.mtimeMs);
        // Gate on max(mtime, ctime), not mtime alone (D5-4). The gate's premise — "no turn can
        // post-date the file's mtime" — holds for a file the agent wrote in place, but NOT for
        // one restored by rsync / cp -p / tar / a backup: those replay an old mtime onto fresh
        // content, so a coarse mtime gate silently dropped whole files and under-counted usage.
        // ctime is set by the kernel when the inode is written and CANNOT be back-dated by
        // those tools (they utimes() the mtime, which itself bumps ctime to now), so a restored
        // file has old mtime + fresh ctime and now correctly survives the gate.
        // Measured on the real 3,695-file store: ctime == mtime on every single file, so this
        // passes an IDENTICAL file set (delta +0 at both the 7d and 30d windows) — the gate
        // keeps its full benefit (dropping it costs ~5x on the 7d window: 301ms -> 1469ms).
        // ponytail ceiling: a backwards SYSTEM CLOCK skew moves mtime and ctime together and is
        // still undetectable from stat alone — the only fix would be parsing every file, which
        // is exactly the cost the gate exists to avoid.
        touchedAt = Math.max(mtime, Math.floor(st.ctimeMs));
      } catch {
        continue;
      }
      if (touchedAt < cutoff) continue;

      // Per-turn window filter (S4-1): sum only turns at/after the cutoff. An undated turn
      // (no parseable timestamp — never seen on real Claude lines) is counted, since the
      // file already passed the mtime gate so its turns are recent. sessions counts every
      // in-window file, matching the pre-fix "active sessions in this window" metric.
      const turns = await readFileTurns(filePath, mtime);
      let fileTokens = 0;
      for (const t of turns) {
        if (!Number.isNaN(t.ts) && t.ts < cutoff) continue;
        fileTokens += t.tokens;
        cacheReads += t.cacheReads;
        estCostUsd += t.costUsd;
      }
      sessions += 1;
      totalTokens += fileTokens;
      perProjectTokens.set(project.name, (perProjectTokens.get(project.name) ?? 0) + fileTokens);
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

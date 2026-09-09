// Agent-memory persistence: append-only NDJSON shards + a replayed mutation overlay.
//
// WHY NOT json-store.ts: that module says it plainly — "NOT multi-process safe, each file
// must have exactly one owning server process". Memory has TWO writers. The web server
// harvests, and the mcp-bridge (a separate process spawned by the agent, see
// bridge/mcp.ts) appends when an agent calls `remember`. A read-modify-write of one JSON
// file would lose whichever write landed second. Append-only NDJSON is the pattern that
// already works cross-process here: defaultBridgeLog writes bridge-log.jsonl the same way.
// Records are small (~300B), well under any platform's atomic-append threshold.
//
// json-store IS still used, for watermarks.json (harvest.ts) — the server is its only writer.
//
// Layout under <configDir>/memory/:
//   records/<yyyy-mm>.ndjson   one record per line, append-only, both processes
//   overlay.ndjson             delete/supersede/pin/hit/edit, append-only, both processes
//   watermarks.json            harvest offsets (server only)

import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_SCHEMA,
  isDistilled,
  type MemoryOverlayOp,
  type MemoryRecord,
  type MemorySettings,
} from './types';

// Resolved locally rather than imported from daemon-client.ts, matching bridgeConfigDir() in
// bridge/mcp.ts: this module is loaded by the mcp-bridge process, which must not pull in the
// daemon socket client just to learn a directory name.
export function memoryConfigDir(): string {
  return process.env.SESHMUX_CONFIG_DIR || join(homedir(), '.config', 'seshmux');
}
export function memoryDir(): string {
  return join(memoryConfigDir(), 'memory');
}
export function recordsDir(): string {
  return join(memoryDir(), 'records');
}
export function overlayPath(): string {
  return join(memoryDir(), 'overlay.ndjson');
}

// A record's identity is its CONTENT, not a counter: re-harvesting a session that has grown
// re-derives the same records for the part already seen, and they must collapse rather than
// duplicate.
//
// `scope` is the discriminator, and WHICH scope differs by record family. Harvested records
// use the session id, so the same error hit in two sessions stays two citable observations.
// Agent- and user-authored facts use the PROJECT id, because "we decided X here" is one fact
// about the repo however many sessions restate it — keying those by session would mint a new
// record on every write and make `remember` non-idempotent.
export function contentId(parts: { kind: string; text: string; scope: string; target?: string }): string {
  return createHash('sha256')
    .update(`${parts.kind} ${parts.scope} ${parts.target ?? ''} ${parts.text}`)
    .digest('hex')
    .slice(0, 16);
}

// C0/C1 control characters are stripped at WRITE time, not read time: a record ends up
// pasted into a live TUI (memory-paste.ts) and returned from an MCP tool, and an embedded
// ESC could move the cursor or smuggle an escape sequence into either. Tab and newline
// survive; nothing else does.
// Kept as an explicit code-point test rather than a character-class literal so this source
// file contains no control characters of its own.
function isControlChar(code: number): boolean {
  const TAB = 9, LF = 10;
  if (code < 0x20) return code !== TAB && code !== LF;
  return code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

export function sanitizeText(raw: string, max = 2000): string {
  let out = '';
  for (const ch of raw) {
    if (!isControlChar(ch.codePointAt(0) as number)) out += ch;
  }
  const cleaned = out.trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned;
}

async function ensureDirs(): Promise<void> {
  await mkdir(recordsDir(), { recursive: true });
}

export function shardName(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}.ndjson`;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

// Appends records, grouped into one appendFile call per shard so a batch is one write per
// file rather than one per record. Returns what was written (callers dedup against
// knownIds() first; the in-batch dedup here is the last resort).
export async function appendRecords(records: MemoryRecord[]): Promise<MemoryRecord[]> {
  if (records.length === 0) return [];
  await ensureDirs();
  const seen = new Set<string>();
  const byShard = new Map<string, string[]>();
  const written: MemoryRecord[] = [];
  for (const r of records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const shard = shardName(r.origin.ts);
    const lines = byShard.get(shard) ?? [];
    lines.push(JSON.stringify(r));
    byShard.set(shard, lines);
    written.push(r);
  }
  for (const [shard, lines] of byShard) {
    await appendFile(join(recordsDir(), shard), lines.join('\n') + '\n', 'utf8');
  }
  cache = null;
  return written;
}

export async function appendOverlay(ops: MemoryOverlayOp[]): Promise<void> {
  if (ops.length === 0) return;
  await ensureDirs();
  await appendFile(overlayPath(), ops.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  cache = null;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// Cached on the shard+overlay size/mtime signature. Both processes cache independently; a
// stale read is impossible because the signature changes on every append. This is also why
// there is no persisted index — rebuilding from these records is fast enough that an index
// would only add an invalidation-bug surface.
let cache: { sig: string; records: MemoryRecord[] } | null = null;

export function _resetMemoryForTest(): void {
  cache = null;
}

async function signature(): Promise<string> {
  const parts: string[] = [];
  let files: string[] = [];
  try {
    files = (await readdir(recordsDir())).filter((f) => f.endsWith('.ndjson')).sort();
  } catch {
    return 'empty';
  }
  for (const f of files) {
    try {
      const s = await stat(join(recordsDir(), f));
      parts.push(`${f}:${s.size}:${s.mtimeMs}`);
    } catch {
      /* vanished mid-scan — the next read re-signs */
    }
  }
  try {
    const s = await stat(overlayPath());
    parts.push(`overlay:${s.size}:${s.mtimeMs}`);
  } catch {
    /* no overlay yet */
  }
  return parts.join('|') || 'empty';
}

// Tolerant NDJSON read: a torn last line (a crash mid-append) drops that line, never the
// file. Same discipline as json-store's corrupt-file-is-empty rule.
function parseNdjson<T>(raw: string): T[] {
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* torn or hand-edited line — skip it, keep the file */
    }
  }
  return out;
}

export interface ReadOpts {
  /** Include records hidden by a delete/expire op. Compaction needs this; recall does not. */
  includeRemoved?: boolean;
}

export async function readAllRecords(opts: ReadOpts = {}): Promise<MemoryRecord[]> {
  const sig = await signature();
  if (cache && cache.sig === sig && !opts.includeRemoved) return cache.records;

  const byId = new Map<string, MemoryRecord>();
  let files: string[] = [];
  try {
    files = (await readdir(recordsDir())).filter((f) => f.endsWith('.ndjson')).sort();
  } catch {
    return [];
  }
  for (const f of files) {
    let raw: string;
    try {
      raw = await readFile(join(recordsDir(), f), 'utf8');
    } catch {
      continue;
    }
    for (const r of parseNdjson<MemoryRecord>(raw)) {
      if (!r || typeof r.id !== 'string' || r.v !== MEMORY_SCHEMA) continue;
      byId.set(r.id, r); // later line wins — an intentional re-append is an update
    }
  }

  // Replay the overlay in file order; "pinned then unpinned" resolves by position.
  const removed = new Set<string>();
  try {
    const raw = await readFile(overlayPath(), 'utf8');
    for (const op of parseNdjson<MemoryOverlayOp>(raw)) {
      const rec = byId.get(op.id);
      if (!rec) continue;
      switch (op.op) {
        case 'delete':
        case 'expire':
          removed.add(op.id);
          break;
        case 'supersede':
          rec.supersededBy = op.by;
          break;
        case 'pin':
          rec.pinned = true;
          break;
        case 'unpin':
          rec.pinned = false;
          break;
        case 'hit':
          rec.hits = (rec.hits ?? 0) + 1;
          rec.lastHit = Math.max(rec.lastHit ?? 0, op.at);
          break;
        case 'edit':
          rec.text = sanitizeText(op.text);
          break;
      }
    }
  } catch {
    /* no overlay yet */
  }

  const all = [...byId.values()];
  const visible = opts.includeRemoved ? all : all.filter((r) => !removed.has(r.id));
  if (!opts.includeRemoved) cache = { sig, records: visible };
  return visible;
}

/** Ids already on disk — harvest/remember dedup against this before appending. */
export async function knownIds(): Promise<Set<string>> {
  return new Set((await readAllRecords({ includeRemoved: true })).map((r) => r.id));
}

// ---------------------------------------------------------------------------
// Retention / compaction
// ---------------------------------------------------------------------------

// A record's eviction value. Pinned and distilled records are never evicted by age — the
// whole point of distillation is that a lesson outlives the session that produced it.
// Deterministic records are the volume, and volume is what the cap defends against.
export function evictionValue(r: MemoryRecord, now: number): number {
  if (r.pinned) return Number.POSITIVE_INFINITY;
  if (isDistilled(r.kind)) return Number.POSITIVE_INFINITY;
  const ageDays = Math.max(0, (now - r.origin.ts) / 86_400_000);
  const kindWeight = r.kind === 'error' ? 3 : r.kind === 'outcome' ? 2 : 1;
  const hitBoost = 1 + Math.min(10, r.hits ?? 0);
  return (kindWeight * hitBoost) / (1 + ageDays);
}

/** Pure: which ids compaction should drop, given the current set. Unit-tested directly. */
export function planCompaction(
  records: MemoryRecord[],
  settings: MemorySettings,
  now: number,
): { drop: Set<string>; keep: MemoryRecord[] } {
  const drop = new Set<string>();
  const retentionMs = settings.retentionDays * 86_400_000;
  for (const r of records) {
    if (r.pinned || isDistilled(r.kind)) continue;
    const lastTouch = Math.max(r.origin.ts, r.lastHit ?? 0);
    if (now - lastTouch > retentionMs) drop.add(r.id);
  }
  let keep = records.filter((r) => !drop.has(r.id));
  if (keep.length > settings.maxRecords) {
    const ranked = [...keep].sort((a, b) => evictionValue(b, now) - evictionValue(a, now));
    for (const r of ranked.slice(settings.maxRecords)) drop.add(r.id);
    keep = keep.filter((r) => !drop.has(r.id));
  }
  return { drop, keep };
}

// Rewrites the shards from the surviving set and drops the overlay (its ops are now folded
// into the records). Atomic per shard via temp+rename, the json-store discipline.
//
// SINGLE-WRITER: only the web server calls this. A concurrent append from the mcp-bridge
// during the rewrite window would be lost, so the caller serializes it against harvesting.
export async function compact(
  settings: MemorySettings = DEFAULT_MEMORY_SETTINGS,
  now = Date.now(),
): Promise<{ dropped: number; kept: number }> {
  await ensureDirs();
  const all = await readAllRecords();
  const { drop, keep } = planCompaction(all, settings, now);

  const byShard = new Map<string, MemoryRecord[]>();
  for (const r of keep) {
    const shard = shardName(r.origin.ts);
    const list = byShard.get(shard) ?? [];
    list.push(r);
    byShard.set(shard, list);
  }

  let existing: string[] = [];
  try {
    existing = (await readdir(recordsDir())).filter((f) => f.endsWith('.ndjson'));
  } catch {
    /* nothing to compact */
  }

  for (const [shard, list] of byShard) {
    const target = join(recordsDir(), shard);
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, list.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    await rename(tmp, target);
  }
  // A shard whose every record was dropped no longer appears in byShard — remove the file.
  for (const f of existing) {
    if (!byShard.has(f)) await unlink(join(recordsDir(), f)).catch(() => {});
  }
  await unlink(overlayPath()).catch(() => {});
  cache = null;
  return { dropped: drop.size, kept: keep.length };
}

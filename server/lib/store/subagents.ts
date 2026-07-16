// Subagent tree parser. PROVIDER-AGNOSTIC (hard rule 3): no `~/.claude` path, no
// 'claude'/'codex' string, no provider name. The caller passes an absolute `sessionDir`
// (the directory holding a session's `subagents/` and `workflows/` subdirs); this file only
// knows the layout relative to that dir.
//
// Every parser tolerates malformed/truncated/partial jsonl and json: try/catch + skip,
// never throw. Missing dirs/files → [] or null, never throw.

import { readFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { SubagentActivity, SubagentDetail, SubagentNode } from '../providers/types';
import { extractText, stringifyContent } from './transcript';

const QUIESCE_MS = 15_000;
const SUMMARY_MAX = 120;

export interface RawNodeSources {
  meta: any;
  workflowProgress?: any;
  jsonlPath: string;
}

function ellipsize(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// Read one jsonl file's lines as parsed objects, skipping bad lines. Small agent jsonl files
// (0.6KB-470KB) — a full read is cheap enough for both list() token/status derivation and
// detail() parsing.
async function readJsonlLines(jsonlPath: string): Promise<any[]> {
  const out: any[] = [];
  let rl: ReturnType<typeof createInterface>;
  try {
    rl = createInterface({
      input: createReadStream(jsonlPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
  } catch {
    return out;
  }
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        continue; // tolerate malformed/truncated lines
      }
    }
  } catch {
    // stream error mid-read — return whatever we got
  }
  return out;
}

/*
 * Status derivation (in priority order):
 *   1. meta.stoppedByUser              -> 'error'
 *   2. workflowProgress.state==='error' -> 'error'
 *   3. workflowProgress.state==='done'  -> 'done'
 *   4. last jsonl line is an assistant text line whose embedded `timestamp` is older
 *      than QUIESCE_MS ago -> 'done'
 *   5. else -> 'running'
 *
 * CRITICAL: quiescence uses the last line's EMBEDDED `timestamp` field (Date.parse), NEVER
 * the file's mtime. Fixtures get copied around (mtime resets to "now"), which would falsely
 * read as 'running' forever if we used mtime. This is the load-bearing correctness rule.
 *
 * Trade-off: a genuinely-idle-but-still-alive agent (mid-thought, no new line in >15s) can
 * flip to 'done' early. Acceptable for a read-only viewer that refetches on file-change events
 * — a false 'done' self-corrects the moment the next line lands.
 */
function deriveStatus(
  meta: any,
  workflowProgress: any,
  lastLine: any,
): SubagentNode['status'] {
  if (meta?.stoppedByUser) return 'error';
  if (workflowProgress?.state === 'error') return 'error';
  if (workflowProgress?.state === 'done') return 'done';
  if (lastLine && lastLine.type === 'assistant' && lastLine.message?.role === 'assistant') {
    const ts = typeof lastLine.timestamp === 'string' ? Date.parse(lastLine.timestamp) : NaN;
    if (!Number.isNaN(ts) && Date.now() - ts > QUIESCE_MS) return 'done';
  }
  return 'running';
}

export function nodeFromSources(agentId: string, s: RawNodeSources): SubagentNode {
  const { meta, workflowProgress, jsonlPath } = s;
  // Drop a self-referential parent (parentAgentId === own id): it can never be a real
  // parent, and left in place it makes the node a non-root child of itself — invisible in
  // the tree. Nulling it renders the node as a root instead (S4-2). Multi-node cycles are
  // caught downstream by SubagentTree's visited guard.
  const parentId = meta?.parentAgentId && meta.parentAgentId !== agentId ? meta.parentAgentId : null;
  return {
    id: agentId,
    parentId,
    label: meta?.description ?? workflowProgress?.label ?? meta?.agentType ?? agentId,
    agentType: meta?.agentType ?? null,
    group: workflowProgress?.phaseTitle ?? null,
    model: workflowProgress?.model ?? null,
    status: 'running', // overwritten by listSubagentNodes once the jsonl tail is known
    tokens: workflowProgress?.tokens ?? null,
    toolCalls: workflowProgress?.toolCalls ?? null,
    startedAt: workflowProgress?.startedAt ?? null,
    endedAt:
      workflowProgress?.startedAt != null && workflowProgress?.durationMs != null
        ? workflowProgress.startedAt + workflowProgress.durationMs
        : null,
    jsonlPath,
  };
}

async function readJsonSafe(path: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function listMetaFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.startsWith('agent-') && e.name.endsWith('.meta.json'))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

export async function listSubagentNodes(sessionDir: string): Promise<SubagentNode[]> {
  const subagentsDir = join(sessionDir, 'subagents');
  const workflowsRunsDir = join(subagentsDir, 'workflows');

  // Index workflowProgress entries (type==='workflow_agent') by agentId from every
  // sessionDir/workflows/*.json, read once.
  const progressByAgentId = new Map<string, any>();
  const workflowsDir = join(sessionDir, 'workflows');
  try {
    const files = await readdir(workflowsDir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const doc = await readJsonSafe(join(workflowsDir, f));
      const progress = doc?.workflowProgress;
      if (!Array.isArray(progress)) continue;
      for (const entry of progress) {
        if (entry?.type === 'workflow_agent' && entry.agentId) {
          progressByAgentId.set(entry.agentId, entry);
        }
      }
    }
  } catch {
    // no workflows dir — fine, plain-Task-only session
  }

  // Collect meta files: subagents/agent-*.meta.json and subagents/workflows/*/agent-*.meta.json
  const metaPaths: string[] = [...(await listMetaFiles(subagentsDir))];
  try {
    const runDirs = await readdir(workflowsRunsDir, { withFileTypes: true });
    for (const d of runDirs) {
      if (!d.isDirectory()) continue;
      metaPaths.push(...(await listMetaFiles(join(workflowsRunsDir, d.name))));
    }
  } catch {
    // no subagents/workflows dir — fine
  }

  const nodes: SubagentNode[] = [];
  for (const metaPath of metaPaths) {
    const name = basename(metaPath); // agent-<id>.meta.json
    const agentId = name.slice('agent-'.length, name.length - '.meta.json'.length);
    if (!agentId) continue;
    const meta = await readJsonSafe(metaPath);
    if (!meta) continue;
    const dir = metaPath.slice(0, metaPath.length - name.length);
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);
    const workflowProgress = progressByAgentId.get(agentId);

    const node = nodeFromSources(agentId, { meta, workflowProgress, jsonlPath });

    // Plain-Task nodes (no workflowProgress tokens/toolCalls) need a jsonl read to fill
    // tokens (sum of output_tokens, NOT tokensFromUsage's input+cache), toolCalls, startedAt,
    // and to derive status via quiescence.
    const lines = await readJsonlLines(jsonlPath);
    if (node.tokens == null) {
      let sum = 0;
      let has = false;
      for (const l of lines) {
        const out = l?.message?.usage?.output_tokens;
        if (typeof out === 'number') {
          sum += out;
          has = true;
        }
      }
      node.tokens = has ? sum : null;
    }
    if (node.toolCalls == null) {
      let count = 0;
      for (const l of lines) {
        if (l?.type !== 'assistant' || !Array.isArray(l?.message?.content)) continue;
        for (const block of l.message.content) {
          if (block?.type === 'tool_use') count++;
        }
      }
      node.toolCalls = count;
    }
    if (node.startedAt == null && lines.length) {
      const ts = typeof lines[0]?.timestamp === 'string' ? Date.parse(lines[0].timestamp) : NaN;
      node.startedAt = Number.isNaN(ts) ? null : ts;
    }
    if (node.endedAt == null && lines.length) {
      const last = lines[lines.length - 1];
      const ts = typeof last?.timestamp === 'string' ? Date.parse(last.timestamp) : NaN;
      node.endedAt = Number.isNaN(ts) ? null : ts;
    }

    node.status = deriveStatus(meta, workflowProgress, lines[lines.length - 1]);
    nodes.push(node);
  }

  return nodes;
}

export async function parseSubagentDetail(
  jsonlPath: string,
  node: SubagentNode,
): Promise<SubagentDetail> {
  const lines = await readJsonlLines(jsonlPath);

  let prompt = '';
  const firstUser = lines.find((l) => l?.type === 'user' && l?.message?.role === 'user');
  if (firstUser) prompt = extractText(firstUser.message.content);

  const activity: SubagentActivity[] = [];
  let lastAssistantText = '';
  for (const l of lines) {
    if (l?.type !== 'assistant' || !Array.isArray(l?.message?.content)) continue;
    let text = '';
    for (const block of l.message.content) {
      if (block?.type === 'tool_use') {
        activity.push({
          tool: String(block.name ?? ''),
          summary: ellipsize(stringifyContent(block.input), SUMMARY_MAX),
        });
      } else if (block?.type === 'text') {
        text += (text ? '\n' : '') + String(block.text ?? '');
      }
    }
    if (text) lastAssistantText = text;
  }

  const raw = lastAssistantText;
  const trimmed = raw.trimStart();
  const kind: 'json' | 'text' = trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'text';

  return { node, prompt, activity, outcome: { raw, kind } };
}

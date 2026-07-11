// Transcript parser + context-window calculator. PROVIDER-AGNOSTIC: no `~/.claude` path
// and no provider id live here — callers pass an absolute file path (readCtx) or a
// projectId+sessionId+root triple (parseTranscript). The `window` param is either a plain
// number or a model→number resolver function supplied by the provider (Claude's window
// varies by model family; codex supplies a fixed number derived from its rollout files).

import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isSafeId } from './scan';

export interface ToolCall {
  name: string;
  input: string;
  output: string;
}

export interface Msg {
  role: 'user' | 'assistant';
  text: string;
  tools: ToolCall[];
  ts: number;
}

export interface Ctx {
  tokens: number;
  window: number;
  pct: number;
  model: string;
}

// No provider-specific window default lives here (hard rule 3) — the caller (a provider)
// always supplies its own window, either as a number or a model→number resolver. Claude
// passes a resolver (window varies by model family), codex passes a fixed 258_400.
const TAIL_BYTES = 64 * 1024;

// Transcript display skips only command/framing noise — a `<teammate-message>` is real
// conversation content and stays visible (scan.ts skips it for TITLE selection only).
const SKIP_TITLE_PREFIXES = ['<command-name>', '<local-command', '<system-reminder'];

export function tokensFromUsage(usage: any): number {
  if (!usage || typeof usage !== 'object') return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

// Extract plain text from a message.content (string or content-block array).
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as any).type === 'text') {
      parts.push(String((block as any).text ?? ''));
    }
  }
  return parts.join('\n');
}

export function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content ?? '');
  }
}

export async function parseTranscript(
  projectId: string,
  sessionId: string,
  root: string,
  window: number | ((model: string) => number),
): Promise<{ msgs: Msg[]; ctx: Ctx | null }> {
  // Traversal guard (SEC-4): both ids are path-joined below — refuse "../" in either.
  if (!isSafeId(projectId) || !isSafeId(sessionId)) return { msgs: [], ctx: null };
  const filePath = join(root, projectId, `${sessionId}.jsonl`);
  const msgs: Msg[] = [];
  const toolById = new Map<string, ToolCall>();
  let lastUsage: any = null;
  let lastModel = '';

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // tolerate malformed lines
    }
    const msg = obj.message;
    if (!msg || typeof msg !== 'object') continue;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : 0;

    if (obj.type === 'user' && msg.role === 'user') {
      const content = msg.content;
      // A user entry may be a tool_result carrier — fold outputs into their tool call
      // and do NOT emit a standalone user message for it.
      if (Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')) {
        for (const block of content) {
          if (block?.type === 'tool_result') {
            const tool = toolById.get(block.tool_use_id);
            if (tool) tool.output = stringifyContent(block.content);
          }
        }
        continue;
      }
      const text = extractText(content).trim();
      const isMeta = SKIP_TITLE_PREFIXES.some((p) => text.startsWith(p));
      if (isMeta) continue;
      msgs.push({ role: 'user', text, tools: [], ts });
      continue;
    }

    if (obj.type === 'assistant' && msg.role === 'assistant') {
      if (msg.usage) {
        lastUsage = msg.usage;
        if (typeof msg.model === 'string') lastModel = msg.model;
      }
      const tools: ToolCall[] = [];
      let text = '';
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === 'text') {
            text += (text ? '\n' : '') + String(block.text ?? '');
          } else if (block?.type === 'tool_use') {
            const call: ToolCall = {
              name: String(block.name ?? ''),
              input: stringifyContent(block.input),
              output: '',
            };
            if (block.id) toolById.set(block.id, call);
            tools.push(call);
          }
        }
      } else {
        text = extractText(msg.content);
      }
      // Only emit a message if it carries text or tool calls (skip empty stubs).
      if (text || tools.length) msgs.push({ role: 'assistant', text, tools, ts });
    }
  }

  const ctx: Ctx | null = lastUsage
    ? (() => {
        const tokens = tokensFromUsage(lastUsage);
        const win = typeof window === 'function' ? window(lastModel) : window;
        return {
          tokens,
          window: win,
          pct: Math.round((tokens / win) * 100),
          model: lastModel,
        };
      })()
    : null;

  return { msgs, ctx };
}

// Tail-read only the last 64KB of a session file and scan backwards for the last
// assistant line carrying `usage`. Cheap enough to call on every ctx poll.
export async function readCtx(
  filePath: string,
  window: number | ((model: string) => number),
): Promise<Ctx | null> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return null;
  }
  const start = Math.max(0, size - TAIL_BYTES);
  const fh = await open(filePath, 'r');
  let chunk: string;
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    chunk = buf.toString('utf8');
  } finally {
    await fh.close();
  }

  const lines = chunk.split('\n');
  // If we started mid-file, the first line may be a partial — drop it.
  if (start > 0) lines.shift();

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"usage"') === -1) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = obj?.message?.usage;
    if (obj.type === 'assistant' && usage) {
      const tokens = tokensFromUsage(usage);
      const model = typeof obj.message.model === 'string' ? obj.message.model : '';
      const win = typeof window === 'function' ? window(model) : window;
      return {
        tokens,
        window: win,
        pct: Math.round((tokens / win) * 100),
        model,
      };
    }
  }
  return null;
}

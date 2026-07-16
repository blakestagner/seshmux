// GitHub PR extraction — PROVIDER-AGNOSTIC: operates on the parsed Msg[] both
// providers' parseTranscript already return (claude tool_use/tool_result and
// codex function_call/function_call_output land in the same ToolCall shape),
// so no provider-specific parsing is needed here.
//
// "Created in this session" heuristic: a PR URL counts only when it appears in
// (a) the OUTPUT of a tool call whose INPUT asks to create a PR (`gh pr create`,
//     "create a PR/pull request" — covers Bash and the create-pr Agent), or
// (b) an assistant text line that both names the URL and says created/opened.
// A PR merely mentioned/reviewed/viewed is excluded.
// ponytail: regex heuristic over transcript text — no gh API calls, no state.
// If it ever misses a creation shape, add one pattern + one fixture line.

import type { Msg } from './transcript';

export interface PrRef {
  url: string; // canonical https://github.com/owner/repo/pull/n
  owner: string;
  repo: string;
  number: number;
  title?: string;
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
// "create/creating/open/opening ... pr/pull request" within a short window, or a
// literal `pr create`. "open" covers the create-pr subagent, whose prompt says
// "Open a GitHub PR ..." — a real creation the create-phrasing alone missed. Past
// tense ("opened") is deliberately NOT here (that reads as a report/view of an
// existing PR); the assistant-text path (CREATE_TEXT) handles "opened https://…".
const CREATE_INPUT = /\bpr\s+create\b|\b(?:creat(?:e|ing)|open(?:ing)?)\b[\s\S]{0,80}?\b(?:pr|pull\s+request)\b/i;
const CREATE_TEXT = /\bcreat(?:e|ed|ing)\b|\bopened\b/i;
// Best-effort `--title` capture from a raw (often JSON-stringified) command
// string. ponytail: stops at the first quote/backslash — good enough for the
// chip label; UI falls back to repo#number when absent.
const TITLE_ARG = /--title[=\s]+\\?["']?([^"'\n\\]{1,120})/;

function collect(byUrl: Map<string, PrRef>, text: string, title?: string): void {
  for (const m of text.matchAll(PR_URL)) {
    const [, owner, repo, num] = m;
    const number = Number(num);
    const url = `https://github.com/${owner}/${repo}/pull/${number}`;
    const existing = byUrl.get(url);
    if (existing) {
      if (!existing.title && title) existing.title = title;
    } else {
      byUrl.set(url, { url, owner, repo, number, ...(title ? { title } : {}) });
    }
  }
}

export function extractPrs(msgs: Msg[]): PrRef[] {
  const byUrl = new Map<string, PrRef>();
  for (const msg of msgs) {
    for (const tool of msg.tools) {
      if (!tool.output || !CREATE_INPUT.test(tool.input)) continue;
      const title = TITLE_ARG.exec(tool.input)?.[1]?.trim();
      collect(byUrl, tool.output, title || undefined);
    }
    if (msg.role === 'assistant' && msg.text) {
      for (const line of msg.text.split('\n')) {
        if (CREATE_TEXT.test(line)) collect(byUrl, line);
      }
    }
  }
  return [...byUrl.values()];
}

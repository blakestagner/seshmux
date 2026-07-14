// Pure mapping from a subagent outcome {raw, kind} to render blocks. No React,
// no DOM — kept separate from SubagentDetail.tsx so it's unit-testable without
// mounting a component (plan Task 5).

export type OutcomeBlock =
  | { kind: 'markdown'; text: string }
  | { kind: 'files'; files: string[] }
  | { kind: 'badge'; label: string; ok: boolean }
  | { kind: 'prose'; text: string }
  | { kind: 'pre'; text: string };

type KnownJson = {
  summary?: unknown;
  files?: unknown;
  testsPassed?: unknown;
  notes?: unknown;
};

export function renderOutcomeBlocks(outcome: { raw: string; kind: 'json' | 'text' }): OutcomeBlock[] {
  if (outcome.kind === 'text') {
    return [{ kind: 'markdown', text: outcome.raw }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.raw);
  } catch {
    return [{ kind: 'pre', text: outcome.raw }];
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return [{ kind: 'pre', text: JSON.stringify(parsed, null, 2) }];
  }

  const obj = parsed as KnownJson;
  const hasKnownKey =
    typeof obj.summary === 'string' ||
    Array.isArray(obj.files) ||
    typeof obj.testsPassed === 'boolean' ||
    typeof obj.notes === 'string';

  if (!hasKnownKey) {
    return [{ kind: 'pre', text: JSON.stringify(parsed, null, 2) }];
  }

  const blocks: OutcomeBlock[] = [];
  if (typeof obj.summary === 'string') blocks.push({ kind: 'markdown', text: obj.summary });
  if (Array.isArray(obj.files)) blocks.push({ kind: 'files', files: obj.files as string[] });
  if (typeof obj.testsPassed === 'boolean') blocks.push({ kind: 'badge', label: 'tests', ok: obj.testsPassed });
  if (typeof obj.notes === 'string') blocks.push({ kind: 'prose', text: obj.notes });
  return blocks;
}

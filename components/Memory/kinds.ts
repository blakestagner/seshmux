// How a memory kind presents, and which kinds the panel deals in at all.
//
// One module so the glyph and the name cannot drift apart, and so the one place that
// decides "a session's memory means these kinds" is findable.

import type { MemoryKind } from '../../lib/client/api';

export const KIND_GLYPH: Record<MemoryKind, string> = {
  decision: '✧',
  lesson: '✦',
  error: '✕',
  artifact: '✎',
  'tool-call': '·',
  prompt: '?',
  outcome: '=',
};

/** Singular — what ONE record of this kind is. Used inside a session group. */
export const KIND_LABEL: Record<MemoryKind, string> = {
  decision: 'decision',
  lesson: 'lesson',
  error: 'error',
  artifact: 'file',
  'tool-call': 'command',
  prompt: 'prompt',
  outcome: 'finding',
};

/**
 * What a session is actually ABOUT: what was asked, what was concluded, what was decided
 * or learned, and what went wrong.
 *
 * The complement — `tool-call` and `artifact` — is the mechanical record of every command
 * run and every file touched. It is the bulk of any store (~79% of a real one) and almost
 * none of its value: "ran `ls`" and "edited tokens.js" tell a later session nothing it
 * could not work out faster itself.
 *
 * So this is not a default the panel offers to widen — it is what a session's memory IS.
 * The mechanical detail stays in the store for an agent's own targeted recall (the MCP
 * tools can still ask for it by kind) and out of the thing a person hands to a session.
 */
export const SUBSTANCE_KINDS: MemoryKind[] = ['decision', 'lesson', 'prompt', 'outcome', 'error'];

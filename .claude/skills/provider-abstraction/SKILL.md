---
name: provider-abstraction
description: seshmux AgentProvider seam — Claude Code and Codex session stores, jsonl parsing, ctx calc, spawn/resume commands. Load when touching providers/, scan/transcript/usage parsing, ~/.claude or ~/.codex stores, session listing, codex rollout files, context-window math, or adding a new agent provider.
user-invocable: true
---

# Provider abstraction

Everything agent-specific goes through `AgentProvider` (`server/lib/providers/types.ts`). HARD RULE: no `~/.claude`/`~/.codex` path or agent binary name outside `server/lib/providers/`.

## AgentProvider interface (as built)
`id`, `detect()`, `scanProjects()`, `listSessions(projectId, opts?)`, `parseTranscript(projectId, sessionId)`, `readCtx(projectId, sessionId)`, `search(q, opts?)`, `usage(days)`, `needsInputPatterns: RegExp[]`, `commands: ProviderCommands`.

`ProviderCommands`: `fresh(cwd)`, `continue(cwd)`, `resume(cwd, id)`, `plan?(cwd)` (optional — Claude only), `headlessPlan(cwd, task)`, `headlessAsk(cwd, prompt)` — each returns an argv `string[]`.

Note: the interface has NO `scan()`/`transcript()` method. The `(root, provider)` and `window` params live one layer DOWN in the store functions (`store/scan.ts`, `store/transcript.ts`, `store/usage.ts`, `store/search.ts`) — providers thread them in; the store stays provider-agnostic. `~/.claude` default root + 200k window are set ONLY in `claude.ts`.

## Claude store (`claude.ts`)
`~/.claude/projects/<dash-encoded-cwd>/<uuid>.jsonl`. Default root `~/.claude/projects` (`defaultRoot()`); `CLAUDE_WINDOW = 200_000`; `CLAUDE_BIN='claude'`. Title = first real user message. Branch = last `gitBranch`. Ctx = last assistant `message.usage` (input + cache_creation + cache_read). Resume: `['claude', '--resume=<id>']` — glued with `=` so an id starting with `-` can't be read as a flag.

## Codex store (`codex.ts`)
`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (nested — Codex re-implements its own listing/parse/search inline; borrows only `decodeProjectDir`/`storeBytes` from `store/scan.ts`). Every line `{timestamp, type, payload}`; sub-kind is `payload.type`. Verified field paths — schema-discover against real files before editing:
- `session_meta.payload.cwd` (project group), `.git.branch`, `.session_id`, `.timestamp`.
- title / user msg: `event_msg` + `payload.type='user_message'` → `payload.message`; assistant: `agent_message`.
- model: `turn_context.payload.model`; window: `event_msg`/`task_started`→`payload.model_context_window`.
- ctx tokens: `token_count.payload.info.last_token_usage.total_tokens`; window: `...info.model_context_window`.
- tool calls: `response_item`/`function_call` ↔ `function_call_output` paired by `call_id`.
Constants: `CODEX_BIN='codex'`, `DEFAULT_WINDOW=258_400`. NO plan mode. Continue: `codex resume --last`; Resume: `['codex','resume','--','<id>']` (`--` forces id positional). `usage()` returns zeros (stub — documented `ponytail:` gap).

## Merging
Same repo cwd in both stores = ONE Project whose sessions mix providers; every SessionMeta/Tab carries `provider`. Fixtures: `test/fixtures/` scrubbed real-shaped jsonl; parser tests TDD-first.

---
name: agent-bridge
description: seshmux cross-agent features — handoff briefs, cross-review, shared scratchpad, MCP bridge (ask_codex/ask_claude), plan-off. Load when touching server/lib/bridge/, handoff, review, scratchpad, planoff, MCP server, hop budget, loop guard, approval flow, or linked tab pairs.
user-invocable: true
---

# Agent bridge

Feature code in `server/lib/bridge/` + routes in `server/routes/bridge.ts` (+ `approval.ts`). Every session spawn goes through the injected `startSession` seam bound to `server/session-start.ts` (`startSession`) — the ONE place a PTY is spawned, shared by the term route and all bridge routes.

## Features
- **Handoff / Review** (`brief.ts`): `composeBrief(projectId, sessionId, deps?)` and `composeDiffReview(...)`. Both take injected loaders via `BriefDeps {loadTranscript?, gitDiff?}` (default loaders scan the provider registry / run `git diff HEAD`). `composeBrief` clamps ≤4KB; `composeDiffReview` clamps ≤8KB (`MAX_BYTES*2`). Routes `POST /api/bridge/handoff` + `/review` compose the doc, write it under the repo, and start an opposite-provider session with it as first prompt.
- **Scratchpad**: `<repo>/.seshmux/handoff.md` — both agents read/write; a chokidar watcher emits `{event:'scratchpad', projectId}` to live-refresh the tab.
- **Plan-off** (`planoff.ts`): `POST /api/bridge/planoff` is a **plain blocking request/response POST** — it awaits both agents planning headless read-only and returns the `PlanoffResult` JSON directly. (The events hub has a generic `emit`, and a `{event:'planoff'}` type exists in the `EventMessage` union, but the current route does NOT stream progress events — result comes from the blocking response.) `POST /api/bridge/planoff/pick` seeds an execution session from the winner.

## MCP bridge (`mcp.ts`)
Stdio server (`seshmux mcp-bridge`) exposing `ask_codex` / `ask_claude` — runs the OTHER agent headless read-only in the caller's cwd (binary + flags from `provider.commands.headlessAsk`). `runBridgedCall` order: **(1) hop-guard → (2) approval → (3) spawn.**
- **Hop guard**: `SESHMUX_HOP` env threads the depth; refuses (`BridgeLoopError`) when `incoming >= budget` BEFORE approval and before any spawn. Default budget 10 (`SESHMUX_HOP_BUDGET`).
- **Approval** (default ON): `mcp.ts` → `requestApprovalOverSocket(<configdir>/approval.sock, …)` in `approval-socket.ts`. Protocol = newline-delimited JSON, `v:1`, **fail-closed** (any malformed/EOF/error/timeout → deny; only explicit `approved===true` allows). Server-side `DEFAULT_TIMEOUT_MS=120_000` → deny; client backstop 125s (so server's deny wins). The server listener → `events-hub` `requestApproval` → `broadcast({event:'approval', requestId, tool, question, cwd, hop, expiresAt})` → ApprovalToast → user `POST /api/bridge/approval/:requestId {approved}` → `resolveApproval` (404 if unknown/expired).
- **Argv hardening**: `execFile(bin, args)` (array, no shell); reject prompt/cwd starting with `-` (defense atop the provider's `--` separator); `child.stdin.end()` (codex reads stdin). Binary name comes ONLY from the provider.
- Every exchange appended to `<configdir>/bridge-log.jsonl` (never throws).

## Registry (`registry.ts`)
`POST /api/bridge/register` (explicit button ONLY — never silent) writes GLOBAL agent configs: `mcpServers['seshmux-bridge']` in `~/.claude.json` and `[mcp_servers.seshmux-bridge]` in `~/.codex/config.toml` (command `npx seshmux mcp-bridge`). Idempotent. Not a project `.mcp.json`.

## Tab UX
Bridge tabs are LOCKED pairs (`linked`/`linkedKind`/`linkSrc`) — insert after source, `LinkChip` (⇄ handoff / ⊙ review / ⚖ plan-off), shared accent bar, block-based DnD, never splittable.

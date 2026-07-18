# seshmux

Local-first mission control for AI coding agents (Claude Code + Codex). `npx seshmux` → browser app: browse/search all agent sessions, live embedded terminals, cross-agent bridge. Zero hosting.

## Status
**v1 fully built.** All plan tasks (through Task 19) are done; the 10-item end-to-end acceptance passed 2026-07-09. `docs/local/plans/2026-07-08-seshmux-v1.md` is now a historical execution record, not a to-do list. Follow-up candidates for v1.x live in `docs/local/plans/2026-07-09-cmux-analysis.md`.

**Design source of truth is `styles/tokens.scss`, not `mockup.html`.** The mockup holds four mutually exclusive exploration variants (LEDGER / APERTURE / BASELINE / MERIDIAN) and cannot be a spec; it is kept as a historical artifact. The shipped system is theme (`dark`|`light`) × accent (`teal`|`iris`), both stamped pre-paint by `app/layout.tsx`, default **iris**. Any new color/spacing/radius decision goes in `tokens.scss` — do not "restore" the app to the mockup.

## Architecture as built
Three pieces in one npm package (`bin/seshmux.js` supervises all):
- **seshmuxd daemon** (`daemon/`) — plain Node, zero build, owns every agent PTY. JSON-RPC over unix socket, protocol frozen at 1. Survives server updates.
- **server** (`server/`) — Fastify serves the built Next.js UI + REST + WebSockets bridging xterm.js ↔ daemon. Stateless, safe to restart. `tsx server/index.ts` in dev.
- **UI** (`app/`, `components/`, `lib/client/`) — Next.js 15 App Router + SCSS modules, ported from `mockup.html`.

Sessions from `~/.claude` and `~/.codex` are merged by repo cwd into Projects; every SessionMeta/Tab carries `provider`. Live PTYs run through the daemon so a server update never kills a session.

## Where to change what
- **Session data / parsing / spawn+resume commands** → `server/lib/providers/{claude,codex,types}.ts` (the ONLY place with agent paths/binaries). Store helpers in `server/lib/store/`.
- **PTY lifecycle / update-safety** → `daemon/` (frozen protocol; changes need a migration design).
- **Cross-agent bridge** (handoff/review/scratchpad/plan-off/MCP/approval) → `server/lib/bridge/`, `server/routes/bridge.ts`, `server/routes/approval.ts`.
- **Live events** (status dots, ctx meters, approval, scratchpad refresh) → `server/events-hub.ts` + the `EventMessage` union in `lib/client/ws.ts`.
- **Visual appearance** → `components/ui/` primitives + `styles/tokens.scss` + `styles/typography.scss`. Feature components compose, never redraw.
- **Needs-input detection** → `server/lib/needs-input.ts` (+ provider `needsInputPatterns`). The Claude TUI emits ZERO line feeds — `stripAnsi` reconstructs rows from cursor-moving CSI escapes. Test against real captured output, not hand-written strings with `\n` in them.
- **Worktree finish / merge-keep-discard** → `server/lib/workspaces.ts` (see hard rule 7).
- **Auto-restore / session ledger** → `server/lib/{json-store,live-ledger,ledger-binding,restore}.ts`. Accepted residuals (documented, not bugs): hand-run `claude --resume` outside seshmux can double-attach; a session finishing after clean shutdown (or an unclean server death) can phantom-restore within 48h; a restored agent may pick an in-flight action back up.

## Key seams (touch these deliberately)
- `server/session-start.ts` — ALL PTY session spawning (shared by term + bridge routes).
- `server/events-hub.ts` — events WS + status classify feed + approval + scratchpad watch.
- `server/lib/providers/*` — ONLY place that knows agent paths/binaries.
- `lib/client/ws.ts` `EventMessage` union — add new server→client event types here.
- `styles/typography.scss` + `components/ui/` — all text styling + shared visuals.
- `daemon/` — frozen at protocol 1; changing the wire protocol requires a migration design.

## Stack
- Next.js 15 (App Router, `output: 'standalone'`) + SCSS modules (NO CSS-in-JS/Tailwind)
- Fastify + @fastify/websocket custom server · xterm.js (@xterm/xterm + fit)
- seshmuxd daemon: plain Node JS, zero build step, @homebridge/node-pty-prebuilt-multiarch only
- vitest · chokidar · Node ≥20, npm only

## Commands
- `npm run dev` — dev server on **:4800** (`PORT=4900 npm run dev` to override). NOT 4700: that belongs to the installed `seshmux`, and `bin/seshmux.js` treats a healthy server on its port as "already running" and just opens a browser at it — so a dev server squatting on 4700 silently hijacks the real app (and you end up debugging a stale dev bundle thinking it's the release).
- `npm test` — `lint:styles` gate then `vitest run`
- `npm run lint:styles` — `scripts/lint-styles.sh` (bans raw font props in all `components/**/*.module.scss`, ui/ included)
- `npm run build` — `scripts/build-standalone.sh` (Next standalone) · `npm start` / `node bin/seshmux.js` — full app

## Hard rules
1. Text styled ONLY via `styles/typography.scss` `t-*` mixins; component modules = layout/spacing/state only. `npm run lint:styles` enforces.
2. Shared visuals live in `components/ui/` primitives; feature components compose, never redraw.
3. No `~/.claude`/`~/.codex` path or agent binary name outside `server/lib/providers/`.
4. Update-safety invariant: nothing may kill daemon-owned PTYs during a server update. Daemon protocol is frozen at 1.
5. Never ship Anthropic/OpenAI logo assets — generic glyphs (✳/⬡) + our colors only.
6. Codex work: schema-discover against real `~/.codex/sessions` files first, never guess fields.
7. Workspace finish (`server/lib/workspaces.ts`) is a data-loss path: `git worktree remove` deletes gitignored files even without `--force`. Preserve them to `.seshmux/leftovers/`, never name-match which ones "matter" (a heuristic shipped four consecutive data-loss bugs). A guard on a destructive path fails CLOSED — if git can't answer, refuse.

Domain knowledge: see `.claude/skills/` (style-system, provider-abstraction, daemon-protocol, agent-bridge).

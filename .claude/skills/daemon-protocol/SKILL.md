---
name: daemon-protocol
description: seshmuxd PTY daemon — unix socket JSON-RPC, PTY lifecycle, tmux tier, session-safe updates, relaunch loop. Load when touching daemon/, node-pty, PTY spawn/attach/scrollback, tmux integration, ws terminal bridge, update/self-update flow, or anything that could kill a live session.
user-invocable: true
---

# Daemon + update safety

seshmuxd: plain Node JS in `daemon/`, zero build, only dep = `@homebridge/node-pty-prebuilt-multiarch`. NEVER import server/UI code. Config dir = `SESHMUX_CONFIG_DIR || ~/.config/seshmux`; socket + pidfile + spawnlock all derive from it (`seshmuxd.sock` / `.pid` / `.spawnlock`).

## Protocol (`daemon/protocol.js`, FROZEN at 1)
NDJSON over the unix socket, both directions. Exports: `PROTOCOL=1`, `TMUX_PREFIX='seshmux-'`, `RING_BUFFER_LINES=5000`, `encode(msg)`, `createDecoder()`. **The server COPIES this framing into `server/daemon-client.ts` — it never imports `daemon/`** (keep the two in sync).
- RPC: `hello` · `spawn({cwd,args,cols,rows,tmuxName?})` · `attach({ptyId,fromScrollback?})` · `write` · `resize` · `kill` · `list` · `shutdown({force?})`.
- Events (pushed, no id): `{event:'data',ptyId,data}`, `{event:'exit',ptyId,code}`.
- 5000-line ring buffer per PTY for reattach replay.
- **attach = subscribe**: `attach` adds the socket to subscribers AND (unless `fromScrollback:false`) replays the scrollback snapshot synchronously in the same tick — nothing dropped in the gap. **spawn does NOT auto-subscribe** — you must attach.
- **tmux bare-name rule**: callers pass a BARE name; the daemon forms `seshmux-<name>`. On startup the daemon rehydrates surviving tmux sessions filtered on that prefix. `shutdown` refuses while PTYs alive unless `{force:true}`.

## Spawn / recovery (`daemon/ensure.js` — SOLE spawn+recovery path)
`server/daemon-client.ts` never spawns/kills; only `ensure.js` does. `classify(facts)` → `ok|wait|stale|spawn`: `ok`=dial succeeds; `spawn`=no socket; `wait`=socket + dead dial but pid alive (peer starting, retry); `stale`=socket + dead dial + dead/absent pid → unlink socket + spawn. Spawnlock = `mkdir` lock, broken if mtime age > 60s (SIGKILLed-launcher deadlock guard). Daemon spawned detached + `stdio:'ignore'` + `unref()` so it outlives the launcher (update-safety mechanism).

**Gotcha (unhandled)**: macOS caps unix socket paths at ~104 bytes (`sun_path`). The default config dir is short, but a long `SESHMUX_CONFIG_DIR` could overflow it and `listen()` would fail with no special handling. Keep the config dir short.

## Update-safety invariant (the product promise)
Updates restart the SERVER ONLY. `bin/seshmux.js` is the supervisor: on child exit code `75` it relaunches the server, reusing the SAME auth token every iteration (rotating would 401 the auto-reconnecting browser WS). Crash-loop guard: >3 restarts within 60s → print rollback instructions + `exit(1)`. seshmuxd, PTYs, scrollback, and tmux sessions run through the update untouched. NEVER write a code path that kills daemon PTYs during update.

## Server ↔ daemon (`server/events-hub.ts`)
ONE persistent "monitor" connection receives every PTY's data/exit for needs-input classification (attaches with `fromScrollback:false` — live output only). On monitor close it re-dials and re-attaches all alive PTYs after 500ms, adopting sessions that survived a server restart. Terminal I/O uses separate per-PTY `/ws/term` sockets.

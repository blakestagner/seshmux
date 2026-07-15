# seshmux — Development Handoff

Read this first. It replaces the pre-build handoff (which opened with "nothing has been coded yet" — true in July 2026, now badly out of date).

**Status: shipped.** `seshmux` is published on npm and installs clean on a fresh machine. `main` is green on CI (ubuntu + macOS × node 20/22), 751 tests.

---

## Where things are

| | |
| --- | --- |
| npm | `seshmux` — published, latest **0.1.7** |
| `main` | version **0.1.7**, CI green |
| Tests | 751 passing as of 2026-07-15 (`npm test` = lint:styles gate, then vitest) |
| CI | `.github/workflows/ci.yml` — ubuntu + macOS × node 20/22. Installs tmux, because the daemon's tmux-tier tests **silently SKIP** without it (a CI that gates on nothing looks green). |

### Shipped since 0.1.5 (on main, in 0.1.7)

- `seshmux update` CLI updater.
- **Grid workspace** (PR #21) — multi-terminal grid view; handoff notes in `docs/local/handoffs/`.
- **Customizations authoring** (PR #23) — create/edit skills & agents from the modal, Polish + Make-it-for-me.
- **Marketplace** (PR #24) — browse/install community skills, agents, plugins; `claude plugin` CLI behind the `pluginCommands` provider seam; worktree folding (`.claude/worktrees/*` sessions fold into parent project).
- Dev server is `tsx watch` now — server edits hot-restart, no manual bounce.

Queued next: marketplace safety verification — spec at `docs/superpowers/specs/2026-07-15-marketplace-safety-design.md`.

Publishing is manual (`npm publish` from `main`) using the granular npm token in `~/.npmrc` (account has 2FA; the token bypasses it).

---

## Architecture (as built)

Three pieces, one npm package. `bin/seshmux.js` supervises everything.

```
bin/seshmux.js      supervisor: daemon lifecycle, port, auth token, relaunch loop, self-update
  ├─ seshmuxd       daemon/ — owns every session. Plain Node, zero build. Protocol FROZEN at 1.
  │    ├─ holder    daemon/holder.js — one per non-tmux session; OWNS the PTY (see below)
  │    └─ tmux tier `tmux attach-session` as the PTY, rehydrated from `tmux ls`
  └─ server         server/ — Fastify + built Next UI. Stateless. Safe to kill/restart/update.
```

### The invariant everything else serves

**Nothing may kill a live agent session.** The server is disposable, the daemon is not, and the *sessions* are sacred.

- **Server** restart/update → sessions untouched (the daemon owns them).
- **Daemon** restart/crash/upgrade → sessions untouched, because the daemon **does not own the PTY**. A holder (or tmux) does.

That second half is new. Before it, a machine without tmux had sessions living *inside* the daemon that died with it — and a real user lost every running agent to exactly that.

### Holders (`daemon/holder.js`) — read before touching the daemon

```
  daemon  (restartable, owns nothing)
    │  unix socket
    └─ holder  (detached, setsid, SIGHUP ignored — survives everything)
         └─ pty (claude)   ← the session lives HERE
```

- The holder owns the PTY, keeps a byte-capped ring buffer, and accepts exactly one client.
- The daemon is a **client**. On startup, `rehydrateHolders()` scans `<configDir>/holders/*.json`, checks pid liveness, reconnects, and re-registers under the **original ptyId**. ID stability is load-bearing: the server and browser hold ptyIds.
- A second client on one holder is refused (`busy`) — no double-attach.
- The holder cleans up its socket + json on PTY exit (short grace once a client has learned the exit code, long grace otherwise so a reconnecting daemon can still get it).
- Verified by `kill -9` on the daemon: holder and PTY survive, a fresh daemon re-adopts them, and output produced while no daemon existed is replayed on reattach.

**What still does NOT survive:** a machine reboot, or `kill -9` on a holder itself. That's the same bar tmux sets.

### tmux is optional now

It buys `tmux attach` from a plain terminal and deep `capture-pane` scrollback (the `history` RPC). It is **not** what durability rests on. First run without tmux explains the consequence and offers to install it (`offerTmux()` in `bin/seshmux.js`); declining is remembered.

---

## Self-update (where the real bugs lived)

The button installs the package, the server exits 75, the supervisor relaunches it, and the **daemon upgrades itself** — but only when `canSafelyRestartDaemon()` proves nothing dies. If something would die, it **defers and retries every 60s** until it's safe (`scheduleDaemonUpgrade`). No command to type, nothing lost.

Five bugs lived in this path. **Every one was invisible to a green test suite** and only appeared when a real user ran a real install. Re-read these before touching it:

1. **The published tarball could ship an incomplete dependency closure.** `build-standalone.sh` built on top of a dirty `.next` and called itself idempotent. Two `npm pack` runs on the *same commit* produced 1,952 and 14,034 files. The lean one installs fine and then dies at boot on `MODULE_NOT_FOUND`. Fixed with `rm -rf .next` first. **Never publish from a dirty tree.**
2. **Version read as `0.0.0` for every real user.** It came from `$npm_package_version`, which npm sets only under `npm run …` — never for `npx seshmux` or the global bin.
3. **A global install classified as `local`**, which hides the update button entirely. `detectInstallMethod` realpath'd argv but not `npm prefix -g`, so any symlinked prefix (macOS `/tmp`, homebrew `/usr/local`) missed.
4. **The button announced releases it couldn't install.** `npm i -g seshmux@latest` re-resolves that tag through npm's **cached packument** → `ETARGET`. **Always pin the exact version the check resolved, with `--prefer-online`.**
5. **After updating, the app reported the old version forever.** `require('../package.json')` caches, and the supervisor deliberately outlives updates. Use `readFileSync`.

---

## Hard rules that actually bite

(`CLAUDE.md` has the full list.)

1. Daemon protocol **frozen at 1**. Holders are an *internal* daemon↔holder link; the daemon↔server wire never changed.
2. Nothing may kill daemon-owned PTYs during an update.
3. No `~/.claude` / `~/.codex` paths or agent binary names outside `server/lib/providers/`.
4. Text styled ONLY via `styles/typography.scss` `t-*` mixins (`npm run lint:styles` enforces).
5. **Workspace finish (`server/lib/workspaces.ts`) is a data-loss path.** `git worktree remove` deletes gitignored files even without `--force`. Preserve them to `.seshmux/leftovers/`; **never name-match which files "matter"** — that heuristic shipped four consecutive data-loss bugs (`.env`, `dev.sqlite`, `terraform.tfstate`, a Firebase service-account key).
6. Codex work: schema-discover against real `~/.codex/sessions` files. Never guess fields.
7. **Dev server runs on :4800.** 4700 belongs to the installed app, and `bin/seshmux.js` treats a healthy server on its port as "already running" and just opens a browser at it — so a dev server on 4700 **silently impersonates the real app**. This cost hours: a stale dev bundle was mistaken for a broken release.

---

## Known gaps (written down so they aren't rediscovered)

- **Flaky suite — events-hub part FIXED 2026-07-15.** The hook-timing flakes were write→sleep(300ms)→assert races (two stacked: a chunk written before the monitor attached was lost forever, and the async hook-read classify could outrun the sleep on loaded CI). Replaced with condition-based waiting + a re-writing probe (`writeUntil` in `test/server/events-hub.test.ts`); conditions key on `getStatusExplain` because attachPty's `'working'` seed makes bare status broadcasts a false signal. Still open: `EMFILE` from the file watcher under parallel load (fd exhaustion, likely). Not chased.
- **Daemon fan-out.** `attach` subscribes the *socket*, and the daemon writes **every** PTY's output to **every** subscribed client; the ptyId filter lives in the client. Correct but wasteful with many sessions. (An old test asserted otherwise — that guarantee never existed; it passed by winning a race.)
- **Pre-holder sessions.** Anyone on ≤0.1.4 with a running plain PTY still has a fragile session. The update defers rather than killing it, so it heals once that session ends.
- **`mockup.html` is retired** as a design reference — it holds four mutually exclusive variants and cannot be a spec. Source of truth is `styles/tokens.scss`: theme (dark|light) × accent (teal|iris), default **iris**.
- **No release automation.** Publishing is manual: bump on a branch, merge, `npm publish` from `main`.

---

## How to work on this

```bash
npm run dev          # :4800 (NOT 4700 — hard rule 7)
npm test             # lint:styles gate + vitest
npx tsc --noEmit     # run it; it has caught callers the tests missed
```

**Test against reality, not mocks.** Every serious bug here survived a green suite and died the moment something real touched it:

- The tmux-tier test raced its own pane teardown — deterministic on Linux, flaky on macOS. **CI on a second OS found it.**
- Concurrent workspace creates rejected under `git worktree add`'s locks: 4 concurrent creates, one rejection, every run **on Linux**, never on macOS.
- The entire self-update saga needed **two real published versions and a real button press** to surface.
- `tsc` caught a third caller of a changed function that 565 passing tests did not.

When a change's failure mode is *data loss* rather than degradation, attack it: `kill -9` it, restart it twice, check for orphans. A passing test is not proof.

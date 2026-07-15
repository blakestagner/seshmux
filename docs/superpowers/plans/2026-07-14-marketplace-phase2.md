# Marketplace (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browse + install community skills/agents from GitHub repos, and list/install Claude Code plugins from configured marketplaces — inside the existing Customizations modal.

**Architecture:** New `server/routes/marketplace.ts` with injectable fetch/exec seams (hermetic tests). Community installs write through the SAME containment guard as authoring — extracted first into a shared helper. Claude-plugin CLI knowledge lives on the claude provider (hard rule 3). UI is a new `Marketplace` nav section in `CustomizationsModal` with two segments.

**Tech Stack:** Fastify, Node fetch (Node ≥20), execFile, existing ui primitives (Segmented, OptionRow, Button, ui/Menu).

**Spec:** `docs/superpowers/specs/2026-07-14-skills-agents-authoring-design.md` (Phase 2 section governs).

**Discovered CLI facts (probed live 2026-07-14, claude CLI on this machine — do NOT re-guess):**
- `claude plugin list --available --json` → JSON incl. available plugins from marketplaces
- `claude plugin marketplace list --json` → `[{ name, source, repo, installLocation }]`
- `claude plugin install <plugin>[@marketplace] -s user|project|local` (also `--config key=val`)

## Global Constraints

- Hard rule 1: text via `t-*` mixins only (`npm run lint:styles` gates `npm test`).
- Hard rule 2: compose `components/ui/` primitives (Segmented for the two-tab switch, OptionRow for lists, useDropdown for any menus).
- Hard rule 3: `claude` binary/argv knowledge ONLY in `server/lib/providers/claude.ts`.
- Hard rule 5: no vendor logos — glyphs only.
- Installs are user-initiated with a file-list + content preview first; seshmux never executes marketplace content.
- All disk writes go through the shared containment guard (fail closed); name whitelist `[a-z0-9-]{1,64}`; 256KB per-file cap.
- GitHub fetches: server-side, unauthenticated, in-memory cache ~15 min; graceful 502 on rate-limit/network failure.
- Node 22.22.3 for tests (`nvm use 22.22.3`); commit with pathspec; commit messages end with the Claude trailer used on this branch.

---

### Task 1: Extract shared containment guard

**Files:**
- Create: `server/lib/fs-guard.ts`
- Modify: `server/routes/customizations.ts` (PUT handler uses the helper)
- Test: existing `test/routes/routes-customizations-write.test.ts` must stay green unchanged; add `test/server/fs-guard.test.ts`

**Interfaces:**
- Produces: `writeWithinRepo(repoPath: string, target: string, content: string): Promise<void>` — throws `new FsGuardError('target escapes project')` (exported class, `statusCode = 400`) on: symlinked leaf (lstat), any existing ancestor realpathing outside `realpath(repoPath)`, or fs errors during the check (fail closed). On success: `mkdir -p dirname(target)` then `writeFile`. Move the exact logic (including the ponytail TOCTOU comment and leaf-first walk) from the PUT handler — this is a refactor, not a rewrite.

- [ ] Step 1: Write `test/server/fs-guard.test.ts` — port the PUT route's guard cases against the helper directly: normal write, traversal ancestor symlink, existing leaf symlink, dangling leaf symlink (expect FsGuardError + outside file untouched). Run — FAIL (module missing).
- [ ] Step 2: Create `server/lib/fs-guard.ts` by lifting the guard block out of `server/routes/customizations.ts`; PUT handler becomes: validate inputs → resolve target via provider seam → `await writeWithinRepo(repoPath, target, content)` in try/catch mapping FsGuardError to 400 with its message, other errors to 400 `'write failed'`.
- [ ] Step 3: Run `test/server/fs-guard.test.ts` + both routes-customizations test files — all green. `npx tsc --noEmit` clean.
- [ ] Step 4: Commit `refactor(server): extract writeWithinRepo containment guard`.

---

### Task 2: Community browse + item endpoints

**Files:**
- Create: `server/routes/marketplace.ts`
- Modify: `server/index.ts` (register route — mirror how customizations is registered)
- Test: `test/routes/routes-marketplace-browse.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/marketplace/browse?source=<owner/repo>` → `{ items: [{ path, name, description, section: 'skills' | 'agents' }] }` | 400 bad source | 502 fetch failure
  - `GET /api/marketplace/item?source=<owner/repo>&path=<dir>` → `{ files: [{ path, content }] }` (each content capped 256KB, ≤20 files) — the install preview
  - `GET /api/marketplace/sources` → `{ sources: string[] }` (defaults + user-added)
  - Route opts (injectable): `fetchText?: (url: string) => Promise<string>`, `readSettings?: () => Promise<Record<string, unknown>>`
- Source format: strict `^[\w.-]+/[\w.-]+$` (owner/repo) — reject anything else (no URLs in v1; the UI adds bare owner/repo strings).
- Defaults: `['anthropics/skills']`. User sources come from config `settings.marketplaceSources` (string[]) via the existing config store (`server/routes/config.ts` persistence — read it the same way, injectable for tests).
- GitHub calls: `https://api.github.com/repos/<o>/<r>/git/trees/HEAD?recursive=1` (items = dirs containing `SKILL.md` → section 'skills'; top-level `agents/*.md` files → section 'agents'); raw file fetch `https://raw.githubusercontent.com/<o>/<r>/HEAD/<path>`. Descriptions parsed from SKILL.md frontmatter via the existing `parseFrontmatter` export (`server/lib/providers/customizations.ts` — server-side, importable here).
- Cache: module-level `Map<string, { at: number; value: unknown }>`, TTL 15 min, keyed by URL. Promise-cached (store the promise) so concurrent requests share one fetch.

- [ ] Step 1: Write tests with injected `fetchText` returning canned GitHub tree JSON + raw SKILL.md bodies: browse lists skills+agents with parsed descriptions; bad source 400; fetch throw → 502; item endpoint returns files with contents; oversized file content → 400; sources endpoint merges defaults + injected settings. Run — FAIL.
- [ ] Step 2: Implement the route. Keep GitHub URL construction in this one file. `defaultFetchText` uses global fetch with a 10s AbortSignal timeout and `User-Agent: seshmux` header; non-2xx → throw with status in message.
- [ ] Step 3: Tests green; tsc clean.
- [ ] Step 4: Commit `feat(marketplace): community browse/item/sources endpoints`.

---

### Task 3: Community install endpoint

**Files:**
- Modify: `server/routes/marketplace.ts`
- Test: `test/routes/routes-marketplace-install.test.ts`

**Interfaces:**
- Consumes: `writeWithinRepo` (Task 1), `customizationWriteTarget` provider seam, `scannedResolveRepo`-style project gate (import the same resolver customizations.ts uses — export it from there if private).
- Produces: `POST /api/marketplace/install` body `{ projectId, source, path, section: 'skills' | 'agents', name }` → `{ ok: true, filePaths: string[] }` | 400/404/502.
- Behavior: re-fetch the item's files server-side (never trust client-supplied contents), validate name whitelist, resolve each target under the provider seam (skills: `<skilldir>/<file relative>`, agents: single file), stamp `source: <owner/repo>` into SKILL.md frontmatter meta if a frontmatter block exists (append line before closing `---`), write ALL files via `writeWithinRepo` into a temp sibling dir first then rename into place — a failed multi-file install leaves nothing behind.
- Multi-file skills: files keep their relative layout under `.claude/skills/<name>/`; reject any file whose relative path contains `..` or an absolute component (belt over the guard's suspenders).

- [ ] Step 1: Tests (injected fetchText): successful single-file agent install; multi-file skill install lands all files under the skill dir with `source:` stamped; unknown project 404; bad name 400; file with `../` relpath 400 and nothing written; fetch failure mid-set → 502 and nothing written (temp-dir rename semantics).
- [ ] Step 2: Implement. Reuse Task 2's cache/fetch seams.
- [ ] Step 3: Tests green (plus Task 2 file), tsc clean.
- [ ] Step 4: Commit `feat(marketplace): guarded community install`.

---

### Task 4: Claude plugin marketplace (provider seam + endpoints)

**Files:**
- Modify: `server/lib/providers/types.ts`, `server/lib/providers/claude.ts`
- Modify: `server/routes/marketplace.ts`
- Test: `test/routes/routes-marketplace-plugins.test.ts`, extend `test/providers/customizations-write-target.test.ts`-style provider test with a new small file `test/providers/plugin-commands.test.ts`

**Interfaces:**
- Produces on `AgentProvider` (optional): `pluginCommands?: { listAvailable(): string[]; listMarketplaces(): string[]; install(plugin: string, scope: 'user' | 'project'): string[] }`.
- Claude impl (argv only — verified CLI surface above):
  - `listAvailable: () => [CLAUDE_BIN, 'plugin', 'list', '--available', '--json']`
  - `listMarketplaces: () => [CLAUDE_BIN, 'plugin', 'marketplace', 'list', '--json']`
  - `install: (plugin, scope) => [CLAUDE_BIN, 'plugin', 'install', '--', plugin, '-s', scope]` — NOTE: verify `--` placement against the real CLI before shipping (probe `claude plugin install -- --help` behavior); if `--` is unsupported before the positional, validate `plugin` against `^[\w@/.-]+$` instead and drop `--`.
- Route endpoints (exec via an injectable `runArgv?: (argv: string[], cwd: string) => Promise<{ text: string; ok: boolean }>` — same shape as customizations' `runHeadless`; default execFile 60s/4MB):
  - `GET /api/marketplace/plugins?projectId=…` → `{ supported: boolean, plugins?: unknown[], marketplaces?: unknown[] }` — runs listAvailable + listMarketplaces (parallel), parses JSON; ANY failure (spawn error, non-JSON) → `{ supported: false }` (probe result, not an error status).
  - `POST /api/marketplace/plugins/install` body `{ projectId, plugin, scope }` → `{ ok: true, output }` | 502 with the CLI's output text. Validate `plugin` `^[A-Za-z0-9@/._-]{1,128}$`, scope `user|project`.

- [ ] Step 1: Provider test (argv shapes) + route tests (mock runArgv: happy JSON, non-JSON → supported:false, install failure → 502, bad plugin name → 400). Run — FAIL.
- [ ] Step 2: Implement seam + endpoints.
- [ ] Step 3: Tests green, tsc clean. Manually run `GET /api/marketplace/plugins` against the dev server once to confirm real-CLI parse (report output in the task report).
- [ ] Step 4: Commit `feat(marketplace): claude plugin list/install via provider seam`.

---

### Task 5: Marketplace UI section

**Files:**
- Modify: `components/CustomizationsModal/CustomizationsModal.tsx` + `.module.scss`
- Modify: `lib/client/api.ts` (client fns for the five endpoints)

**Interfaces:**
- Consumes: Tasks 2–4 endpoints; `Segmented` (`components/ui/Segmented`), `OptionRow`, `Button`, existing detail/preview patterns in the modal.
- Produces: new NAV entry `{ key: 'marketplace', label: 'Marketplace' }` (before Projects). Section body:
  - Top: `Segmented` with `Skills & Agents` | `Plugins`.
  - **Skills & Agents segment:** source picker row (dropdown via useDropdown listing sources + an "Add source…" inline TextInput that PUTs `settings.marketplaceSources` through the existing config client fn — check `lib/client/api.ts` for how config saves) → item list (OptionRow: glyph ✦/◈, name, description, source suffix) → clicking opens a PREVIEW panel: file list + first file's content rendered via `.markdown`/`.pre` styles, with `Install to <project>` (primary, only when modal is project-scoped) and Back. Install success → refetch the customizations list (bump reloadKey) and show the item with its `source:` meta.
  - **Plugins segment:** on first open call `getMarketplacePlugins(projectId)`; `supported: false` → the section-note style message "claude plugin marketplace not supported by this claude version". Otherwise list marketplaces (meta line) and available plugins (OptionRow; installed ones marked with a ✓ chip using the existing scope-chip styles) with an Install button per row (scope: 'user' default; project scope offered via a small useDropdown menu). Busy/error inline, same patterns as the editor pane.
- Loading/error states mirror the existing section patterns (`.empty`, inline error text). No new raw font props; compose existing chips/menus.

- [ ] Step 1: Client API fns (5): `getMarketplaceSources`, `addMarketplaceSource` (via config settings update), `browseMarketplace(source)`, `getMarketplaceItem(source, path)`, `installMarketplaceItem(body)`, `getMarketplacePlugins(projectId)`, `installMarketplacePlugin(body)`.
- [ ] Step 2: Build the section per above.
- [ ] Step 3: `npx tsc --noEmit`, `npm run lint:styles`, `npm test` green.
- [ ] Step 4: Commit `feat(marketplace): modal section — community browse/install + plugins`.

---

### Task 6: Smoke + guardian pass

- [ ] Step 1: `PORT=4900 npm run dev`; browser-agent smoke (standalone Playwright script — no MCP): open project Customizations → Marketplace → browse anthropics/skills (LIVE GitHub fetch — if rate-limited/offline, report and fall back to asserting the error renders gracefully), open an item preview, screenshot. Do NOT click Install against the real repo unless the target is the seshmux project and the item is small — installing one small skill and verifying it appears in Skills with a `source:` meta is the ideal end-to-end proof; delete the installed dir afterwards and note it.
- [ ] Step 2: Plugins segment: verify it lists real marketplaces/plugins from the local CLI (this machine has two marketplaces configured) or shows the unsupported note. Do NOT install a plugin.
- [ ] Step 3: style-guardian on the branch diff; provider-auditor too (new provider surface). Fix findings.
- [ ] Step 4: Full `npm test` + tsc; commit fixes.

## Self-review notes

- Spec coverage: curated + user-added sources (T2), GitHub browse with frontmatter descriptions (T2), install through the SAME validated write path (T1+T3), source badge via `source:` frontmatter stamp (T3), plugin CLI list/install behind provider + probe-don't-guess (T4), preview-before-install + never-execute trust model (T3/T5), 15-min cache (T2).
- Deliberate v1 cuts: no marketplace search box (lists are short; add when a source exceeds a screen), no update/uninstall flows, sources are owner/repo only (no arbitrary URLs), plugin `--config` passthrough omitted. All fit follow-ups.
- Types consistent: `section: 'skills' | 'agents'` matches phase 1; exec seam shape `{ text, ok }` matches `runHeadless`.

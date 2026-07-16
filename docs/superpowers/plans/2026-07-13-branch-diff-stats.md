# Branch Diff Stats + Changes Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `+N/-N` line stats in every terminal statusbar (vs merge-base with the default branch, uncommitted + untracked included), click opens a right-pane file tree with changes highlighted.

**Architecture:** One read-only REST endpoint (`GET /api/git/changes`) backed by `server/lib/git-stats.ts` (reuses the exported `git()` helper from `workspaces.ts`). Client: a polled chip in `TerminalPane`'s statusbar (10s, mounted panes only — mounting == visible in this app, so tab switch = fresh fetch for free) and a `ChangesPanel` sharing the existing right-pane split slot in `app/page.tsx` with SubagentViewer/TeamPanel.

**Tech Stack:** Fastify route, execFile git, React + SCSS modules, vitest.

## Global Constraints

- Text styled only via `t-*` mixins from `styles/typography.scss`; colors from `styles/tokens.scss` tokens (`npm run lint:styles` gates `npm test`).
- No agent paths outside `server/lib/providers/` (untouched here).
- Endpoint is read-only git; never touches the workspace-finish path.
- Failure mode: unresolvable repo/branch/git error → zeros/empty, never a 500 to the bar.
- Commit with pathspec (`git commit -- <paths>`), other agents share this tree.

---

### Task 1: server/lib/git-stats.ts (+ export git() and defaultBranch() from workspaces.ts)

**Files:**
- Modify: `server/lib/workspaces.ts:110` (`async function git` → `export async function git`), `:218` (`async function defaultBranch` → `export async function defaultBranch`)
- Create: `server/lib/git-stats.ts`
- Test: `test/server/git-stats.test.ts`

**Interfaces:**
- Produces: `type FileChange = { path: string; added: number; removed: number; status: string }`, `type GitChanges = { added: number; removed: number; files: FileChange[]; tree?: string[] }`, `parseNumstat(out: string): {path,added,removed}[]`, `changes(dir: string, baseRef: string | null, wantTree: boolean): Promise<GitChanges>`

Behavior of `changes(dir, baseRef, wantTree)`:
1. `base = baseRef ? (git merge-base <baseRef> HEAD).trim() : null`; merge-base failure (unborn HEAD, unknown ref) → `base = null`.
2. Tracked diff: `git diff --numstat <base ?? 'HEAD'>`; parse lines `added\tremoved\tpath` (`-` for binary → 0). Statuses from `git diff --name-status <base ?? 'HEAD'>` joined by path (default `M`).
3. Untracked: `git ls-files -o --exclude-standard` → each file counted as additions (read file, count `\n`+1 for nonempty tail; unreadable/`\0`-containing first 8KB (binary) → 0 lines but still listed), status `A`.
4. `wantTree` → `tree = git ls-files` + untracked paths (sorted, deduped).
5. Any git failure at the top level → `{ added: 0, removed: 0, files: [] }`.

- [ ] Write failing tests in `test/server/git-stats.test.ts`: `parseNumstat` unit cases (normal, binary `-`, empty) + an integration case building a throwaway git repo in `mkdtemp` (init, commit base, branch, commit a change, dirty a file, add untracked) asserting totals/files/tree.
- [ ] `npx vitest run test/server/git-stats.test.ts` → FAIL (module missing)
- [ ] Implement `server/lib/git-stats.ts`; export `git`/`defaultBranch` from workspaces.ts
- [ ] `npx vitest run test/server/git-stats.test.ts` → PASS
- [ ] Commit: `feat: git line-stat lib (numstat vs merge-base + untracked)`

### Task 2: route GET /api/git/changes + registration + client api

**Files:**
- Create: `server/routes/git.ts`
- Modify: `server/index.ts:148` (register after workspaces), `lib/client/api.ts` (append)
- Test: `test/routes/git.test.ts`

**Interfaces:**
- Consumes: `changes`, `defaultBranch` (Task 1); `workspaces.list(repo)`; resolveRepo pattern copied from `server/routes/workspaces.ts:43-51` (injectable dep for tests, same shape).
- Produces: `GET /api/git/changes?project=<id>&branch=<b>&tree=1` → `GitChanges` JSON; client `getGitChanges(projectId: string, branch?: string | null, tree?: boolean): Promise<GitChanges>` exported from `lib/client/api.ts` (re-export the `GitChanges`/`FileChange` types).

Route logic: 400 without `project`; resolve repo (404 if unresolvable); `dir = repo`, but if `branch` starts with `agent/` and a workspace record matches, `dir = record.dir`; `base = await defaultBranch(repo)` (catch → null); return `changes(dir, base, tree === '1')`.

- [ ] Write failing test `test/routes/git.test.ts` (fastify inject, injected resolveRepo → a temp repo fixture; assert 200 shape, 400, 404, and zeros-on-non-repo)
- [ ] `npx vitest run test/routes/git.test.ts` → FAIL
- [ ] Implement route, register in `server/index.ts`, add `getGitChanges` to `lib/client/api.ts`
- [ ] `npx vitest run test/routes/git.test.ts` → PASS
- [ ] Commit: `feat: /api/git/changes route + client fetcher`

### Task 3: statusbar chip in TerminalPane

**Files:**
- Modify: `components/TerminalPane.tsx` (new poll effect near the workspace-chip effect ~`:383`; chip rendered in the statusbar after `bridgeActions` ~`:601`; new prop `onOpenChanges?: () => void`), `components/TerminalPane.module.scss` (`.diffChip`, `.diffAdded`, `.diffRemoved` — layout/color only, colors via `var(--ok)`/`var(--danger)`-style tokens from tokens.scss; verify exact token names before use)

**Interfaces:**
- Consumes: `getGitChanges` (Task 2), existing `Button variant="chip"`.
- Produces: `onOpenChanges` prop consumed by Task 4.

Poll effect: gated on `projectId`; fetch on mount + `setInterval` 10s (totals only, no `tree`); cleanup on unmount. Mounted == visible (tabs view renders only the active pane; grid renders all tiles), so tab-switch freshness is the mount fetch. Render when `stats && (stats.added > 0 || stats.removed > 0)`: in default variant a chip `Button` (`+{added}` green, `−{removed}` red) calling `onOpenChanges`; in grid variant a plain non-clickable span. Best-effort: fetch errors keep last value, never break the bar.

- [ ] Add prop + effect + chip + scss
- [ ] `npm run lint:styles` → PASS; `npx tsc --noEmit` → clean
- [ ] Commit: `feat: +N/-N diff chip in terminal statusbar`

### Task 4: ChangesPanel + tree helpers + page.tsx wiring

**Files:**
- Create: `lib/client/git-tree.ts`, `components/ChangesPanel.tsx`, `components/ChangesPanel.module.scss`
- Modify: `app/page.tsx` (state `openChangesFor`, exclusive open/close handlers ~`:436-443`, `onOpenChanges` passed in `renderPane` ~`:481`, third right-pane branch in the conditional ~`:622-669`)
- Test: `test/client/git-tree.test.ts`

**Interfaces:**
- Consumes: `getGitChanges(projectId, branch, true)`; split-slot pattern (`styles.splitHandle`, `styles.splitSideRight`, `viewerDrag`, `VIEWER_MIN`) exactly as the `viewerOpen` branch.
- Produces: `buildTree(tree: string[], files: FileChange[]): TreeNode[]` where `TreeNode = { path: string; name: string; children: TreeNode[]; change?: FileChange }` (dirs first, alpha); `collapsedByDefault(nodes: TreeNode[]): Set<string>` = every dir path whose subtree contains NO change; `<ChangesPanel projectId branch onClose />`.

ChangesPanel: header (`changes · {branch}` + totals + close IconButton), fetches on mount + 10s interval, seeds collapsed set from `collapsedByDefault` on first load only (SubagentViewer's `seededRef` pattern), recursive rows (indent `12 + depth*16`, ▸/▾ toggle for dirs, changed files highlighted + per-file `+a −r`), read-only.

- [ ] Write failing `test/client/git-tree.test.ts` (nesting, dirs-first sort, change attachment, collapsed-set excludes ancestor dirs of changes)
- [ ] `npx vitest run test/client/git-tree.test.ts` → FAIL, implement `lib/client/git-tree.ts`, → PASS
- [ ] Implement ChangesPanel + scss + page.tsx wiring (mutual exclusivity with team/viewer both directions)
- [ ] `npm run lint:styles` && `npx tsc --noEmit` → clean
- [ ] Commit: `feat: changes panel — file tree with branch diff highlights`

### Task 5: verify end-to-end + PR

- [ ] `npm test` (full suite; known flake: events-hub hook-timing — rerun once if that specific test fails)
- [ ] `npx tsc --noEmit`
- [ ] Live check on the dev server (:4800): open a session tab in a repo with changes, confirm chip within 10s, click → panel, tree expansion/highlights, grid view shows plain stats
- [ ] Branch + PR via the create-pr subagent (memory rule: never inline)

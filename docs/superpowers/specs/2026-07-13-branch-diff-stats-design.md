# Branch diff stats + changes panel — design

**Date:** 2026-07-13 · **Status:** approved

## What

Two connected pieces:

1. **Diff-stat chip** in every terminal pane's bottom statusbar: `+N` (green) / `-N` (red) line counts for that tab's branch.
2. **Changes panel**: clicking the chip opens a right-hand split panel showing the repo's file tree, collapsed by default, auto-expanded along paths that contain changes, with changed files highlighted and carrying their own per-file `+N/-N`.

## What counts as "changed"

Everything not in the base branch (option A): committed work on the branch **plus** uncommitted edits, diffed against the merge-base with the repo's default branch. Untracked files count as additions. For a plain tab sitting on the default branch this degrades to uncommitted changes only. Resolution: `git merge-base <default> HEAD`, then `git diff --numstat <merge-base>` + `git ls-files -o --exclude-standard` with line counts.

## Server

New endpoint `GET /api/git/changes?project=<id>&branch=<b>[&tree=1]` in `server/routes/git.ts`, logic in `server/lib/git-stats.ts`.

- Reuses the `git()` execFile helper from `server/lib/workspaces.ts` (export it) and the project→repo-dir resolution already used by `server/routes/workspaces.ts`.
- Directory selection: if `branch` matches an `agent/*` workspace record, diff runs in that worktree's dir; otherwise in the project path itself (whatever its current HEAD is — the `branch` param is advisory there).
- Response:
  ```json
  {
    "added": 1232,
    "removed": 87,
    "files": [{ "path": "server/foo.ts", "added": 12, "removed": 3, "status": "M" }],
    "tree": ["..."]
  }
  ```
  `tree` (full `git ls-files` listing, plus untracked) is included only when `tree=1` — the statusbar poll never pays for it.
- Failure mode: unresolvable repo/branch, binary files, detached HEAD → return zeros / omit, never 500. The bar shows nothing rather than erroring.
- Read-only git commands only. Nothing touches the workspace-finish path in `workspaces.ts`.

## Client

**Statusbar chip** (`components/TerminalPane.tsx`, existing statusbar at ~`:545`):
- Renders `+N`/`-N` using success/danger tokens; hidden when both are 0 or repo unresolved.
- Polls totals every 10s, but only while the pane is visible: all panes in grid variant, only the active tab in single-pane view. Immediate fetch on becoming visible (tab switch). Gate on the existing `variant`/active props.
- No file watchers, no new WS event types.

**Changes panel** (`components/ChangesPanel.tsx`):
- Opens via the existing right-pane split mechanism in `app/page.tsx` (~`:433-448`, `:600-672`), exclusive with SubagentViewer and TeamPanel, same drag handle and persisted ratio.
- Fetches the endpoint with `tree=1`; refreshes on the same 10s tick while open.
- Tree rendering follows the `components/SubagentTree.tsx` row pattern (indent, collapse toggles). Directories collapsed by default; paths containing changes auto-expanded. Changed files highlighted with per-file `+N/-N`.
- Read-only in v1 — clicking a file does nothing.

## Styling

Hard rules apply: text via `t-*` mixins only, colors/spacing from `styles/tokens.scss` (success/danger tokens for green/red), compose `components/ui/` primitives. `npm run lint:styles` must pass.

## Testing

- Vitest: numstat + untracked-file parser; tree building and auto-expand set computation (pure functions given fixed inputs).
- Manual: open a worktree tab, edit a file, watch the chip update within 10s; switch tabs and confirm immediate refresh; open panel and confirm expansion/highlights.

## Out of scope (v1)

Per-file diff viewer on click, WS push for git changes, cross-tab caching of stats for the same repo, machine-reboot-style edge polish. All are clean follow-ups.

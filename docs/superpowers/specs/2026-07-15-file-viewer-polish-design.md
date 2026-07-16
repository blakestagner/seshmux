# File viewer polish — filetype colors, syntax highlighting, full-file view

2026-07-15. Approved design for branch `file-viewer-polish`.

## Goal

Bring the ChangesPanel file tree and file viewer up to VSCode-class visual quality:
1. Per-filetype color coding (glyph + tinted name) in the file tree.
2. Syntax highlighting in the diff view and a new full-file view, any language.
3. A Diff | Full toggle so a clicked file can be read in its entirety.

## Current state (verified)

- Tree: `components/ChangesPanel/ChangesPanel.tsx` `Row` (:30) — only git-status styling (`rowChanged`, `deleted`, +/− stats). No filetype logic anywhere in the repo.
- Diff: `DiffView` (same file, :94), parsed by `lib/client/diff.ts` `parseUnifiedDiff` → `DiffLine[]` (kind add/del/hunk/context), colored by kind-based CSS tints only (`--diff-add-bg`/`--diff-del-bg`).
- Server: `server/routes/git.ts` — `GET /api/git/changes` (+`?tree=1`), `GET /api/git/changes/file` (diff, capped 5000 lines). Git via `execFile` in `server/lib/git-stats.ts`; `resolveTarget` picks worktree dir for `agent/*` branches.
- No syntax-highlight dependency. No syntax color tokens in `styles/tokens.scss`.

## Design

### 1. Syntax tokens (foundation)

Add ~10 syntax color CSS vars to `styles/tokens.scss`, tuned per theme (dark + light blocks):
`--syn-keyword, --syn-string, --syn-number, --syn-comment, --syn-function, --syn-type, --syn-tag, --syn-attr, --syn-punct, --syn-variable`.

One global stylesheet (`styles/syntax.scss`, imported once) maps highlight.js `hljs-*` classes to these vars. Colors live in tokens.scss only — hard rule 1 (typography mixins) and the token source-of-truth rule both hold.

### 2. Highlighting engine

- Dependency: `highlight.js` (client-only, lazy `import()` on first viewer open — zero cost until a file is opened).
- New `lib/client/highlight.ts`:
  - `languageFor(path)`: extension → hljs language id map; unknown → auto-detect (bounded to common subset for speed).
  - `highlightLine(code, lang)`: returns HTML string (hljs output; hljs escapes input itself).
- Applied line-by-line to BOTH:
  - Diff view: each `DiffLine`'s text is highlighted; add/del background tints stay (syntax color over tint, like VSCode).
  - Full-file view.
- Line-by-line keeps `parseUnifiedDiff` and the `DiffLine` structure untouched. Known ceiling: multi-line constructs (block comments, template literals) may mis-highlight across line boundaries — acceptable; VSCode diffs have similar artifacts, and per-line keeps the implementation trivial.

### 3. File-tree filetype colors

- New `lib/client/file-glyphs.ts`: `glyphFor(name)` → `{ glyph: string, colorVar: string }`.
- ~12 categories (extension-based, plus filename specials like `package.json`, `Dockerfile`):
  - styles (scss/css/sass) — ✿ pink
  - ts/tsx — ◆ blue
  - js/jsx/mjs/cjs — ◆ yellow
  - tests (`*.test.*`, `*.spec.*`) — ✓ green (wins over language color)
  - json/yaml/toml/config — ⚙ grey
  - md/mdx — ¶ teal
  - images (png/jpg/svg/gif/webp/ico) — ▣ purple
  - shell (sh/bash/zsh) — $ green
  - html/xml/twig/vue — <> orange
  - rust/go/py/rb and other code — ◆ per-language hue where obvious, else generic
  - lockfiles/generated — dimmed grey
  - fallback — · `--text-dim`
- Colors are new tokens in `tokens.scss` (e.g. `--ft-styles`, `--ft-script`, `--ft-config`, …) with dark/light values.
- `Row` renders the glyph (replacing the current caret-spacer position for files) and tints the filename with the same var at full strength for changed files, dimmed for unchanged. Existing status styling (deleted strikethrough class, +/− stats, `rowChanged`) layers on top; folders unchanged.

### 4. Full-file view

- New route `GET /api/git/file?path=<rel>` in `server/routes/git.ts`:
  - Resolves dir via existing `resolveTarget` (worktree-aware).
  - Containment: resolved absolute path must stay within the target dir (reject `..`, absolute paths, symlink escape via realpath check — same spirit as fs-guard; fail closed).
  - Caps: 1MB / 5000 lines → `{ content, truncated }`; binary sniff (NUL byte in first 8KB) → `{ binary: true }`.
- Client `getGitFile(projectId, branch, path)` in `lib/client/api.ts`.
- Viewer header gains a `Diff | Full` segmented toggle (compose existing ui/ primitives):
  - Changed files: default Diff, toggle to Full.
  - Unchanged tree files: clicking opens straight to Full (today they open nothing/empty diff); toggle hidden.
- Full view: line numbers (reuse diff gutter styling), syntax highlighted, lines present in the diff's add hunks tinted with `--diff-add-bg`.

## Error handling

- Highlight failure (unknown lang, hljs throw) → render plain text (current behavior). Never block the viewer on highlighting.
- File route errors (missing file, binary, too large) → viewer shows the existing empty/notice pattern.

## Testing

- Unit: `file-glyphs` category mapping (incl. test-over-language precedence, filename specials); `languageFor` map; git file route — containment (traversal, absolute, symlink), caps, binary sniff (vitest, real temp git repo like existing git-stats tests).
- Existing diff parse tests untouched.
- Visual: browser subagent screenshots tree + diff + full view in both themes (invariant 5 in the marketplace handoff: verify screenshots, not rects).

## Non-goals

- No Shiki/TextMate fidelity; no VSCode icon fonts (hard rule 5 adjacency — generic glyphs only).
- No inline-diff-in-full-file weaving (GitHub-style expand-context) — Diff and Full are separate renderings.
- No editing from the viewer.

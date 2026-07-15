# Skills & Agents Authoring + Marketplace — Design

**Date:** 2026-07-14
**Status:** Approved (brainstorm with Blake)
**Phasing:** Phase 1 = authoring + AI assist. Phase 2 = marketplace. One design, two implementation plans.

## Problem

The customizations browser (CustomizationsModal, `GET /api/customizations`) is read-only. Users want to create and edit skills/agents from project settings, get claude/codex help writing them, and install community ones.

## Decisions (from brainstorm)

- Files land in the **project** `.claude/` (versioned with the repo), not global.
- **Claude-only authoring in v1** — codex has no project skills/agents surface; its authoring UI is greyed out with a hint.
- **Create + edit** (not create-only). Route comment already earmarked v2 as "editing PUTs against item.filePath".
- AI assist is **both modes**: Polish = headless, result into the form; Make-it-for-me = live spawned session that writes the file.
- Architecture: **extend the existing modal + customizations route** (no new page, no agent-only flow).
- Marketplace = **phase 2**, covering community GitHub skill/agent repos AND the Claude Code plugin marketplace.

## Phase 1 — Authoring

### UI (CustomizationsModal)

- Skills and Agents sections get `+ New` (project scope, claude provider only); item detail gets `Edit`.
- Both open one editor pane replacing the detail view:
  - Name field, kebab-cased live into a filename preview: `.claude/skills/<name>/SKILL.md` or `.claude/agents/<name>.md`.
  - Markdown textarea for the body. New skills get `name`/`description` frontmatter scaffolded if absent.
  - Save / Cancel. After save, refetch the scope so lists update.

### Write API

`PUT /api/customizations/item` — `{ projectId, section: 'skills' | 'agents', name, content }`.

- `projectId` resolves through the existing `scannedResolveRepo` gate (unknown = 404). The server derives the path; the client never sends one.
- Name whitelist `[a-z0-9-]{1,64}`. Reject traversal/absolute names.
- Edits write to the item's scanned `filePath` only if it re-resolves (realpath) inside `<repo>/.claude/` — fail closed, symlink-proof.
- No delete in v1.
- Directory layout knowledge (`.claude/skills/...`) lives in the claude provider (a `writeTargets` companion to `CustomizationScanners`), not the route (hard rule 3).

## Phase 1 — AI assist

Editor pane gets two actions, each with a provider picker (reuse the BridgeMenu dropdown pattern, PR #22):

### Polish (headless → form)

`POST /api/customizations/assist` — `{ projectId, section, name, draft, provider }`.

- Server composes an authoring prompt (conventions for a good SKILL.md / agent definition + the user's draft) and runs the provider's `commands.headlessAsk` (codex: `exec -s read-only`; claude: `-p`). Prompt passes as one argv element — no shell.
- Result replaces the textarea with a one-level Undo (pre-polish text kept in component state). Disk untouched until Save.
- ~60s timeout, busy state on the button, errors inline.
- Disabled when the textarea is empty.

### Make it for me (live session)

- Calls `startSession` with `firstPrompt` = authoring brief ("Create `.claude/skills/<name>/SKILL.md` in this repo. Purpose: <textarea>. Follow skill-authoring conventions, then stop.") and opens a term tab — same seam as bridge handoff, but NOT a linked pair (no link chrome).
- Works with an empty textarea (title alone is the brief).
- Returning to the modal refetches and shows the new item.

## Phase 2 — Marketplace

New `Marketplace` section in the modal nav; one list UI over two source types.

### Community skill/agent repos

- Curated default source list (`anthropics/skills` + selected community repos); users can add any public GitHub repo URL in settings.
- `GET /api/marketplace/browse?source=…` — GitHub API tree fetch (unauthenticated, in-memory cache ~15min), items listed with name/description parsed from SKILL.md frontmatter.
- `POST /api/marketplace/install` — downloads the item's files and writes them through the SAME validated write path as authoring (project `.claude/`), sharing all guards. Installed items show a source badge.

### Claude Code plugin marketplace

- Claude-provider-only (hard rule 3: CLI knowledge in the provider). List/install via `claude plugin` CLI family, run headlessly; output reported in the modal.
- Probe the subcommand's existence first; absent = "not supported by this claude version". Never guess CLI surface (hard rule 6 spirit).

### Trust model

- Install is user-initiated only; a preview shows the full file list + content before anything is written.
- seshmux never executes marketplace content itself — skills only run when an agent session loads them (same trust as hand-written).

## Security summary

- All writes: scanned-project gate → name whitelist → realpath containment inside `<repo>/.claude/` → fail closed.
- 256KB content cap per file (form and marketplace install).
- Assist/exec prompts always argv, never shell.
- No `~/.claude`/`~/.codex` knowledge outside providers.

## Errors

- Save/polish/install failures render inline in the editor (Transcript `actionError` pattern).
- Multi-file installs write to a temp dir and rename in; failed installs leave nothing behind.

## Testing

- Route unit tests (the load-bearing set): traversal attempts, bad names, unknown project, edit-target escaping `.claude/`, size cap.
- Assist endpoint with mocked provider commands (argv shape, timeout, error mapping).
- Marketplace browse against a mocked GitHub payload; install path-guard reuse.
- UI smoke via browser agent (create → save → appears in list; polish round-trip; make-it spawns a session).

# Customizations roadmap — DO NOT FORGET v2/v3

Blake's explicit direction (2026-07-10): the Customizations browser ships read-only in
v1, but it is deliberately architected so editing and a full Copilot-style manager land
later WITHOUT rework. This file exists so that intent survives context loss.

## v1 — read-only browser (spec: `docs/todo/2026-07-10-customizations-browser.md`)

Center modal listing agents / skills / instructions / hooks / MCP servers (global +
per-project, both providers) + a Projects visibility section. Every item is
**file-path addressed** (`CustomizationItem.filePath` is its identity) — that is the
seam the later phases build on. No writes anywhere.

## v2 — edit in place (planned, not started)

- Editor pane inside the same modal (edit button on any item's detail view).
- `PUT /api/customizations/file` writing back to the item's `filePath` — atomic write,
  validate frontmatter/JSON before save, refuse paths outside the scanned roots.
- This is the first time seshmux ever WRITES into `~/.claude` / repo `.claude/` beyond
  the status-hook installer — same opt-in care: explicit save action, exact content,
  no merges.

## v3 — full manager (planned, not started)

- Create-new wizards per section (new agent, new skill, new hook) writing into the
  correct scanned dir.
- Copilot-style "describe your preferences and we draft an agent/skill" generation box
  (the seshmux-native twist: draft it USING one of the user's own live agents via the
  bridge).
- Evaluate Plugins/Tools sections from the Copilot reference here.

## Standing constraints across all phases

- Path knowledge stays in `server/lib/providers/` (hard rule 3).
- Codex surfaces: schema-discover against real `~/.codex` before building (hard rule 6).
- Style: t-* mixins + ui/ primitives; lint:styles is the gate.

---
name: style-system
description: seshmux styling architecture — SCSS modules, design tokens, typography mixins, UI primitives. Load when touching any .scss, .module.scss, tokens, typography, theming, light/dark mode, colors, fonts, spacing, radii, or creating/modifying any component's visual appearance.
user-invocable: true
---

# Style system

Three strict layers — violations fail `npm run lint:styles`:
1. `styles/tokens.scss` — CSS custom properties only. `:root` holds fonts + radii + `--claude`/`--codex`; `:root[data-theme="dark"|"light"]` hold colors/shadows. Theme stamped pre-hydration by layout.tsx.
2. `styles/typography.scss` — the ONLY place text is styled. `t-*` mixins.
3. `*.module.scss` — layout, spacing, state, color usage only. NEVER hand-write font-size/font-weight/letter-spacing/text-transform here.

Tokens (as built): `--mono --sans --font-ui --radius --radius-sm --radius-xs --accent-soft --claude --codex` in `:root`; per-theme `--bg --bg-panel --bg-raised --bg-hover --border --border-bright --text --text-dim --text-faint --accent --accent-contrast --live --waiting --done --hot --role-user --shadow-dropdown --shadow --term-*`. Light theme also overrides `--claude`/`--codex` (darker, for contrast on light bg).

Identity colors: `--claude` (coral) / `--codex` (blue) — provider identity ONLY, never status. Status: `--live` green / `--waiting` amber / `--done` gray. `--role-user` = transcript user-message accent.

Mixins (as built, `t-*`): t-page-title, t-section, t-item-title, t-heading, t-body, t-row, t-sub, t-meta, t-mono-data, t-mono-micro, **t-mono-micro-strong**, t-stat, t-role-tag, **t-chip**, **t-section-note**, **t-button-primary**, **t-logo**, **t-logo-mark**, t-caret.

Primitives-first: shared visuals live in `components/ui/`; feature components compose, never redraw. As built: StatusDot, ProviderBadge, CtxBadge, MeterBar, MetaLine, BranchLabel, Card, Button, IconButton, Toggle, Select, Segmented, TextInput, **LinkChip**. Notable signatures:
- StatusDot: `{ status: 'live'|'waiting'|'done'|'neutral'; size?: 7|8|9 }` (default 8).
- Segmented: `{ options; value; onChange; variant?: 'default'|'raised'; className? }`.
- TextInput: `{ value; onChange; placeholder?; kbdHint?; multiline?: number }` — `multiline=N` renders `<textarea rows={N}>`.
- ProviderBadge: `{ provider; withName? }`; exports `PROV: Record<ProviderId,{glyph,name}>` (✳ Claude Code / ⬡ Codex CLI). Generic glyphs only — never ship vendor logos.
- LinkChip: `{ kind: 'handoff'|'review'|'planoff' }` (⇄ / ⊙ / ⚖).

Enforcement: `scripts/lint-styles.sh` greps **all** `components/**/*.module.scss` — `ui/` is INCLUDED, not excluded — for raw `font-size|font-weight|letter-spacing|text-transform` declarations. Any match → exit 1. Wired into `npm test`.

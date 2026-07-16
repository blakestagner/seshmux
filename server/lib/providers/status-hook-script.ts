// Claude Code status-hook shell script SOURCE (Spec 2), inlined as a string constant —
// same reasoning as manifest.ts's static JSON imports: esbuild bundles server/index.ts
// into a single file for the standalone build (scripts/build-standalone.sh), so a sibling
// asset resolved via import.meta.url would NOT exist at the bundled location. Baking the
// script body into the JS sidesteps the asset-copy problem entirely. installHooks() writes
// this string out to <configDir>/claude-status-hook.sh at install time (chmod 0o755).
//
// This is the ONLY copy of the script body — do not also keep a standalone .sh file, they
// would drift. bash -n syntax-checked in test/status-hooks.test.ts.

export const CLAUDE_STATUS_HOOK_SCRIPT = `#!/usr/bin/env bash
# seshmux Claude Code status hook (Spec 2 — hook-based status authority).
#
# Installed by server/lib/providers/status-hooks.ts into ~/.claude/settings.json
# under hooks.Notification / hooks.Stop / hooks.PermissionRequest. Claude Code
# sends the hook payload as JSON on stdin, including the hook_event_name field.
#
# Self-locates via $SESHMUX_PTY_ID, inherited from the PTY this Claude process
# is running in (daemon/pty-manager.js sets it on every spawn) — no session-id
# to ptyId mapping needed. Sessions NOT spawned by seshmux (a plain terminal
# a plain claude run, or another tool) simply have no $SESHMUX_PTY_ID and this script
# no-ops, so installing the hook globally is safe for every Claude session.
#
# Writes {"status":"...", "ts": <ms>, "source":"hook"} to
# <SESHMUX_CONFIG_DIR|~/.config/seshmux>/status/<ptyId>.json — the exact shape
# server/lib/needs-input.ts readHookStatus() already reads.

set -euo pipefail

[ -n "\${SESHMUX_PTY_ID:-}" ] || exit 0

input="$(cat)"

event=""
if command -v jq >/dev/null 2>&1; then
  event="$(printf '%s' "$input" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
fi
# jq missing/failed: fall back to a crude grep so the hook degrades instead of
# silently doing nothing (still best-effort — never blocks Claude on failure).
if [ -z "$event" ]; then
  event="$(printf '%s' "$input" | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -E 's/.*:[[:space:]]*"([^"]*)"/\\1/' || true)"
fi

case "$event" in
  Notification|PermissionRequest) status="waiting" ;;
  Stop) status="idle" ;;
  *) exit 0 ;; # unrecognized/other event — leave existing status alone
esac

config_dir="\${SESHMUX_CONFIG_DIR:-$HOME/.config/seshmux}"
status_dir="$config_dir/status"
mkdir -p "$status_dir" 2>/dev/null || exit 0

ts="$(($(date +%s%N) / 1000000))"
tmp="$status_dir/.\${SESHMUX_PTY_ID}.$$.tmp"
printf '{"status":"%s","ts":%s,"source":"hook"}' "$status" "$ts" > "$tmp" 2>/dev/null || exit 0
mv -f "$tmp" "$status_dir/\${SESHMUX_PTY_ID}.json" 2>/dev/null || rm -f "$tmp"

exit 0
`;

#!/usr/bin/env bash
# lint:styles gate — hard rule 1: text is styled ONLY via styles/typography.scss
# t-* mixins. Every *.module.scss under components/ (ui/ included — ui modules
# must also go through @include t-*, never raw) is forbidden from declaring
# font-size/font-weight/letter-spacing/text-transform directly. The `:` in the
# pattern requires it to be a declaration, so `@include t-page-title;` and
# `font-variant-numeric: ...` don't false-positive.
set -euo pipefail

cd "$(dirname "$0")/.."

matches=$(grep -REn '(font-size|font-weight|letter-spacing|text-transform)[[:space:]]*:' \
  --include='*.module.scss' components 2>/dev/null || true)

if [ -n "$matches" ]; then
  echo "lint:styles FAILED — raw text styling found outside typography.scss:"
  echo "$matches"
  exit 1
fi

echo "lint:styles OK — no raw text properties in component modules."

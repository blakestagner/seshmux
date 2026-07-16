#!/usr/bin/env bash
# Standalone production build (plan Task 17). Produces a self-contained
# .next/standalone that bin/seshmux.js boots in prod:
#   • Next standalone server output + static assets (Next doesn't copy those)
#   • the custom-server dep closure (Next traces only what IT imports, so
#     fastify/@fastify/websocket/ws + the mcp deps are absent — install them)
#   • two esbuild-bundled entry points (deps external), each a THIN launcher
#     that explicitly calls its start fn (the renamed bundle won't trip
#     server/index.ts's isMain guard).
#
# Run via `npm run build` (prepack also invokes it). Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."

# Start from clean. NOT cosmetic: building on top of a .next left by `next dev` (or by a
# previous build) produced a standalone with 19 nested packages instead of 192 — most of the
# dependency closure missing — and the very next build on the same commit produced the full
# 192. Same commit, two `npm pack` runs, 1,952 vs 14,034 files. The lean one installs fine and
# then dies at boot on MODULE_NOT_FOUND, so a release built from a dirty tree ships broken.
# The old "Idempotent." claim in this header was simply false.
echo "[build] clean .next (release builds must be reproducible)…"
rm -rf .next

echo "[build] next build…"
npx next build

echo "[build] copy static assets into standalone (Next omits these)…"
cp -r .next/static .next/standalone/.next/static
[ -d public ] && cp -r public .next/standalone/public || true

echo "[build] install custom-server dep closure into standalone…"
# npm resolves transitives (semver etc.) — do NOT hand-copy. mcp deps
# (@modelcontextprotocol/sdk, zod) are needed by the mcp-bridge entry.
( cd .next/standalone && npm install --no-save --omit=dev \
    fastify @fastify/websocket ws @modelcontextprotocol/sdk zod )

echo "[build] esbuild server entry → seshmux-server.js…"
# Thin launcher: import + call startServer({dev:false}). Deps external so the
# installed standalone node_modules resolve them at runtime.
npx esbuild scripts/entry-server.ts --bundle --platform=node --format=cjs \
  --external:next --external:fastify '--external:@fastify/*' --external:ws \
  '--external:@modelcontextprotocol/*' --external:zod --external:chokidar \
  '--external:@homebridge/*' \
  --outfile=.next/standalone/seshmux-server.js

echo "[build] esbuild mcp-bridge entry → seshmux-mcp-bridge.js…"
npx esbuild scripts/entry-mcp-bridge.ts --bundle --platform=node --format=cjs \
  '--external:@modelcontextprotocol/*' --external:zod \
  --outfile=.next/standalone/seshmux-mcp-bridge.js

echo "[build] done. boot with: node bin/seshmux.js  (NODE_ENV=production auto in prod path)"

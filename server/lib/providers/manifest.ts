// Needs-input pattern manifests (Spec 4): per-provider waiting-state regexes as data instead
// of inline code, so a third provider is a module + a JSON file, no core edits. Boot-time
// load only — no hot-reload, no remote fetch (see spec doc). Hard rule 3: this file and its
// manifests/ dir are the only place waiting-pattern SOURCES live; providers still own the
// compiled RegExp[] via the AgentProvider interface.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import claudeShipped from './manifests/claude.json';
import codexShipped from './manifests/codex.json';

interface Manifest {
  provider: string;
  version: number;
  waiting: string[];
  notes?: string;
}

// Static imports so esbuild inlines these into the standalone bundle (the
// shipped manifests must be identical in dev and prod — no __dirname runtime
// file read, which breaks once the server is bundled into a single file).
const SHIPPED: Record<string, Manifest> = { claude: claudeShipped, codex: codexShipped };

function isManifest(v: unknown): v is Manifest {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as Manifest).waiting) &&
    (v as Manifest).waiting.every((s) => typeof s === 'string')
  );
}

function userConfigDir(): string {
  return process.env.SESHMUX_CONFIG_DIR || join(homedir(), '.config', 'seshmux');
}

// Loads <provider>.json, preferring a user override at <configDir>/manifests/<provider>.json
// (whole-file replace, no merge). A missing or malformed override silently falls back to the
// shipped manifest (malformed → warn). Compiles each RegExp source with the 'i' flag.
export function loadNeedsInputPatterns(provider: string): RegExp[] {
  const overridePath = join(userConfigDir(), 'manifests', `${provider}.json`);

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(overridePath, 'utf8'));
    if (!isManifest(manifest)) throw new Error('missing/invalid "waiting" array');
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // File exists but is malformed (bad JSON or wrong shape) — warn and fall back.
      console.warn(`[seshmux] ignoring malformed manifest override ${overridePath}: ${err.message}`);
    }
    const fallback = SHIPPED[provider];
    if (!fallback) throw new Error(`no shipped manifest for provider ${provider}`);
    manifest = fallback;
  }

  return manifest.waiting.map((source) => new RegExp(source, 'i'));
}

// GET/PUT /api/config -> user prefs persisted at ~/.config/seshmux/config.json.
// This is seshmux's OWN config dir (not a provider store), so the path is fine here.
// Writes are atomic (tmp file + rename) to avoid a torn config on concurrent PUTs.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

export interface Config {
  pins: string[];
  projectOrder: string[];
  hidden: string[];
  theme: string;
  accent: string;
  settings: Record<string, unknown>;
}

const DEFAULT_CONFIG: Config = { pins: [], projectOrder: [], hidden: [], theme: 'dark', accent: 'iris', settings: {} };

function configDir(): string {
  return join(homedir(), '.config', 'seshmux');
}
function configPath(): string {
  return join(configDir(), 'config.json');
}

export async function readConfig(): Promise<Config> {
  try {
    const raw = await readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function writeConfig(cfg: Config): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  const tmp = join(configDir(), `config.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  await rename(tmp, configPath());
}

// Coerce an arbitrary body into a valid Config (trust boundary — this endpoint writes disk).
function sanitize(body: unknown): Config {
  const b = (body ?? {}) as Partial<Config>;
  return {
    pins: Array.isArray(b.pins) ? b.pins.filter((x) => typeof x === 'string') : [],
    projectOrder: Array.isArray(b.projectOrder)
      ? b.projectOrder.filter((x) => typeof x === 'string')
      : [],
    hidden: Array.isArray(b.hidden) ? b.hidden.filter((x) => typeof x === 'string') : [],
    theme: typeof b.theme === 'string' ? b.theme : DEFAULT_CONFIG.theme,
    accent: typeof b.accent === 'string' ? b.accent : DEFAULT_CONFIG.accent,
    settings: b.settings && typeof b.settings === 'object' ? (b.settings as Record<string, unknown>) : {},
  };
}

export default async function configRoutes(f: FastifyInstance) {
  f.get('/api/config', async () => readConfig());

  f.put<{ Body: unknown }>('/api/config', async (req) => {
    const cfg = sanitize(req.body);
    await writeConfig(cfg);
    return cfg;
  });
}

// Read-only customization scanning shared by providers (Spec: customizations
// browser v1). Types + generic helpers only — provider PATHS live in each
// provider module (hard rule 3). Every item is file-path addressed: filePath
// is the item's identity and v2's edit target (.claude/docs/customizations-roadmap.md).

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type CustomizationScope = { kind: 'global' } | { kind: 'project'; repoPath: string };

export interface CustomizationItem {
  id: string;
  provider: 'claude' | 'codex';
  scope: 'global' | 'project';
  filePath: string;
  title: string;
  meta: Record<string, string>;
  content: string;
  parseError?: string;
}

export interface CustomizationScanners {
  agents?(scope: CustomizationScope): Promise<CustomizationItem[]>;
  skills?(scope: CustomizationScope): Promise<CustomizationItem[]>;
  instructions?(scope: CustomizationScope): Promise<CustomizationItem[]>;
  hooks?(scope: CustomizationScope): Promise<CustomizationItem[]>;
  mcpServers?(scope: CustomizationScope): Promise<CustomizationItem[]>;
}

export interface ScanDeps {
  homeDir: string;
}

export function itemId(filePath: string, entryKey = ''): string {
  return createHash('sha1').update(filePath + '\0' + entryKey).digest('hex').slice(0, 16);
}

// Minimal YAML-subset frontmatter parser: `key: value` lines between --- fences.
// Good frontmatter in the wild is exactly that shape; anything fancier (nested
// yaml) keeps the raw text as body with no error — we render, not validate.
export function parseFrontmatter(src: string): { attrs: Record<string, string>; body: string; error?: string } {
  if (!src.startsWith('---\n')) return { attrs: {}, body: src };
  const end = src.indexOf('\n---', 4);
  if (end === -1) return { attrs: {}, body: src, error: 'unterminated frontmatter' };
  const attrs: Record<string, string> = {};
  for (const line of src.slice(4, end).split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) attrs[m[1]] = m[2].trim();
  }
  return { attrs, body: src.slice(end + 4).replace(/^\n/, '') };
}

async function fileToItem(
  filePath: string,
  provider: 'claude' | 'codex',
  scope: 'global' | 'project',
): Promise<CustomizationItem> {
  const raw = await readFile(filePath, 'utf8');
  const fm = parseFrontmatter(raw);
  return {
    id: itemId(filePath),
    provider,
    scope,
    filePath,
    title: fm.attrs.name || path.basename(filePath, '.md'),
    meta: fm.attrs,
    content: raw,
    ...(fm.error ? { parseError: fm.error } : {}),
  };
}

/** Scan a flat dir of *.md files (agents, codex prompts). Missing dir -> []. */
export async function scanMarkdownDir(
  dir: string,
  provider: 'claude' | 'codex',
  scope: 'global' | 'project',
): Promise<CustomizationItem[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  const items = await Promise.all(names.sort().map((n) => fileToItem(path.join(dir, n), provider, scope)));
  return items;
}

/** Scan skills layout: <dir>/<skill-name>/SKILL.md. Missing dir -> []. */
export async function scanSkillsDir(
  dir: string,
  provider: 'claude' | 'codex',
  scope: 'global' | 'project',
): Promise<CustomizationItem[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: CustomizationItem[] = [];
  for (const name of entries.sort()) {
    const f = path.join(dir, name, 'SKILL.md');
    try {
      out.push(await fileToItem(f, provider, scope));
    } catch {
      /* not a skill dir */
    }
  }
  return out;
}

/** One item per instruction file that exists. */
export async function scanInstructionFiles(
  files: string[],
  provider: 'claude' | 'codex',
  scope: 'global' | 'project',
): Promise<CustomizationItem[]> {
  const out: CustomizationItem[] = [];
  for (const f of files) {
    try {
      const raw = await readFile(f, 'utf8');
      out.push({ id: itemId(f), provider, scope, filePath: f, title: path.basename(f), meta: {}, content: raw });
    } catch {
      /* absent — skip */
    }
  }
  return out;
}

/** Parse hooks out of a settings.json-shaped file: { hooks: { <Event>: [{matcher, hooks:[{command}]}] } }.
 *  Malformed JSON -> single parseError item (listed, never thrown/omitted). Missing file -> []. */
export async function scanHooksJson(
  filePath: string,
  provider: 'claude' | 'codex',
  scope: 'global' | 'project',
): Promise<CustomizationItem[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return [{ id: itemId(filePath), provider, scope, filePath, title: path.basename(filePath), meta: {}, content: raw, parseError: e instanceof Error ? e.message : 'invalid JSON' }];
  }
  const out: CustomizationItem[] = [];
  const hooks = parsed?.hooks && typeof parsed.hooks === 'object' ? parsed.hooks : {};
  for (const [event, entries] of Object.entries<any>(hooks)) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, i) => {
      const cmds = Array.isArray(entry?.hooks) ? entry.hooks : [];
      cmds.forEach((h: any, j: number) => {
        const key = `${event}[${i}][${j}]`;
        out.push({
          id: itemId(filePath, key),
          provider,
          scope,
          filePath,
          title: event,
          meta: { event, matcher: String(entry?.matcher ?? ''), command: String(h?.command ?? '') },
          content: JSON.stringify(entry, null, 2),
        });
      });
    });
  }
  return out;
}

/** Parse MCP servers from a .mcp.json-shaped file: { mcpServers: { <name>: {command, args?} } }. */
export async function scanMcpJson(
  filePath: string,
  provider: 'claude' | 'codex',
  scope: 'global' | 'project',
): Promise<CustomizationItem[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return [{ id: itemId(filePath), provider, scope, filePath, title: path.basename(filePath), meta: {}, content: raw, parseError: e instanceof Error ? e.message : 'invalid JSON' }];
  }
  const servers = parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
  return Object.entries<any>(servers).map(([name, cfg]) => ({
    id: itemId(filePath, name),
    provider,
    scope,
    filePath,
    title: name,
    meta: { command: [cfg?.command, ...(Array.isArray(cfg?.args) ? cfg.args : [])].filter(Boolean).join(' ') },
    content: JSON.stringify(cfg, null, 2),
  }));
}

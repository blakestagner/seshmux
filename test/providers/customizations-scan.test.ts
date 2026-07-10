import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter, scanMarkdownDir } from '../../server/lib/providers/customizations';
import { ClaudeProvider } from '../../server/lib/providers/claude';
import { CodexProvider } from '../../server/lib/providers/codex';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'smx-cust-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'smx-cust-repo-'));

beforeAll(() => {
  // global agent — good frontmatter
  fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews diffs\nmodel: opus\ntools: Read, Grep\n---\nYou are a reviewer.\n',
  );
  // global agent — MALFORMED frontmatter (unterminated)
  fs.writeFileSync(path.join(home, '.claude', 'agents', 'broken.md'), '---\nname: broken\nno terminator\n');
  // project agent
  fs.mkdirSync(path.join(repo, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'agents', 'proj-agent.md'), '---\nname: proj-agent\ndescription: x\n---\nbody\n');
  // global skill (skills/<name>/SKILL.md layout)
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: does things\n---\nsteps\n');
  // instructions
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# global rules\n');
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# project rules\n');
  // hooks — valid settings.json with one hook + a malformed project settings.json
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'echo hi' }] }] } }),
  );
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{ not json');
  // mcp
  fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'npx', args: ['db-mcp'] } } }));
});

describe('parseFrontmatter', () => {
  it('parses attrs and body', () => {
    const r = parseFrontmatter('---\nname: a\ndescription: b\n---\nbody here\n');
    expect(r.attrs).toEqual({ name: 'a', description: 'b' });
    expect(r.body.trim()).toBe('body here');
    expect(r.error).toBeUndefined();
  });
  it('flags unterminated frontmatter without throwing', () => {
    const r = parseFrontmatter('---\nname: a\nno end\n');
    expect(r.error).toBeTruthy();
    expect(r.body).toContain('name: a'); // raw fallback
  });
  it('treats files without frontmatter as body-only', () => {
    const r = parseFrontmatter('just text');
    expect(r.attrs).toEqual({});
    expect(r.body).toBe('just text');
  });
});

describe('ClaudeProvider.customizations', () => {
  const p = new ClaudeProvider({ homeDir: home });

  it('lists global agents, malformed file included with parseError', async () => {
    const items = await p.customizations!.agents!({ kind: 'global' });
    const titles = items.map((i) => i.title).sort();
    expect(titles).toEqual(['broken', 'reviewer']);
    const rev = items.find((i) => i.title === 'reviewer')!;
    expect(rev.meta.model).toBe('opus');
    expect(rev.meta.tools).toBe('Read, Grep');
    expect(rev.filePath).toBe(path.join(home, '.claude', 'agents', 'reviewer.md'));
    expect(rev.provider).toBe('claude');
    expect(rev.scope).toBe('global');
    const broken = items.find((i) => i.filePath.endsWith('broken.md'))!;
    expect(broken.parseError).toBeTruthy();
  });

  it('lists project agents from <repo>/.claude/agents', async () => {
    const items = await p.customizations!.agents!({ kind: 'project', repoPath: repo });
    expect(items.map((i) => i.title)).toEqual(['proj-agent']);
    expect(items[0].scope).toBe('project');
  });

  it('lists skills from skills/<name>/SKILL.md', async () => {
    const items = await p.customizations!.skills!({ kind: 'global' });
    expect(items.map((i) => i.title)).toEqual(['my-skill']);
  });

  it('lists instruction files that exist, skips ones that do not', async () => {
    const g = await p.customizations!.instructions!({ kind: 'global' });
    expect(g).toHaveLength(1);
    expect(g[0].filePath).toBe(path.join(home, '.claude', 'CLAUDE.md'));
    const pr = await p.customizations!.instructions!({ kind: 'project', repoPath: repo });
    expect(pr.map((i) => path.basename(i.filePath))).toEqual(['CLAUDE.md']); // no CLAUDE.local.md fixture
  });

  it('parses hooks grouped per entry; malformed settings.json yields one parseError item', async () => {
    const g = await p.customizations!.hooks!({ kind: 'global' });
    expect(g).toHaveLength(1);
    expect(g[0].meta.event).toBe('Notification');
    expect(g[0].meta.command).toBe('echo hi');
    const pr = await p.customizations!.hooks!({ kind: 'project', repoPath: repo });
    expect(pr).toHaveLength(1);
    expect(pr[0].parseError).toBeTruthy();
  });

  it('lists project mcp servers from .mcp.json', async () => {
    const items = await p.customizations!.mcpServers!({ kind: 'project', repoPath: repo });
    expect(items.map((i) => i.title)).toEqual(['db']);
    expect(items[0].meta.command).toBe('npx db-mcp');
  });

  it('empty scope returns [] not throw', async () => {
    const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'smx-empty-'));
    const items = await p.customizations!.agents!({ kind: 'project', repoPath: emptyRepo });
    expect(items).toEqual([]);
  });

  it('ids are stable across calls', async () => {
    const a = await p.customizations!.agents!({ kind: 'global' });
    const b = await p.customizations!.agents!({ kind: 'global' });
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
  });
});

describe('CodexProvider.customizations', () => {
  const chome = fs.mkdtempSync(path.join(os.tmpdir(), 'smx-cdx-'));
  const crepo = fs.mkdtempSync(path.join(os.tmpdir(), 'smx-cdx-repo-'));

  beforeAll(() => {
    // skills: <dir>/<name>/SKILL.md layout (Task 1 finding: matches claude's scanSkillsDir)
    fs.mkdirSync(path.join(chome, '.codex', 'skills', 'my-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(chome, '.codex', 'skills', 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: does things\n---\nsteps\n',
    );
    // bundled OpenAI skills sit one level deeper (.system/<name>/SKILL.md) and must NOT
    // surface — scanSkillsDir only probes <dir>/<entry>/SKILL.md, one level.
    fs.mkdirSync(path.join(chome, '.codex', 'skills', '.system', 'imagegen'), { recursive: true });
    fs.writeFileSync(
      path.join(chome, '.codex', 'skills', '.system', 'imagegen', 'SKILL.md'),
      '---\nname: imagegen\n---\nbundled\n',
    );
    // mcp servers: config.toml, only [mcp_servers.<name>] blocks
    fs.writeFileSync(
      path.join(chome, '.codex', 'config.toml'),
      [
        'personality = "pragmatic"',
        'model = "gpt-5.4-mini"',
        '',
        '[plugins."github@openai-curated"]',
        'enabled = true',
        '',
        '[projects."/Users/demo"]',
        'trust_level = "trusted"',
        '',
        '[mcp_servers.seshmux-bridge]',
        'command = "/opt/homebrew/bin/node"',
        'args = ["/path/to/seshmux.js", "mcp-bridge"]',
        '',
      ].join('\n'),
    );
    // instructions: project-scope AGENTS.md only
    fs.writeFileSync(path.join(crepo, 'AGENTS.md'), '# agent rules\n');
  });

  it('lists skills from skills/<name>/SKILL.md, excluding bundled .system skills', async () => {
    const p = new CodexProvider({ homeDir: chome });
    const items = await p.customizations!.skills!({ kind: 'global' });
    expect(items.map((i) => i.title)).toEqual(['my-skill']);
  });

  it('has no agents or hooks scanner (Task 1: neither surface exists on real codex)', () => {
    const p = new CodexProvider({ homeDir: chome });
    expect(p.customizations!.agents).toBeUndefined();
    expect(p.customizations!.hooks).toBeUndefined();
  });

  it('parses mcp servers from config.toml [mcp_servers.<name>] blocks only', async () => {
    const p = new CodexProvider({ homeDir: chome });
    const items = await p.customizations!.mcpServers!({ kind: 'global' });
    expect(items.map((i) => i.title)).toEqual(['seshmux-bridge']);
    expect(items[0].meta.command).toBe('/opt/homebrew/bin/node /path/to/seshmux.js mcp-bridge');
  });

  it('mcp servers project scope returns [] (codex config is global-only)', async () => {
    const p = new CodexProvider({ homeDir: chome });
    const items = await p.customizations!.mcpServers!({ kind: 'project', repoPath: crepo });
    expect(items).toEqual([]);
  });

  it('lists project instructions from AGENTS.md; global scope returns []', async () => {
    const p = new CodexProvider({ homeDir: chome });
    const items = await p.customizations!.instructions!({ kind: 'project', repoPath: crepo });
    expect(items.map((i) => path.basename(i.filePath))).toEqual(['AGENTS.md']);
    const g = await p.customizations!.instructions!({ kind: 'global' });
    expect(g).toEqual([]);
  });

  it('missing config.toml -> mcpServers returns [] not throw', async () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smx-cdx-empty-'));
    const p = new CodexProvider({ homeDir: emptyHome });
    const items = await p.customizations!.mcpServers!({ kind: 'global' });
    expect(items).toEqual([]);
  });

  it('existing positional-root constructor still works (back-compat)', async () => {
    const p = new CodexProvider(path.join(chome, '.codex', 'sessions'));
    expect(p.id).toBe('codex');
  });
});

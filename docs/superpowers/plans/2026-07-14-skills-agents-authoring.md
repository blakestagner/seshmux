# Skills & Agents Authoring (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create + edit claude skills/agents from the project-scoped customizations modal, with headless "Polish" and live-session "Make it for me" AI assists.

**Architecture:** One write endpoint (`PUT /api/customizations/item`) and one assist endpoint (`POST /api/customizations/assist`) on the existing customizations route, path knowledge behind a new provider seam (`customizationWriteTarget`). UI is an editor pane inside `CustomizationsModal`. Make-it-for-me reuses the existing `POST /api/sessions/start` `firstPrompt` seam — zero new spawn code.

**Tech Stack:** Fastify route (injected seams, hermetic vitest), Next.js client component + SCSS modules, existing `ui/Menu` dropdown surface.

**Spec:** `docs/superpowers/specs/2026-07-14-skills-agents-authoring-design.md` (phase 1 sections only).

## Global Constraints

- Hard rule 1: text styled ONLY via `t-*` mixins (`npm run lint:styles` gates `npm test`).
- Hard rule 2: shared visuals from `components/ui/` primitives (dropdown = `ui/Menu/Menu.module.scss`).
- Hard rule 3: no `.claude` path knowledge outside `server/lib/providers/` — the route gets paths from the provider seam.
- Writes fail CLOSED: unknown project = 404, bad name = 400, resolved path outside `<repo>/.claude/` = 400. Name whitelist `[a-z0-9-]{1,64}`. Content cap 256KB.
- Name is immutable on edit (path derives from name; no rename in v1). No delete in v1.
- Claude-only authoring: providers without `customizationWriteTarget` → 400.
- Run tests with node 22.22.3 (`nvm use 22.22.3`).
- Commit with a pathspec (`git commit -- <paths>`).

---

### Task 1: Provider write-target seam

**Files:**
- Modify: `server/lib/providers/types.ts` (AgentProvider interface)
- Modify: `server/lib/providers/claude.ts` (implement)
- Test: `test/providers/customizations-write-target.test.ts`

**Interfaces:**
- Produces: `customizationWriteTarget?(scope: CustomizationScope, section: 'agents' | 'skills', name: string): string` on `AgentProvider` — absolute file path for a named item. Claude: agents → `<root>/agents/<name>.md`, skills → `<root>/skills/<name>/SKILL.md`, where root is `<repo>/.claude` (project) or `~/.claude` (global). Codex does NOT implement it.

- [ ] **Step 1: Write the failing test**

```ts
// test/providers/customizations-write-target.test.ts
import { describe, it, expect } from 'vitest';
import { ClaudeProvider } from '../../server/lib/providers/claude';

describe('claude customizationWriteTarget', () => {
  const p = new ClaudeProvider('/home/u');
  it('project agent → .claude/agents/<name>.md', () => {
    expect(p.customizationWriteTarget({ kind: 'project', repoPath: '/repo' }, 'agents', 'my-agent'))
      .toBe('/repo/.claude/agents/my-agent.md');
  });
  it('project skill → .claude/skills/<name>/SKILL.md', () => {
    expect(p.customizationWriteTarget({ kind: 'project', repoPath: '/repo' }, 'skills', 'my-skill'))
      .toBe('/repo/.claude/skills/my-skill/SKILL.md');
  });
  it('global skill → ~/.claude/skills/<name>/SKILL.md', () => {
    expect(p.customizationWriteTarget({ kind: 'global' }, 'skills', 's'))
      .toBe('/home/u/.claude/skills/s/SKILL.md');
  });
});
```

NOTE: check how `ClaudeProvider` is constructed/exported in `server/lib/providers/claude.ts` (it takes a home dir — mirror whatever `test/providers/customizations-scan.test.ts` does) and adjust the test's constructor call to match.

- [ ] **Step 2: Run it — expect FAIL** (`npx vitest run test/providers/customizations-write-target.test.ts` → "customizationWriteTarget is not a function")

- [ ] **Step 3: Implement**

In `server/lib/providers/types.ts`, on the `AgentProvider` interface (near the `customizations?` member):

```ts
  // v2 authoring seam: absolute path a named skills/agents item WOULD live at.
  // Only providers with a writable layout implement it (claude); the route 400s
  // when absent. Path knowledge stays here (hard rule 3).
  customizationWriteTarget?(scope: CustomizationScope, section: 'agents' | 'skills', name: string): string;
```

(Import `CustomizationScope` there if not already.)

In `server/lib/providers/claude.ts` (next to `custRoot`):

```ts
  customizationWriteTarget(scope: CustomizationScope, section: 'agents' | 'skills', name: string): string {
    const root = this.custRoot(scope, section);
    return section === 'skills' ? join(root, name, 'SKILL.md') : join(root, `${name}.md`);
  }
```

- [ ] **Step 4: Run test — PASS.** Also `npx tsc --noEmit`.

- [ ] **Step 5: Commit** `feat(providers): claude customizationWriteTarget seam`

---

### Task 2: PUT /api/customizations/item

**Files:**
- Modify: `server/routes/customizations.ts`
- Test: `test/routes/routes-customizations-write.test.ts`

**Interfaces:**
- Consumes: `customizationWriteTarget` (Task 1), existing `CustomizationsRouteOpts.listProviders/resolveRepo` injection.
- Produces: `PUT /api/customizations/item` body `{ projectId: string; provider: string; section: 'agents' | 'skills'; name: string; content: string }` → `200 { ok: true, filePath }` | 400/404 `{ error }`.

- [ ] **Step 1: Write the failing tests** (same harness style as `test/routes/routes-customizations.test.ts`, plus a real temp dir for the write cases)

```ts
// test/routes/routes-customizations-write.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import customizationsRoutes from '../../server/routes/customizations';

let repo: string;
beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'cust-write-')); });
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

function app() {
  const f = Fastify();
  f.register(customizationsRoutes, {
    listProviders: async () => [
      {
        id: 'claude',
        customizations: {},
        customizationWriteTarget: (s: any, section: string, name: string) =>
          section === 'skills'
            ? join(s.repoPath, '.claude', 'skills', name, 'SKILL.md')
            : join(s.repoPath, '.claude', 'agents', `${name}.md`),
      },
      { id: 'codex', customizations: {} },
    ] as any,
    resolveRepo: async (id: string) => (id === 'known' ? repo : null),
  });
  return f;
}

const put = (f: ReturnType<typeof app>, body: object) =>
  f.inject({ method: 'PUT', url: '/api/customizations/item', payload: body });

const base = { projectId: 'known', provider: 'claude', section: 'skills', name: 'my-skill', content: '# hi' };

describe('PUT /api/customizations/item', () => {
  it('writes a skill to .claude/skills/<name>/SKILL.md and returns the path', async () => {
    const res = await put(app(), base);
    expect(res.statusCode).toBe(200);
    expect(await readFile(join(repo, '.claude', 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toBe('# hi');
  });
  it('writes an agent to .claude/agents/<name>.md', async () => {
    const res = await put(app(), { ...base, section: 'agents', name: 'my-agent' });
    expect(res.statusCode).toBe(200);
    expect(await readFile(join(repo, '.claude', 'agents', 'my-agent.md'), 'utf8')).toBe('# hi');
  });
  it('404s an unknown project', async () => {
    expect((await put(app(), { ...base, projectId: 'nope' })).statusCode).toBe(404);
  });
  it('400s a provider without the write seam (codex)', async () => {
    expect((await put(app(), { ...base, provider: 'codex' })).statusCode).toBe(400);
  });
  it('400s bad names: traversal, uppercase, empty, slash', async () => {
    for (const name of ['../evil', 'Evil', '', 'a/b', 'a'.repeat(65)]) {
      expect((await put(app(), { ...base, name })).statusCode).toBe(400);
    }
  });
  it('400s a bad section', async () => {
    expect((await put(app(), { ...base, section: 'hooks' })).statusCode).toBe(400);
  });
  it('400s content over 256KB', async () => {
    expect((await put(app(), { ...base, content: 'x'.repeat(256 * 1024 + 1) })).statusCode).toBe(400);
  });
  it('fails closed when .claude is a symlink escaping the repo', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    await symlink(outside, join(repo, '.claude'));
    const res = await put(app(), base);
    expect(res.statusCode).toBe(400);
    await rm(outside, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (route not found, 404s across the board)

- [ ] **Step 3: Implement** — append to `server/routes/customizations.ts` inside `customizationsRoutes` (after the GET). Imports to add at top: `import { mkdir, writeFile, realpath } from 'node:fs/promises';` and `import { dirname, join, resolve, sep } from 'node:path';`

```ts
  const NAME_RE = /^[a-z0-9-]{1,64}$/;
  const MAX_CONTENT = 256 * 1024;

  f.put<{ Body: { projectId?: string; provider?: string; section?: string; name?: string; content?: string } }>(
    '/api/customizations/item',
    async (req, reply) => {
      const { projectId, provider: providerId, section, name, content } = req.body ?? {};
      if (section !== 'agents' && section !== 'skills') return reply.code(400).send({ error: 'bad section' });
      if (typeof name !== 'string' || !NAME_RE.test(name)) return reply.code(400).send({ error: 'bad name' });
      if (typeof content !== 'string' || content.length > MAX_CONTENT)
        return reply.code(400).send({ error: 'bad content' });

      const repoPath = projectId ? await resolveRepo(projectId) : null;
      if (!repoPath) return reply.code(404).send({ error: 'unknown project' });

      const providers = await listProviders();
      const provider = providers.find((p) => p.id === providerId);
      if (!provider?.customizationWriteTarget)
        return reply.code(400).send({ error: 'provider does not support authoring' });

      const target = provider.customizationWriteTarget({ kind: 'project', repoPath }, section, name);

      // Containment, symlink-proof: the deepest EXISTING ancestor of the target must
      // realpath-resolve inside the real repo root. Fail closed on any fs error.
      try {
        const repoReal = await realpath(repoPath);
        let probe = dirname(target);
        for (;;) {
          try {
            const real = await realpath(probe);
            if (real !== repoReal && !real.startsWith(repoReal + sep)) {
              return reply.code(400).send({ error: 'target escapes project' });
            }
            break;
          } catch {
            const parent = dirname(probe);
            if (parent === probe) return reply.code(400).send({ error: 'target escapes project' });
            probe = parent;
          }
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message || 'write failed' });
      }
      return { ok: true, filePath: target };
    },
  );
```

NOTE: `resolve` may be unused — trim imports to what's used. `resolveRepo`/`listProviders` are the consts already defined at the top of `customizationsRoutes`.

- [ ] **Step 4: Run — PASS.** `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** `feat(customizations): validated write endpoint for skills/agents`

---

### Task 3: POST /api/customizations/assist (Polish)

**Files:**
- Modify: `server/routes/customizations.ts`
- Test: `test/routes/routes-customizations-assist.test.ts`

**Interfaces:**
- Consumes: `provider.commands.headlessAsk(cwd, prompt): string[]` (exists on both providers), exec pattern from `server/lib/bridge/mcp.ts:177-189`.
- Produces: `POST /api/customizations/assist` body `{ projectId, provider, section: 'agents' | 'skills', name, draft }` → `200 { text }` | 400/404/502. New injectable `CustomizationsRouteOpts.runHeadless?: (argv: string[], cwd: string) => Promise<{ text: string; ok: boolean }>` so tests never spawn a binary.

- [ ] **Step 1: Write the failing tests**

```ts
// test/routes/routes-customizations-assist.test.ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import customizationsRoutes from '../../server/routes/customizations';

function app(runHeadless = async () => ({ text: 'polished md', ok: true })) {
  const f = Fastify();
  f.register(customizationsRoutes, {
    listProviders: async () => [
      { id: 'claude', customizations: {}, commands: { headlessAsk: (cwd: string, p: string) => ['claude', '-p', '--', p] } },
    ] as any,
    resolveRepo: async (id: string) => (id === 'known' ? '/repo' : null),
    runHeadless,
  });
  return f;
}
const post = (f: ReturnType<typeof app>, body: object) =>
  f.inject({ method: 'POST', url: '/api/customizations/assist', payload: body });
const base = { projectId: 'known', provider: 'claude', section: 'skills', name: 'my-skill', draft: 'do stuff' };

describe('POST /api/customizations/assist', () => {
  it('returns the headless result and passes the draft inside the prompt argv element', async () => {
    let argv: string[] = [];
    const f = app(async (a: string[]) => { argv = a; return { text: 'polished md', ok: true }; });
    const res = await post(f, base);
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe('polished md');
    expect(argv[argv.length - 1]).toContain('do stuff'); // draft rides in the final argv element, never a shell string
    expect(argv[argv.length - 1]).toContain('SKILL.md'); // prompt teaches the target format
  });
  it('404s unknown project, 400s unknown provider, 400s empty draft', async () => {
    expect((await post(app(), { ...base, projectId: 'nope' })).statusCode).toBe(404);
    expect((await post(app(), { ...base, provider: 'gemini' })).statusCode).toBe(400);
    expect((await post(app(), { ...base, draft: '' })).statusCode).toBe(400);
  });
  it('502s when the agent run fails', async () => {
    const res = await post(app(async () => ({ text: 'boom', ok: false })));
    expect(res.statusCode).toBe(502);
  });
});
```

(Last test: `post(app(async () => ({ text: 'boom', ok: false })), base)` — pass `base` as the body.)

- [ ] **Step 2: Run — FAIL** (route missing)

- [ ] **Step 3: Implement** — in `server/routes/customizations.ts`. Add to `CustomizationsRouteOpts`: `runHeadless?: (argv: string[], cwd: string) => Promise<{ text: string; ok: boolean }>;` and a default impl (execFile, mirrors mcp.ts):

```ts
import { execFile } from 'node:child_process';

function defaultRunHeadless(argv: string[], cwd: string): Promise<{ text: string; ok: boolean }> {
  const [bin, ...rest] = argv;
  return new Promise((resolve) => {
    const child = execFile(
      bin, rest,
      { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve({ text: (stdout || '').trim(), ok: !err }),
    );
    child.stdin?.end();
  });
}
```

Route (inside `customizationsRoutes`; `const runHeadless = opts.runHeadless ?? defaultRunHeadless;`):

```ts
  f.post<{ Body: { projectId?: string; provider?: string; section?: string; name?: string; draft?: string } }>(
    '/api/customizations/assist',
    async (req, reply) => {
      const { projectId, provider: providerId, section, name, draft } = req.body ?? {};
      if (section !== 'agents' && section !== 'skills') return reply.code(400).send({ error: 'bad section' });
      if (typeof draft !== 'string' || !draft.trim()) return reply.code(400).send({ error: 'empty draft' });
      const repoPath = projectId ? await resolveRepo(projectId) : null;
      if (!repoPath) return reply.code(404).send({ error: 'unknown project' });
      const providers = await listProviders();
      const provider = providers.find((p) => p.id === providerId);
      if (!provider?.commands?.headlessAsk) return reply.code(400).send({ error: 'unknown provider' });

      const kind = section === 'skills' ? 'a SKILL.md skill file' : 'an agent definition markdown file';
      const prompt =
        `You are polishing ${kind} named "${name ?? ''}" for a Claude Code project.\n` +
        `Rewrite the draft below into a complete, well-structured file. Requirements:\n` +
        `- Start with --- frontmatter containing name and a one-line description.\n` +
        `- Keep the author's intent; tighten wording; add missing sections a good ${section === 'skills' ? 'SKILL.md' : 'agent file'} needs.\n` +
        `- Output ONLY the file content, no commentary, no code fences.\n\nDRAFT:\n${draft}`;

      const { text, ok } = await runHeadless(provider.commands.headlessAsk(repoPath, prompt), repoPath);
      if (!ok) return reply.code(502).send({ error: text || 'agent run failed' });
      return { text };
    },
  );
```

- [ ] **Step 4: Run — PASS.** `npx tsc --noEmit` clean. Run the Task 2 file too (same route file changed).

- [ ] **Step 5: Commit** `feat(customizations): headless polish assist endpoint`

---

### Task 4: Client API + editor pane in CustomizationsModal

**Files:**
- Modify: `lib/client/api.ts`
- Modify: `components/CustomizationsModal/CustomizationsModal.tsx`
- Modify: `components/CustomizationsModal/CustomizationsModal.module.scss`

**Interfaces:**
- Consumes: Task 2/3 endpoints; existing `startSession` client fn (`lib/client/api.ts:139`, already takes `firstPrompt`); `useAppState` dispatch `openTerm` (see `Transcript.tsx:159-168` for the exact dispatch shape); `ui/Menu/Menu.module.scss` dropdown surface; `PROV` glyphs from `ProviderBadge`.
- Produces: editor UI. No new exports.

- [ ] **Step 1: API helpers** in `lib/client/api.ts` (near `getCustomizations`):

```ts
export function putCustomizationItem(body: {
  projectId: string; provider: ProviderId; section: 'agents' | 'skills'; name: string; content: string;
}): Promise<{ ok: true; filePath: string }> {
  return req('/api/customizations/item', { method: 'PUT', body: JSON.stringify(body) });
}

export function assistCustomization(body: {
  projectId: string; provider: ProviderId; section: 'agents' | 'skills'; name: string; draft: string;
}): Promise<{ text: string }> {
  return req('/api/customizations/assist', { method: 'POST', body: JSON.stringify(body) });
}
```

- [ ] **Step 2: Editor pane.** In `CustomizationsModal.tsx`:

State: `editing: { section: 'agents' | 'skills'; name: string; content: string; isNew: boolean } | null`, plus `saving`, `assisting`, `editorError`, `undoText: string | null`.

Entry points (project scope + claude items only — gate on `projectId` prop being set):
- `+ New` button in the section header when `section === 'agents' || section === 'skills'` → `setEditing({ section, name: '', content: '', isNew: true })`.
- `Edit` button in the item detail view (only for `item.provider === 'claude' && item.scope === 'project'`) → `setEditing({ section, name: kebabFromItem(item), content: item.content, isNew: false })` where `kebabFromItem` derives the name from the filePath (`SKILL.md` → parent dir name; agents → basename minus `.md`).

Editor pane (renders in place of the detail column):
- Name `TextInput` (from `components/ui/TextInput`), disabled when `!isNew`; live-kebab on change (`value.toLowerCase().replace(/[^a-z0-9-]+/g, '-')`); filename preview line under it: `.claude/skills/<name>/SKILL.md` or `.claude/agents/<name>.md`.
- `<textarea>` for content (module class, monospace via an existing `t-mono-*` mixin).
- Action row: `Save` (primary, disabled while saving or `!NAME_RE.test(name)`), `Cancel`, `Undo polish` (only when `undoText !== null`), then two dropdowns (compose `ui/Menu` styles + `Button`, same open/close pattern as BridgeMenu): **✦ Polish with ▾** (`✳ claude` / `⬡ codex`, disabled when content empty) and **◈ Make it for me ▾** (same providers).

Handlers:
```ts
async function handleSave() {
  if (!editing || !projectId) return;
  setSaving(true); setEditorError(null);
  try {
    await putCustomizationItem({ projectId, provider: 'claude', section: editing.section, name: editing.name, content: editing.content });
    setEditing(null); setUndoText(null);
    refetch(); // existing modal fetch-effect trigger — bump its reload key
  } catch (e) { setEditorError((e as Error).message || 'save failed'); }
  finally { setSaving(false); }
}

async function handlePolish(provider: ProviderId) {
  if (!editing || !projectId || assisting) return;
  setAssisting(true); setEditorError(null);
  try {
    const { text } = await assistCustomization({ projectId, provider, section: editing.section, name: editing.name, draft: editing.content });
    setUndoText(editing.content);
    setEditing({ ...editing, content: text });
  } catch (e) { setEditorError((e as Error).message || 'polish failed'); }
  finally { setAssisting(false); }
}

async function handleMakeIt(provider: ProviderId) {
  if (!editing || !project) return; // project = state.projects.find((p) => p.id === projectId)
  const file = editing.section === 'skills' ? `.claude/skills/${editing.name}/SKILL.md` : `.claude/agents/${editing.name}.md`;
  const brief =
    `Create ${file} in this repo${editing.content.trim() ? ` for this purpose:\n${editing.content}` : ` named "${editing.name}"`}.\n` +
    `Follow ${editing.section === 'skills' ? 'SKILL.md' : 'Claude Code agent-definition'} conventions (frontmatter with name + description, clear body). Write the file, then stop.`;
  try {
    const { tabMeta } = await startSession({ projectPath: project.path, provider, mode: 'new', firstPrompt: brief });
    dispatch({ type: 'openTerm', ptyId: tabMeta.ptyId, projectId: project.id, label: project.name, provider });
    onClose(); // watch the session work
  } catch (e) { setEditorError((e as Error).message || 'session start failed'); }
}
```

NOTE: the modal must gain `useAppState()` if it doesn't already have it, and `refetch` = whatever effect dependency the modal already uses to load `getCustomizations` (add a `reloadKey` state bumped after save, matching the Transcript retry pattern). Check `openTerm` action's required fields in `lib/client/store` and pass exactly those.

- [ ] **Step 3: Styles** in `CustomizationsModal.module.scss` — editor layout only (flex column, gap, textarea `flex: 1; min-height: 260px; resize: vertical;` background/border from tokens). All text via `t-*` mixins. Dropdown positioning classes compose `ui/Menu` (import as `menu` in the tsx like FilterMenu does).

- [ ] **Step 4: Verify** — `npx tsc --noEmit`, `npm run lint:styles`, `npm test` (all green).

- [ ] **Step 5: Commit** `feat(customizations): create/edit editor with polish + make-it-for-me`

---

### Task 5: End-to-end smoke + polish pass

**Files:** none new (fixes only)

- [ ] **Step 1:** `PORT=4900 npm run dev`, then browser-agent smoke: open project settings → Skills → `+ New` → type name `demo-skill` + body → Save → item appears in list; open it → Edit → change body → Save. Screenshot each state. (Do NOT click Polish/Make-it against real agents in the smoke run unless asked — they spawn real sessions/burn tokens.)
- [ ] **Step 2:** style-guardian subagent on the diff; fix findings.
- [ ] **Step 3:** Full `npm test` + `npx tsc --noEmit` green.
- [ ] **Step 4:** Commit any fixes; branch ready for PR.

## Self-review notes

- Spec coverage: form+write (T2/T4), provider seam (T1), polish (T3/T4), make-it (T4, reuses `firstPrompt`), errors inline (T4), tests for traversal/name/size/symlink (T2). Marketplace = phase 2, out of scope here. Frontmatter scaffolding happens via the polish prompt + user; the server does NOT inject frontmatter (spec said "scaffolded if the user doesn't write it" — the UI seeds NEW skill textareas with a `---\nname: <name>\ndescription: \n---\n` template instead; implementer: add that seed string in the `+ New` handler).
- Global-scope writes: seam supports it (T1 test), route only exposes project scope in v1 — matches spec.
- Types consistent: `section: 'agents' | 'skills'` everywhere; `{ text }` assist payload; `{ ok, filePath }` write payload.

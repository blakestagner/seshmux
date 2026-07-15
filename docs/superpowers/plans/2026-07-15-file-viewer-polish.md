# File Viewer Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VSCode-class file views in the ChangesPanel — per-filetype glyph+color in the tree, syntax-highlighted diffs, and a Diff|Full toggle with a full-file view.

**Architecture:** highlight.js lazy-loaded client-side, themed via new `--syn-*` CSS vars in `styles/tokens.scss` mapped from `hljs-*` classes in a new global `styles/syntax.scss`. A pure `lib/client/file-glyphs.ts` map drives tree glyphs/tints via new `--ft-*` tokens. A new `GET /api/git/file` route serves working-tree file content (contained, capped, binary-sniffed) for the Full view.

**Tech Stack:** Next.js 15, SCSS modules, highlight.js (new dep, client-only), Fastify, vitest.

## Global Constraints

- Hard rule 1: text styled ONLY via `styles/typography.scss` `t-*` mixins; module scss = layout/spacing/state/color. `npm run lint:styles` must pass.
- All colors are tokens in `styles/tokens.scss` (dark + light values for every new var).
- Hard rule 3: no `~/.claude`/`~/.codex` paths outside `server/lib/providers/` (nothing here should need them).
- Hard rule 5: generic glyphs only, no brand icon fonts.
- Tests: `nvm use 22.22.3` first; run single files while iterating (`npx vitest run <file>`).
- Highlighting must NEVER block or break the viewer — every failure path renders plain text.
- Commit with pathspec (`git commit -- <paths>`); other agents may share the tree.

---

### Task 1: Syntax + filetype color tokens, hljs theme stylesheet, dependency

**Files:**
- Modify: `styles/tokens.scss` (append inside both theme blocks)
- Create: `styles/syntax.scss`
- Modify: `styles/globals.scss` (one `@use` line)
- Modify: `package.json` via `npm i highlight.js`

**Interfaces:**
- Produces: CSS vars `--syn-keyword --syn-string --syn-number --syn-comment --syn-function --syn-type --syn-tag --syn-attr --syn-punct --syn-variable` and `--ft-styles --ft-script-ts --ft-script-js --ft-test --ft-config --ft-docs --ft-image --ft-shell --ft-markup --ft-dim`; global `hljs-*` class styling; `highlight.js` installed.

- [ ] **Step 1: Install dependency**

```bash
npm i highlight.js
```

- [ ] **Step 2: Add tokens.** In `styles/tokens.scss`, append to the END of the `:root[data-theme="dark"]` block:

```scss
  // Syntax highlighting (changes panel diff/full views). Hues sit in the
  // muted VSCode-dark register; contrast tuned for #0f0f12 family bg.
  --syn-keyword: #c792ea;
  --syn-string: #9ece8c;
  --syn-number: #f2b76e;
  --syn-comment: #63636b; // = --text-faint
  --syn-function: #82aaff;
  --syn-type: #5fd0c7;
  --syn-tag: #e06c75;
  --syn-attr: #d8b56c;
  --syn-punct: #9a9aa3; // = --text-dim
  --syn-variable: #e9e9ec; // = --text
  // Filetype identity (tree glyphs + name tints).
  --ft-styles: #e26fa8;
  --ft-script-ts: #6cb2f0;
  --ft-script-js: #d8b56c;
  --ft-test: #4bb87a; // = --live
  --ft-config: #9a9aa3;
  --ft-docs: #5fd0c7;
  --ft-image: #b48ee8;
  --ft-shell: #7fbf6a;
  --ft-markup: #e0885f;
  --ft-dim: #63636b; // lockfiles/generated
```

And to the END of the `:root[data-theme="light"]` block (darkened for near-white bg):

```scss
  // Syntax highlighting — darkened for contrast on near-white bg.
  --syn-keyword: #8f4bbf;
  --syn-string: #3e7d3a;
  --syn-number: #a25d0e;
  --syn-comment: #9a9aa1; // = --text-faint
  --syn-function: #2a5fb8;
  --syn-type: #157f76;
  --syn-tag: #b3403c;
  --syn-attr: #8a6410;
  --syn-punct: #6b6b73; // = --text-dim
  --syn-variable: #1d1d21; // = --text
  // Filetype identity.
  --ft-styles: #b8437e;
  --ft-script-ts: #2a6fb8;
  --ft-script-js: #8a6410;
  --ft-test: #2f9e63; // = --live
  --ft-config: #6b6b73;
  --ft-docs: #157f76;
  --ft-image: #7a4fc0;
  --ft-shell: #3e7d3a;
  --ft-markup: #a25428;
  --ft-dim: #9a9aa1;
```

- [ ] **Step 3: Create `styles/syntax.scss`** mapping hljs classes → vars (global, not a module — hljs emits bare classes):

```scss
// highlight.js class → design-token mapping. The ONLY place hljs-* classes
// are styled; colors live in tokens.scss (--syn-*), both themes covered there.
.hljs-keyword, .hljs-literal, .hljs-selector-tag, .hljs-built_in { color: var(--syn-keyword); }
.hljs-string, .hljs-regexp, .hljs-addition { color: var(--syn-string); }
.hljs-number, .hljs-symbol { color: var(--syn-number); }
.hljs-comment, .hljs-quote, .hljs-deletion { color: var(--syn-comment); }
.hljs-title, .hljs-title.function_, .hljs-section { color: var(--syn-function); }
.hljs-type, .hljs-class .hljs-title, .hljs-title.class_ { color: var(--syn-type); }
.hljs-tag, .hljs-name { color: var(--syn-tag); }
.hljs-attr, .hljs-attribute, .hljs-selector-attr, .hljs-selector-class, .hljs-selector-id, .hljs-meta { color: var(--syn-attr); }
.hljs-punctuation, .hljs-operator { color: var(--syn-punct); }
.hljs-variable, .hljs-template-variable, .hljs-params, .hljs-property { color: var(--syn-variable); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }
```

- [ ] **Step 4: Import it.** In `styles/globals.scss` add alongside the existing global imports:

```scss
@use './syntax';
```

- [ ] **Step 5: Verify**

Run: `npm run lint:styles && npx tsc --noEmit` — both clean (syntax.scss is not a component module; the lint bans raw font props in `components/**/*.module.scss` only, and syntax.scss sets no font props anyway).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json styles/tokens.scss styles/syntax.scss styles/globals.scss
git commit -m "feat(viewer): syntax + filetype color tokens, hljs theme" -- package.json package-lock.json styles/tokens.scss styles/syntax.scss styles/globals.scss
```

---

### Task 2: `lib/client/highlight.ts` — language map + lazy hljs

**Files:**
- Create: `lib/client/highlight.ts`
- Test: `test/lib/highlight.test.ts`

**Interfaces:**
- Produces:
  - `languageFor(path: string): string | null` — hljs language id or null (plain).
  - `loadHighlighter(): Promise<Highlighter>` where `Highlighter = { line(code: string, lang: string | null): string }` — returns SAFE HTML (escaped by hljs; plain path escapes manually). Lazy singleton; never rejects (falls back to a plain-text escaper if import fails).

- [ ] **Step 1: Write failing tests** — `test/lib/highlight.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { escapeHtml, languageFor } from '../../lib/client/highlight';

describe('languageFor', () => {
  it('maps common extensions', () => {
    expect(languageFor('a/b/store.ts')).toBe('typescript');
    expect(languageFor('x.tsx')).toBe('typescript');
    expect(languageFor('x.jsx')).toBe('javascript');
    expect(languageFor('x.module.scss')).toBe('scss');
    expect(languageFor('Dockerfile')).toBe('dockerfile');
    expect(languageFor('x.py')).toBe('python');
    expect(languageFor('x.twig')).toBe('twig');
  });
  it('null for unknown', () => {
    expect(languageFor('x.blob')).toBeNull();
    expect(languageFor('LICENSE')).toBeNull();
  });
});

describe('escapeHtml', () => {
  it('escapes', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});
```

- [ ] **Step 2: Run to fail:** `npx vitest run test/lib/highlight.test.ts` — FAIL (module not found).

- [ ] **Step 3: Implement `lib/client/highlight.ts`:**

```ts
// Lazy syntax highlighting for the changes panel. highlight.js is imported on
// first use only (dynamic import) so the app pays nothing until a file view
// opens. Every failure path degrades to escaped plain text — highlighting is
// cosmetic and must never block or break the viewer.

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  scss: 'scss', css: 'css', sass: 'scss', less: 'less',
  json: 'json', jsonc: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  md: 'markdown', mdx: 'markdown',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', twig: 'twig',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', swift: 'swift',
  sql: 'sql', graphql: 'graphql', proto: 'protobuf', diff: 'diff',
};
const NAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile', makefile: 'makefile',
};

export function languageFor(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (NAME_LANG[base]) return NAME_LANG[base];
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXT_LANG[base.slice(dot + 1)] ?? null;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface Highlighter {
  /** Highlighted HTML for ONE line. Safe to inject (hljs escapes; plain path escapes here). */
  line(code: string, lang: string | null): string;
}

const plain: Highlighter = { line: (code) => escapeHtml(code) };
let loading: Promise<Highlighter> | null = null;

export function loadHighlighter(): Promise<Highlighter> {
  if (!loading) {
    loading = import('highlight.js')
      .then((mod) => {
        const hljs = mod.default;
        return {
          line(code: string, lang: string | null): string {
            if (!lang || !hljs.getLanguage(lang)) return escapeHtml(code);
            try {
              return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
            } catch {
              return escapeHtml(code);
            }
          },
        };
      })
      .catch(() => plain); // import failed — degrade forever, don't retry-loop
  }
  return loading;
}
```

(Spec allowed bounded auto-detect for unknown extensions; dropped — per-line auto-detect is noisy and slow. Unknown → plain. ponytail: add `highlightAuto` with a subset only if plain files feel wrong in practice.)

- [ ] **Step 4: Run to pass:** `npx vitest run test/lib/highlight.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/client/highlight.ts test/lib/highlight.test.ts
git commit -m "feat(viewer): language map + lazy highlight.js loader" -- lib/client/highlight.ts test/lib/highlight.test.ts
```

---

### Task 3: `lib/client/file-glyphs.ts` — filetype glyph/color map

**Files:**
- Create: `lib/client/file-glyphs.ts`
- Test: `test/lib/file-glyphs.test.ts`

**Interfaces:**
- Produces: `glyphFor(name: string): { glyph: string; colorVar: string }` — `name` is the basename (Row has `node.name`); `colorVar` is a CSS var name string like `'--ft-script-ts'`.

- [ ] **Step 1: Failing tests** — `test/lib/file-glyphs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { glyphFor } from '../../lib/client/file-glyphs';

describe('glyphFor', () => {
  it('categorizes by extension', () => {
    expect(glyphFor('Rail.module.scss')).toEqual({ glyph: '✿', colorVar: '--ft-styles' });
    expect(glyphFor('store.ts')).toEqual({ glyph: '◆', colorVar: '--ft-script-ts' });
    expect(glyphFor('ensure.js')).toEqual({ glyph: '◆', colorVar: '--ft-script-js' });
    expect(glyphFor('README.md')).toEqual({ glyph: '¶', colorVar: '--ft-docs' });
    expect(glyphFor('logo.svg')).toEqual({ glyph: '▣', colorVar: '--ft-image' });
    expect(glyphFor('build.sh')).toEqual({ glyph: '$', colorVar: '--ft-shell' });
    expect(glyphFor('index.html')).toEqual({ glyph: '‹›', colorVar: '--ft-markup' });
    expect(glyphFor('settings.json')).toEqual({ glyph: '⚙', colorVar: '--ft-config' });
  });
  it('test files win over language', () => {
    expect(glyphFor('brief.test.ts')).toEqual({ glyph: '✓', colorVar: '--ft-test' });
    expect(glyphFor('x.spec.tsx')).toEqual({ glyph: '✓', colorVar: '--ft-test' });
  });
  it('specials and lockfiles', () => {
    expect(glyphFor('Dockerfile')).toEqual({ glyph: '⚙', colorVar: '--ft-config' });
    expect(glyphFor('package-lock.json')).toEqual({ glyph: '·', colorVar: '--ft-dim' });
  });
  it('fallback', () => {
    expect(glyphFor('LICENSE')).toEqual({ glyph: '·', colorVar: '--ft-dim' });
  });
});
```

- [ ] **Step 2: Run to fail:** `npx vitest run test/lib/file-glyphs.test.ts` — FAIL.

- [ ] **Step 3: Implement `lib/client/file-glyphs.ts`:**

```ts
// Filetype → glyph + color-token for the changes-panel tree. Generic glyphs
// only (hard rule 5). Colors are --ft-* tokens (tokens.scss, both themes).

export interface FileGlyph {
  glyph: string;
  colorVar: string;
}

const FALLBACK: FileGlyph = { glyph: '·', colorVar: '--ft-dim' };

const BY_NAME: Record<string, FileGlyph> = {
  'dockerfile': { glyph: '⚙', colorVar: '--ft-config' },
  'makefile': { glyph: '⚙', colorVar: '--ft-config' },
  'package-lock.json': FALLBACK,
  'yarn.lock': FALLBACK,
  'pnpm-lock.yaml': FALLBACK,
};

const BY_EXT: Record<string, FileGlyph> = {
  scss: { glyph: '✿', colorVar: '--ft-styles' }, css: { glyph: '✿', colorVar: '--ft-styles' },
  sass: { glyph: '✿', colorVar: '--ft-styles' }, less: { glyph: '✿', colorVar: '--ft-styles' },
  ts: { glyph: '◆', colorVar: '--ft-script-ts' }, tsx: { glyph: '◆', colorVar: '--ft-script-ts' },
  mts: { glyph: '◆', colorVar: '--ft-script-ts' }, cts: { glyph: '◆', colorVar: '--ft-script-ts' },
  js: { glyph: '◆', colorVar: '--ft-script-js' }, jsx: { glyph: '◆', colorVar: '--ft-script-js' },
  mjs: { glyph: '◆', colorVar: '--ft-script-js' }, cjs: { glyph: '◆', colorVar: '--ft-script-js' },
  json: { glyph: '⚙', colorVar: '--ft-config' }, jsonc: { glyph: '⚙', colorVar: '--ft-config' },
  yml: { glyph: '⚙', colorVar: '--ft-config' }, yaml: { glyph: '⚙', colorVar: '--ft-config' },
  toml: { glyph: '⚙', colorVar: '--ft-config' }, ini: { glyph: '⚙', colorVar: '--ft-config' },
  md: { glyph: '¶', colorVar: '--ft-docs' }, mdx: { glyph: '¶', colorVar: '--ft-docs' },
  png: { glyph: '▣', colorVar: '--ft-image' }, jpg: { glyph: '▣', colorVar: '--ft-image' },
  jpeg: { glyph: '▣', colorVar: '--ft-image' }, gif: { glyph: '▣', colorVar: '--ft-image' },
  svg: { glyph: '▣', colorVar: '--ft-image' }, webp: { glyph: '▣', colorVar: '--ft-image' },
  ico: { glyph: '▣', colorVar: '--ft-image' },
  sh: { glyph: '$', colorVar: '--ft-shell' }, bash: { glyph: '$', colorVar: '--ft-shell' },
  zsh: { glyph: '$', colorVar: '--ft-shell' },
  html: { glyph: '‹›', colorVar: '--ft-markup' }, htm: { glyph: '‹›', colorVar: '--ft-markup' },
  xml: { glyph: '‹›', colorVar: '--ft-markup' }, vue: { glyph: '‹›', colorVar: '--ft-markup' },
  twig: { glyph: '‹›', colorVar: '--ft-markup' },
  py: { glyph: '◆', colorVar: '--ft-docs' }, rb: { glyph: '◆', colorVar: '--ft-markup' },
  go: { glyph: '◆', colorVar: '--ft-script-ts' }, rs: { glyph: '◆', colorVar: '--ft-markup' },
};

export function glyphFor(name: string): FileGlyph {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  // test/spec wins over language color — scanning for tests is the point.
  if (/\.(test|spec)\.[^.]+$/.test(lower)) return { glyph: '✓', colorVar: '--ft-test' };
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return FALLBACK;
  return BY_EXT[lower.slice(dot + 1)] ?? FALLBACK;
}
```

- [ ] **Step 4: Run to pass:** `npx vitest run test/lib/file-glyphs.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/client/file-glyphs.ts test/lib/file-glyphs.test.ts
git commit -m "feat(viewer): filetype glyph/color map" -- lib/client/file-glyphs.ts test/lib/file-glyphs.test.ts
```

---

### Task 4: Tree rows render glyph + tinted name

**Files:**
- Modify: `components/ChangesPanel/ChangesPanel.tsx` (Row, ~:55-63)
- Modify: `components/ChangesPanel/ChangesPanel.module.scss`

**Interfaces:**
- Consumes: `glyphFor(name)` from Task 3.
- Produces: no new exports; visual change only.

- [ ] **Step 1: Modify `Row`.** Import at top of ChangesPanel.tsx:

```ts
import { glyphFor } from '../../lib/client/file-glyphs';
```

Replace the caret/name block (current lines 55-63) with:

```tsx
        {hasDirShape ? (
          <span className={styles.caret}>{isCollapsed ? '▸' : '▾'}</span>
        ) : (
          <span className={styles.glyph} style={{ color: `var(${glyphFor(node.name).colorVar})` }}>
            {glyphFor(node.name).glyph}
          </span>
        )}
        <span
          className={`${styles.name} ${node.change?.status === 'D' ? styles.deleted : ''}`}
          style={!hasDirShape ? { color: `var(${glyphFor(node.name).colorVar})` } : undefined}
        >
          {node.name}
          {hasDirShape ? '/' : ''}
        </span>
```

(Call `glyphFor` once into a local `const fg = hasDirShape ? null : glyphFor(node.name);` above the return — three calls is silly.) The `.deleted` class comes after `styles.name` so its `color: var(--text-faint)` must win — keep `.deleted` declaring color and it does (same specificity, later in file). Unchanged files stay dimmer than changed via opacity, not color (next step), so the hue survives.

- [ ] **Step 2: Styles.** In `ChangesPanel.module.scss`, replace `.caretSpacer` usage: keep the class (other code may use it) and add:

```scss
.glyph {
  flex: 0 0 auto;
  width: 12px;
  text-align: center;
}

// Filetype hue at reduced strength for unchanged rows — changed rows get the
// full-saturation name so the working set still pops out of the tree.
.row:not(.rowChanged) .name,
.row:not(.rowChanged) .glyph {
  opacity: 0.55;
}
```

And DELETE the now-dead `.caretSpacer` block if nothing else references it (grep first: `grep -rn caretSpacer components/`).

- [ ] **Step 3: Verify:** `npm run lint:styles && npx tsc --noEmit` clean. `npm run dev` (port 4800) → open a project's changes panel → tree shows colored glyphs; deleted files still strike through; changed rows brighter.

- [ ] **Step 4: Commit**

```bash
git add components/ChangesPanel/ChangesPanel.tsx components/ChangesPanel/ChangesPanel.module.scss
git commit -m "feat(viewer): filetype glyphs + tinted names in changes tree" -- components/ChangesPanel/ChangesPanel.tsx components/ChangesPanel/ChangesPanel.module.scss
```

---

### Task 5: Server — `GET /api/git/file` (contained, capped, binary-sniffed)

**Files:**
- Modify: `server/lib/git-stats.ts` (new `readWorkingFile`)
- Modify: `server/routes/git.ts` (new route)
- Test: `test/routes/routes-git.test.ts` (extend — it already builds a real temp git repo; follow its existing fixture pattern)

**Interfaces:**
- Consumes: `resolveTarget` (already in git.ts).
- Produces: `readWorkingFile(dir: string, relPath: string): Promise<{ content: string; truncated: boolean } | { binary: true } | null>` (null = missing/outside); route `GET /api/git/file?project=&branch=&path=` → 200 `{content, truncated}` | 200 `{binary:true}` | 404 `{error}` | 400 `{error}`.

- [ ] **Step 1: Failing tests** — append to `test/routes/routes-git.test.ts` (reuse its existing app/fixture helpers; adapt names to the file's actual pattern):

```ts
describe('GET /api/git/file', () => {
  it('returns working-tree content', async () => {
    // fixture: write `src/a.ts` with known content in the temp repo
    const res = await app.inject({ url: `/api/git/file?project=${pid}&path=src/a.ts` });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toContain('known content marker');
    expect(res.json().truncated).toBe(false);
  });
  it('rejects traversal and absolute paths', async () => {
    for (const p of ['../etc/passwd', '..%2F..%2Fetc%2Fpasswd', '/etc/passwd']) {
      const res = await app.inject({ url: `/api/git/file?project=${pid}&path=${encodeURIComponent(p)}` });
      expect([400, 404]).toContain(res.statusCode);
    }
  });
  it('rejects symlink escape', async () => {
    // fixture: fs.symlinkSync('/etc', join(repoDir, 'esc'))
    const res = await app.inject({ url: `/api/git/file?project=${pid}&path=esc/passwd` });
    expect([400, 404]).toContain(res.statusCode);
  });
  it('flags binary', async () => {
    // fixture: write Buffer.from([0x89, 0x50, 0x00, 0x47]) as bin.png
    const res = await app.inject({ url: `/api/git/file?project=${pid}&path=bin.png` });
    expect(res.json().binary).toBe(true);
  });
  it('truncates past 5000 lines', async () => {
    // fixture: 6000-line file
    const res = await app.inject({ url: `/api/git/file?project=${pid}&path=big.txt` });
    expect(res.json().truncated).toBe(true);
    expect(res.json().content.split('\n').length).toBe(5000);
  });
});
```

- [ ] **Step 2: Run to fail:** `npx vitest run test/routes/routes-git.test.ts` — new tests FAIL (404 route not found).

- [ ] **Step 3: Implement `readWorkingFile` in `server/lib/git-stats.ts`** (near `fileDiff`, reusing `MAX_DIFF_LINES`):

```ts
const MAX_FILE_BYTES = 1_000_000;

/**
 * Working-tree file content for the panel's Full view. Containment fails
 * CLOSED (hard-rule-7 spirit): relative path only, resolved result must stay
 * under realpath(dir) — symlinked files/dirs that escape are rejected, git
 * cannot be asked to answer for them.
 */
export async function readWorkingFile(
  dir: string,
  relPath: string,
): Promise<{ content: string; truncated: boolean } | { binary: true } | null> {
  if (!relPath || path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) return null;
  let real: string;
  let rootReal: string;
  try {
    rootReal = await fs.realpath(dir);
    real = await fs.realpath(path.resolve(dir, relPath)); // ENOENT → catch → null
  } catch {
    return null;
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
  const stat = await fs.stat(real).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_FILE_BYTES * 4) return null; // absurd size: don't even read
  const buf = await fs.readFile(real).catch(() => null);
  if (!buf) return null;
  if (buf.subarray(0, 8192).includes(0)) return { binary: true };
  const text = buf.subarray(0, MAX_FILE_BYTES).toString('utf8');
  const lines = text.split('\n');
  if (lines.length <= MAX_DIFF_LINES && buf.length <= MAX_FILE_BYTES) return { content: text, truncated: false };
  return { content: lines.slice(0, MAX_DIFF_LINES).join('\n'), truncated: true };
}
```

(Check git-stats.ts's existing imports: it needs `path` and `fs` from `node:fs/promises` — add whichever is missing, matching its current import style.)

- [ ] **Step 4: Route in `server/routes/git.ts`** after the changes/file handler:

```ts
  // Whole working-tree file for the panel's Full view. Read-only, contained.
  f.get<{ Querystring: { project?: string; branch?: string; path?: string } }>(
    '/api/git/file',
    async (req, reply) => {
      const { project, branch, path: relPath } = req.query;
      if (!project || !relPath) {
        reply.code(400);
        return { error: 'project and path are required' };
      }
      const target = await resolveTarget(project, branch);
      if (!target) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const file = await readWorkingFile(target.dir, relPath);
      if (!file) {
        reply.code(404);
        return { error: 'file not found' };
      }
      return file;
    },
  );
```

Import: add `readWorkingFile` to the existing `from '../lib/git-stats'` import.

- [ ] **Step 5: Run to pass:** `npx vitest run test/routes/routes-git.test.ts` — PASS. Also `npx tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add server/lib/git-stats.ts server/routes/git.ts test/routes/routes-git.test.ts
git commit -m "feat(git): GET /api/git/file — contained working-tree file read" -- server/lib/git-stats.ts server/routes/git.ts test/routes/routes-git.test.ts
```

---

### Task 6: Viewer — syntax-highlighted diff, Diff|Full toggle, full-file view

**Files:**
- Modify: `lib/client/api.ts` (add `getGitFile`)
- Modify: `components/ChangesPanel/ChangesPanel.tsx`
- Modify: `components/ChangesPanel/ChangesPanel.module.scss`

**Interfaces:**
- Consumes: `languageFor`/`loadHighlighter` (Task 2), `GET /api/git/file` (Task 5), `glyphFor` (Task 3, already wired).
- Produces: `getGitFile(projectId: string, branch: string | null | undefined, path: string): Promise<{ content?: string; truncated?: boolean; binary?: boolean }>` in api.ts.

- [ ] **Step 1: api client.** In `lib/client/api.ts` next to `getGitFileDiff` (follow its exact fetch/query style — read it first):

```ts
export function getGitFile(
  projectId: string,
  branch: string | null | undefined,
  path: string,
): Promise<{ content?: string; truncated?: boolean; binary?: boolean }> {
  const q = new URLSearchParams({ project: projectId, path });
  if (branch) q.set('branch', branch);
  return apiGet(`/api/git/file?${q}`);
}
```

(`apiGet` = whatever helper getGitFileDiff uses; mirror it exactly, including auth token handling.)

- [ ] **Step 2: ChangesPanel state.** Changes to `ChangesPanel.tsx`:

New imports:

```ts
import { getGitFile } from '../../lib/client/api';
import { languageFor, loadHighlighter, escapeHtml, type Highlighter } from '../../lib/client/highlight';
```

New state next to the existing diff state:

```ts
  const [viewMode, setViewMode] = useState<'diff' | 'full'>('diff');
  const [fullFile, setFullFile] = useState<{ content: string; truncated: boolean } | 'binary' | 'missing' | null>(null);
  const [hl, setHl] = useState<Highlighter | null>(null);
```

Kick the lazy highlighter on first file open (inside `openFileDiff`, fire-and-forget):

```ts
    if (!hl) void loadHighlighter().then(setHl);
```

`openFileDiff` also resets: `setViewMode('diff'); setFullFile(null);`. The reset-everything effect (current :158-174) additionally resets `viewMode`/`fullFile`.

Unchanged files become openable: in `Row`, change the file onClick from `node.change ? () => onOpenFile(node.change!) : undefined` to always `() => onOpenFile(node)` for non-dir rows, and change `onOpenFile`'s type to `(node: TreeNode) => void`. In the panel, `openFileDiff(node)` derives: `const change = node.change ?? null;` and keeps `openFile` state as `{ path: string; change: FileChange | null }` (adjust the header render: title = `openFile.path`, totals only when `openFile.change`). For a no-change file skip the diff fetch, set `setViewMode('full')` and load the full file directly.

Full-file fetch (called when toggling to full or opening an unchanged file):

```ts
  const loadFull = (p: string) => {
    setFullFile(null);
    getGitFile(projectId, branch, p)
      .then((res) => {
        if (openPathRef.current !== p) return;
        if (res.binary) setFullFile('binary');
        else if (typeof res.content === 'string') setFullFile({ content: res.content, truncated: !!res.truncated });
        else setFullFile('missing');
      })
      .catch(() => {
        if (openPathRef.current === p) setFullFile('missing');
      });
  };
```

- [ ] **Step 3: Toggle UI.** In the header's open-file branch, after the title (compose chip Buttons — no new primitive; 2 states don't earn a segmented control):

```tsx
            {openFile.change ? (
              <span className={styles.viewToggle}>
                <Button variant="chip" className={viewMode === 'diff' ? styles.toggleActive : ''} onClick={() => setViewMode('diff')}>
                  diff
                </Button>
                <Button
                  variant="chip"
                  className={viewMode === 'full' ? styles.toggleActive : ''}
                  onClick={() => {
                    setViewMode('full');
                    if (fullFile === null) loadFull(openFile.path);
                  }}
                >
                  full
                </Button>
              </span>
            ) : null}
```

- [ ] **Step 4: Highlighted rendering.** Rewrite `DiffView` to take the language + highlighter:

```tsx
function CodeText({ text, lang, hl }: { text: string; lang: string | null; hl: Highlighter | null }) {
  const html = hl ? hl.line(text, lang) : escapeHtml(text);
  // Safe: hljs escapes its input; the plain path is escapeHtml. Never raw text.
  return <span className={styles.diffText} dangerouslySetInnerHTML={{ __html: html }} />;
}

function DiffView({ lines, lang, hl }: { lines: DiffLine[]; lang: string | null; hl: Highlighter | null }) {
  return (
    <div className={styles.diff}>
      {lines.map((l, i) =>
        l.kind === 'hunk' ? (
          <div key={i} className={styles.diffHunk}>{l.text}</div>
        ) : (
          <div key={i} className={`${styles.diffLine} ${l.kind === 'add' ? styles.diffAdd : l.kind === 'del' ? styles.diffDel : ''}`}>
            <span className={styles.diffGutter}>{l.oldNo ?? ''}</span>
            <span className={styles.diffGutter}>{l.newNo ?? ''}</span>
            <span className={styles.diffMarker}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
            <CodeText text={l.text} lang={lang} hl={hl} />
          </div>
        ),
      )}
    </div>
  );
}

function FullView({ content, lang, hl, addedLines }: { content: string; lang: string | null; hl: Highlighter | null; addedLines: Set<number> }) {
  return (
    <div className={styles.diff}>
      {content.split('\n').map((text, i) => (
        <div key={i} className={`${styles.diffLine} ${addedLines.has(i + 1) ? styles.diffAdd : ''}`}>
          <span className={styles.diffGutter}>{i + 1}</span>
          <CodeText text={text} lang={lang} hl={hl} />
        </div>
      ))}
    </div>
  );
}
```

`addedLines` computed in the panel: `new Set((diffLines ?? []).filter(l => l.kind === 'add' && l.newNo != null).map(l => l.newNo!))` — memoize with `useMemo` on `diffLines`. For unchanged files it's the empty set (no diff fetched). `lang` = `useMemo(() => openFile ? languageFor(openFile.path) : null, [openFile])`.

Body render branch: `viewMode === 'full'` → loading / `'binary'` → "binary file" notice / `'missing'` → "file not found" / content → `<FullView …>` + truncation notice reusing the existing `.empty` pattern; else the existing diff branch (now passing `lang`/`hl` to `DiffView`).

- [ ] **Step 5: Styles.** Add to `ChangesPanel.module.scss`:

```scss
.viewToggle {
  display: inline-flex;
  gap: 4px;
  flex: 0 0 auto;
}

.toggleActive {
  background: var(--accent-soft);
  color: var(--accent);
}
```

- [ ] **Step 6: Verify:** `npm run lint:styles && npx tsc --noEmit && npx vitest run test/lib` clean. Dev-server check (:4800): open changed file → highlighted diff, toggle full → whole file with add-tints; open unchanged file → straight to full; open a .png → binary notice; both themes (toggle in UI) readable.

- [ ] **Step 7: Commit**

```bash
git add lib/client/api.ts components/ChangesPanel/ChangesPanel.tsx components/ChangesPanel/ChangesPanel.module.scss
git commit -m "feat(viewer): syntax-highlighted diff, Diff|Full toggle, full-file view" -- lib/client/api.ts components/ChangesPanel/ChangesPanel.tsx components/ChangesPanel/ChangesPanel.module.scss
```

---

### Task 7: Verification pass

**Files:** none created (screenshots to scratchpad only).

- [ ] **Step 1: Full gates:** `nvm use 22.22.3; npm test && npx tsc --noEmit` — all green.
- [ ] **Step 2: Visual verification (browser subagent).** No Playwright MCP — subagent writes a standalone node script (`npm i --no-save playwright`; chromium cached). Screenshot: tree with mixed filetypes, a highlighted diff, a full view, in BOTH themes. VERIFY THE SCREENSHOTS, not bounding boxes (marketplace-handoff invariant 5).
- [ ] **Step 3: style-guardian subagent** over the branch diff (scss + component changes) — must PASS.
- [ ] **Step 4: Fix anything found, commit fixes with pathspec.**

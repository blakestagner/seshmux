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

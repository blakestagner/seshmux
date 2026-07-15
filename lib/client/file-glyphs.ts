// Filetype → glyph + category for the changes-panel tree. Generic glyphs
// only (hard rule 5). Categories map to `.ft*` classes in
// ChangesPanel.module.scss, which resolve to --ft-* tokens (tokens.scss,
// both themes).

export type FileGlyphCategory =
  | 'styles'
  | 'scriptTs'
  | 'scriptJs'
  | 'test'
  | 'config'
  | 'docs'
  | 'image'
  | 'shell'
  | 'markup'
  | 'dim';

export interface FileGlyph {
  glyph: string;
  category: FileGlyphCategory;
}

const FALLBACK: FileGlyph = { glyph: '·', category: 'dim' };

const BY_NAME: Record<string, FileGlyph> = {
  'dockerfile': { glyph: '⚙', category: 'config' },
  'makefile': { glyph: '⚙', category: 'config' },
  'package-lock.json': FALLBACK,
  'yarn.lock': FALLBACK,
  'pnpm-lock.yaml': FALLBACK,
};

const BY_EXT: Record<string, FileGlyph> = {
  scss: { glyph: '✿', category: 'styles' }, css: { glyph: '✿', category: 'styles' },
  sass: { glyph: '✿', category: 'styles' }, less: { glyph: '✿', category: 'styles' },
  ts: { glyph: '◆', category: 'scriptTs' }, tsx: { glyph: '◆', category: 'scriptTs' },
  mts: { glyph: '◆', category: 'scriptTs' }, cts: { glyph: '◆', category: 'scriptTs' },
  js: { glyph: '◆', category: 'scriptJs' }, jsx: { glyph: '◆', category: 'scriptJs' },
  mjs: { glyph: '◆', category: 'scriptJs' }, cjs: { glyph: '◆', category: 'scriptJs' },
  json: { glyph: '⚙', category: 'config' }, jsonc: { glyph: '⚙', category: 'config' },
  yml: { glyph: '⚙', category: 'config' }, yaml: { glyph: '⚙', category: 'config' },
  toml: { glyph: '⚙', category: 'config' }, ini: { glyph: '⚙', category: 'config' },
  md: { glyph: '¶', category: 'docs' }, mdx: { glyph: '¶', category: 'docs' },
  png: { glyph: '▣', category: 'image' }, jpg: { glyph: '▣', category: 'image' },
  jpeg: { glyph: '▣', category: 'image' }, gif: { glyph: '▣', category: 'image' },
  svg: { glyph: '▣', category: 'image' }, webp: { glyph: '▣', category: 'image' },
  ico: { glyph: '▣', category: 'image' },
  sh: { glyph: '$', category: 'shell' }, bash: { glyph: '$', category: 'shell' },
  zsh: { glyph: '$', category: 'shell' },
  html: { glyph: '‹›', category: 'markup' }, htm: { glyph: '‹›', category: 'markup' },
  xml: { glyph: '‹›', category: 'markup' }, vue: { glyph: '‹›', category: 'markup' },
  twig: { glyph: '‹›', category: 'markup' },
  // ponytail: py/rb/go/rs borrow other categories purely for their HUE (teal/
  // orange/blue) — give them their own --ft-* tokens if any category restyles.
  py: { glyph: '◆', category: 'docs' }, rb: { glyph: '◆', category: 'markup' },
  go: { glyph: '◆', category: 'scriptTs' }, rs: { glyph: '◆', category: 'markup' },
};

export function glyphFor(name: string): FileGlyph {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  // test/spec wins over language color — scanning for tests is the point.
  if (/\.(test|spec)\.[^.]+$/.test(lower)) return { glyph: '✓', category: 'test' };
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return FALLBACK;
  return BY_EXT[lower.slice(dot + 1)] ?? FALLBACK;
}

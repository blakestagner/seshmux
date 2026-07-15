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

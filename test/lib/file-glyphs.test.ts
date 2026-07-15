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

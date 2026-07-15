import { describe, expect, it } from 'vitest';
import { glyphFor } from '../../lib/client/file-glyphs';

describe('glyphFor', () => {
  it('categorizes by extension', () => {
    expect(glyphFor('Rail.module.scss')).toEqual({ glyph: '✿', category: 'styles' });
    expect(glyphFor('store.ts')).toEqual({ glyph: '◆', category: 'scriptTs' });
    expect(glyphFor('ensure.js')).toEqual({ glyph: '◆', category: 'scriptJs' });
    expect(glyphFor('README.md')).toEqual({ glyph: '¶', category: 'docs' });
    expect(glyphFor('logo.svg')).toEqual({ glyph: '▣', category: 'image' });
    expect(glyphFor('build.sh')).toEqual({ glyph: '$', category: 'shell' });
    expect(glyphFor('index.html')).toEqual({ glyph: '‹›', category: 'markup' });
    expect(glyphFor('settings.json')).toEqual({ glyph: '⚙', category: 'config' });
  });
  it('test files win over language', () => {
    expect(glyphFor('brief.test.ts')).toEqual({ glyph: '✓', category: 'test' });
    expect(glyphFor('x.spec.tsx')).toEqual({ glyph: '✓', category: 'test' });
  });
  it('specials and lockfiles', () => {
    expect(glyphFor('Dockerfile')).toEqual({ glyph: '⚙', category: 'config' });
    expect(glyphFor('package-lock.json')).toEqual({ glyph: '·', category: 'dim' });
  });
  it('fallback', () => {
    expect(glyphFor('LICENSE')).toEqual({ glyph: '·', category: 'dim' });
  });
});

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

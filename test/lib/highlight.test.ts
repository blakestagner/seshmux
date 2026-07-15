import { describe, expect, it } from 'vitest';
import { escapeHtml, languageFor, loadHighlighter } from '../../lib/client/highlight';

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

describe('loadHighlighter().line', () => {
  // The viewer injects this output via dangerouslySetInnerHTML — these pin
  // the escaping invariant against future hljs upgrades or option changes.
  it('never emits raw markup from input, highlighted or plain', async () => {
    const hl = await loadHighlighter();
    for (const lang of ['xml', 'typescript', null]) {
      const out = hl.line('<img src=x onerror=alert(1)>', lang);
      // The payload may survive as TEXT (escaped) — what must never appear is
      // a raw < from the input, which is what makes markup executable.
      expect(out).not.toContain('<img');
      expect(out.replace(/<[^>]*>/g, '')).not.toContain('<'); // strip hljs spans → no raw < left
    }
  });
  it('highlights known languages', async () => {
    const hl = await loadHighlighter();
    expect(hl.line('const x = 1;', 'typescript')).toContain('hljs-keyword');
  });
  it('unknown language falls back to escaped plain text', async () => {
    const hl = await loadHighlighter();
    expect(hl.line('<b>hi</b>', 'not-a-language')).toBe('&lt;b&gt;hi&lt;/b&gt;');
  });
});

import { describe, it, expect } from 'vitest';
import { escapeHtml, renderMarkdown } from '../../components/Transcript';

describe('escapeHtml', () => {
  it('encodes both double and single quotes', () => {
    expect(escapeHtml(`"' <>&`)).toBe('&quot;&#39; &lt;&gt;&amp;');
  });
});

describe('renderMarkdown XSS guards', () => {
  it('neutralizes raw script/img tags to inert escaped text', () => {
    const out = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(2)>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&lt;img');
  });

  it('strips javascript: scheme even with leading whitespace', () => {
    const out = renderMarkdown('[click](  javascript:alert(1))');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('href="#"');
  });

  it('escapes a malicious link title so it cannot break out of the attribute', () => {
    const out = renderMarkdown(`[click](https://x.com "x\\" onmouseover=\\"alert(1)")`);
    expect(out).not.toMatch(/onmouseover=alert/);
    expect(out).not.toContain('" onmouseover="');
  });
});

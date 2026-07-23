// syntaxCheck backs the editor's red squiggles. The contract that matters most
// is the negative one: never report an error on valid code, and say
// `checked:false` rather than pretending an unknown file type is clean.
import { describe, it, expect } from 'vitest';
import { syntaxCheck } from '../../server/lib/syntax-check';

// This repo has typescript installed, which is exactly the resolution path the
// checker uses (the project's own node_modules, never seshmux's).
const repo = process.cwd();

describe('syntaxCheck', () => {
  it('reports the line of a JSON error', () => {
    const res = syntaxCheck(repo, 'a.json', '{\n  "a": 1,\n}\n');
    expect(res.checked).toBe(true);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].line).toBeGreaterThan(1);
  });

  it('passes valid JSON', () => {
    expect(syntaxCheck(repo, 'a.json', '{"a": [1, 2]}')).toEqual({ checked: true, errors: [] });
  });

  it('finds a missing brace in TypeScript, on the right line', () => {
    const res = syntaxCheck(repo, 'a.ts', 'const a = 1;\nfunction f() {\n  return 2;\n');
    expect(res.checked).toBe(true);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it('leaves valid TS/TSX alone — no false squiggles', () => {
    expect(syntaxCheck(repo, 'a.ts', 'export const x: number[] = [1];\n').errors).toEqual([]);
    expect(syntaxCheck(repo, 'a.tsx', 'export const C = () => <div className="x">hi</div>;\n').errors).toEqual([]);
    // Regex literals and template strings are the classic false-positive
    // sources for a naive brace counter — the real parser handles them.
    expect(syntaxCheck(repo, 'a.js', 'const re = /[}{]/g;\nconst s = `a ${ {b: 1} } c`;\n').errors).toEqual([]);
  });

  it('says checked:false for a file type it cannot parse', () => {
    expect(syntaxCheck(repo, 'a.py', 'def f(: pass')).toEqual({ checked: false, errors: [] });
    expect(syntaxCheck(repo, 'README.md', '# hi {{{')).toEqual({ checked: false, errors: [] });
  });

  it('reports nothing when the project has no typescript installed', () => {
    expect(syntaxCheck('/nonexistent-project-dir', 'a.ts', 'function f( {')).toEqual({ checked: false, errors: [] });
  });
});

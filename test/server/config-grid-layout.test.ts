import { describe, it, expect } from 'vitest';
import { sanitizeConfig } from '../../server/routes/config';

describe('config sanitize: grid layout fields', () => {
  it('passes through an object gridLayout and object gridNamedLayouts', () => {
    const tree = { t: 's', dir: 'h', f: [0.5, 0.5], c: [{ t: 'l', id: 'a' }, { t: 'l', id: 'b' }] };
    const out = sanitizeConfig({ gridLayout: tree, gridNamedLayouts: { review: tree } });
    expect(out.gridLayout).toEqual(tree);
    expect(out.gridNamedLayouts).toEqual({ review: tree });
  });

  it('coerces garbage to null / empty object', () => {
    const out = sanitizeConfig({ gridLayout: 'nonsense', gridNamedLayouts: 42 });
    expect(out.gridLayout).toBeNull();
    expect(out.gridNamedLayouts).toEqual({});
  });

  it('defaults when absent (old configs on disk)', () => {
    const out = sanitizeConfig({});
    expect(out.gridLayout).toBeNull();
    expect(out.gridNamedLayouts).toEqual({});
  });
});

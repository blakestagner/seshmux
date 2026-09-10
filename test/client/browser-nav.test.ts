import { describe, it, expect } from 'vitest';
import {
  back,
  canBack,
  canForward,
  current,
  displayUrl,
  emptyNav,
  forward,
  initialNav,
  navigate,
  normalizeUrl,
} from '../../lib/client/browser-nav';

// The preview iframe is cross-origin, so its own history is unreachable and
// this stack is the only history the panel has. See browser-nav.ts header.
describe('nav stack', () => {
  it('starts empty, with both arrows dead', () => {
    expect(current(emptyNav)).toBe('');
    expect(canBack(emptyNav)).toBe(false);
    expect(canForward(emptyNav)).toBe(false);
  });

  it('walks back and forward over visited urls', () => {
    let s = initialNav('http://localhost:3000');
    s = navigate(s, 'http://localhost:3000/about');
    s = navigate(s, 'http://localhost:3000/docs');
    expect(current(s)).toBe('http://localhost:3000/docs');

    s = back(back(s));
    expect(current(s)).toBe('http://localhost:3000');
    expect(canBack(s)).toBe(false);
    expect(canForward(s)).toBe(true);

    s = forward(s);
    expect(current(s)).toBe('http://localhost:3000/about');
  });

  it('drops the forward entries once you navigate off a back step', () => {
    let s = initialNav('/a');
    s = navigate(s, '/b');
    s = navigate(s, '/c');
    s = back(s); // on /b, /c ahead
    s = navigate(s, '/d');
    expect(canForward(s)).toBe(false);
    expect(s.stack).toEqual(['/a', '/b', '/d']);
  });

  it('does not stack duplicate entries for the url already shown', () => {
    // Mashing Enter in the URL bar must not build steps you then click back through.
    let s = initialNav('http://localhost:3000');
    s = navigate(s, 'http://localhost:3000');
    s = navigate(s, 'http://localhost:3000');
    expect(s.stack).toEqual(['http://localhost:3000']);
    expect(canBack(s)).toBe(false);
  });

  it('clamps at both ends instead of falling off', () => {
    const s = initialNav('/a');
    expect(back(s)).toBe(s);
    expect(forward(s)).toBe(s);
  });
});

describe('normalizeUrl', () => {
  it('accepts a full url unchanged', () => {
    expect(normalizeUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x');
  });

  it('treats a bare number as a port, because in this panel it always is', () => {
    expect(normalizeUrl('3000')).toBe('http://localhost:3000/');
    expect(normalizeUrl(':5173')).toBe('http://localhost:5173/');
    expect(normalizeUrl('3000/admin')).toBe('http://localhost:3000/admin');
  });

  it('resolves a path against whatever is loaded', () => {
    expect(normalizeUrl('/admin', 'http://localhost:3000/x')).toBe('http://localhost:3000/admin');
    expect(normalizeUrl('?q=1', 'http://localhost:3000/x')).toBe('http://localhost:3000/?q=1');
  });

  it('assumes http for a bare host', () => {
    expect(normalizeUrl('localhost:5173/docs')).toBe('http://localhost:5173/docs');
  });

  it('returns null for input it cannot make into a url', () => {
    expect(normalizeUrl('')).toBe(null);
    expect(normalizeUrl('   ')).toBe(null);
    expect(normalizeUrl('/admin')).toBe(null); // a path with nothing to resolve against
    expect(normalizeUrl('what is this')).toBe(null);
  });
});

describe('displayUrl', () => {
  it('hides the http:// that is the same on every row, but never the https', () => {
    expect(displayUrl('http://localhost:3000/')).toBe('localhost:3000');
    expect(displayUrl('http://localhost:3000/admin?q=1')).toBe('localhost:3000/admin?q=1');
    expect(displayUrl('https://localhost:8443/')).toBe('https://localhost:8443');
  });

  it('passes through anything unparseable rather than blanking the bar', () => {
    expect(displayUrl('not a url')).toBe('not a url');
  });
});

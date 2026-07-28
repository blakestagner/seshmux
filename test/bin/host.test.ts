import { describe, it, expect } from 'vitest';
import hostlib from '../../bin/lib/host.js';

// bin/lib/host.js is plain CJS (bin/ ships unbuilt). Import the module object and
// destructure so this works whether esbuild exposes named or default exports.
const { parseHostPort, validateBindHost, isLoopback, displayHost } = hostlib as {
  parseHostPort: (raw: unknown) => { host: string; port: number | null };
  validateBindHost: (host: unknown) => string;
  isLoopback: (host: unknown) => boolean;
  displayHost: (host: string) => string;
};

describe('validateBindHost', () => {
  it('passes loopback names/literals through unchanged', () => {
    expect(validateBindHost('127.0.0.1')).toBe('127.0.0.1');
    expect(validateBindHost('localhost')).toBe('localhost');
    expect(validateBindHost('::1')).toBe('::1');
  });
  it('accepts a specific IPv4 / IPv6 bind address', () => {
    expect(validateBindHost('10.0.26.5')).toBe('10.0.26.5');
    expect(validateBindHost('192.168.0.69')).toBe('192.168.0.69');
    expect(validateBindHost('fd00::5')).toBe('fd00::5');
  });
  it('refuses all-interfaces wildcards', () => {
    expect(() => validateBindHost('0.0.0.0')).toThrow(/all interfaces/i);
    expect(() => validateBindHost('::')).toThrow(/all interfaces/i);
    expect(() => validateBindHost('::0')).toThrow(/all interfaces/i);
  });
  it('refuses DNS hostnames (must be an IP)', () => {
    expect(() => validateBindHost('my-box.local')).toThrow(/IP address/i);
    expect(() => validateBindHost('evil.example.com')).toThrow(/IP address/i);
    expect(() => validateBindHost('')).toThrow();
  });
});

describe('parseHostPort', () => {
  it('splits bare host, host:port, and [ipv6]:port', () => {
    expect(parseHostPort('10.0.26.5')).toEqual({ host: '10.0.26.5', port: null });
    expect(parseHostPort('10.0.26.5:4700')).toEqual({ host: '10.0.26.5', port: 4700 });
    expect(parseHostPort('[fd00::5]:4700')).toEqual({ host: 'fd00::5', port: 4700 });
    expect(parseHostPort('[::1]')).toEqual({ host: '::1', port: null });
  });
  it('treats a bare (unbracketed) IPv6 literal as host-only', () => {
    expect(parseHostPort('fd00::5')).toEqual({ host: 'fd00::5', port: null });
    expect(parseHostPort('::1')).toEqual({ host: '::1', port: null });
  });
  it('rejects malformed / missing input', () => {
    expect(() => parseHostPort('[fd00::5:4700')).toThrow(/IPv6/i);
    expect(() => parseHostPort('10.0.26.5:notaport')).toThrow(/invalid port/i);
    expect(() => parseHostPort(undefined)).toThrow(/missing/i);
  });
});

describe('isLoopback / displayHost', () => {
  it('classifies loopback', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('10.0.26.5')).toBe(false);
  });
  it('brackets IPv6 for URLs, leaves IPv4/names alone', () => {
    expect(displayHost('10.0.26.5')).toBe('10.0.26.5');
    expect(displayHost('127.0.0.1')).toBe('127.0.0.1');
    expect(displayHost('fd00::5')).toBe('[fd00::5]');
  });
});

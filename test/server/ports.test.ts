import { describe, it, expect } from 'vitest';
import { killPort, parseFields } from '../../server/lib/ports';

// lsof -F output: fields tagged by first char, grouped under the p<pid> line.
describe('parseFields', () => {
  it('groups file fields under their process', () => {
    const out = ['p123', 'cnode', 'n*:3000', 'n[::1]:3000', 'p456', 'cruby', 'n127.0.0.1:4000', ''].join('\n');
    expect(parseFields(out)).toEqual([
      { pid: 123, command: 'node', names: ['*:3000', '[::1]:3000'] },
      { pid: 456, command: 'ruby', names: ['127.0.0.1:4000'] },
    ]);
  });
});

// killPort must never signal a pid just because the client named it: the pid
// has to still be listening on that port inside the project dir.
describe('killPort', () => {
  it('refuses a pid that is not listening on that port in this dir', async () => {
    // process.pid is real and alive but is not a listener under /nonexistent.
    expect(await killPort('/nonexistent-dir-for-test', 65000, process.pid)).toBe('not-found');
  });
});

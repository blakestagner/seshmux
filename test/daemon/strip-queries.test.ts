import { describe, it, expect } from 'vitest';
// daemon is plain CJS Node JS — require it, no build step.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { stripTerminalQueries } = require('../../daemon/strip-queries.js');

const ESC = '\x1b';

describe('stripTerminalQueries', () => {
  // The bug: replayed scrollback containing a DA/DSR query provokes the
  // reattaching emulator into a stale reply (`?1;2c`, cursor report) that lands
  // in the prompt. These must be removed from replay bytes.
  it('removes DA1 queries (ESC[c / ESC[0c)', () => {
    expect(stripTerminalQueries(`${ESC}[c`)).toBe('');
    expect(stripTerminalQueries(`${ESC}[0c`)).toBe('');
  });

  it('removes DA2 / DA3 queries (ESC[>c, ESC[=c)', () => {
    expect(stripTerminalQueries(`${ESC}[>c`)).toBe('');
    expect(stripTerminalQueries(`${ESC}[>0;276;0c`)).toBe('');
    expect(stripTerminalQueries(`${ESC}[=c`)).toBe('');
  });

  it('removes DSR / cursor-position queries (ESC[5n, ESC[6n, ESC[?6n)', () => {
    expect(stripTerminalQueries(`${ESC}[5n`)).toBe('');
    expect(stripTerminalQueries(`${ESC}[6n`)).toBe('');
    expect(stripTerminalQueries(`${ESC}[?6n`)).toBe('');
  });

  it('strips a query embedded in ordinary text, leaving the text intact', () => {
    expect(stripTerminalQueries(`hello${ESC}[cworld`)).toBe('helloworld');
    // The reported symptom: DA reply text `?1;2c` was itself a stale query in
    // scrollback here we prove the QUERY that would produce it is removed.
    expect(stripTerminalQueries(`prompt> ${ESC}[6nrest`)).toBe('prompt> rest');
  });

  it('catches a query split across (already-joined) chunk boundary', () => {
    // ring.join('') produces one string strip runs on the joined buffer, so a
    // query straddling two chunks is still one contiguous match.
    const joined = ['foo' + ESC + '[', '6nbar'].join('');
    expect(stripTerminalQueries(joined)).toBe('foobar');
  });

  // The critical direction: these response/render sequences must SURVIVE
  // byte-identical — over-stripping would corrupt the replayed screen.
  it('preserves cursor show/hide, bracketed paste, alt-screen (h/l terminators)', () => {
    for (const seq of [
      `${ESC}[?25h`, // cursor show
      `${ESC}[?25l`, // cursor hide
      `${ESC}[?2004h`, // bracketed paste on
      `${ESC}[?2004l`, // bracketed paste off
      `${ESC}[?1049h`, // alt screen enter
      `${ESC}[?1049l`, // alt screen leave
    ]) {
      expect(stripTerminalQueries(seq)).toBe(seq);
    }
  });

  it('preserves SGR, erase, and cursor-move sequences (m/J/K/H/A terminators)', () => {
    for (const seq of [
      `${ESC}[0m`, // SGR reset
      `${ESC}[1;32m`, // SGR bold green
      `${ESC}[2J`, // erase screen
      `${ESC}[K`, // erase line
      `${ESC}[H`, // cursor home
      `${ESC}[10;20H`, // cursor position
      `${ESC}[3A`, // cursor up
    ]) {
      expect(stripTerminalQueries(seq)).toBe(seq);
    }
  });

  it('leaves plain text and empty input untouched', () => {
    expect(stripTerminalQueries('just some output\n')).toBe('just some output\n');
    expect(stripTerminalQueries('')).toBe('');
  });

  it('handles a realistic mixed replay buffer: queries die, render survives', () => {
    const input =
      `${ESC}[2J${ESC}[H` + // clear + home (survive)
      `${ESC}[c` + // DA1 query (die)
      `${ESC}[1;32mSleep Foundation${ESC}[0m\n` + // colored text (survive)
      `${ESC}[6n` + // cursor query (die)
      `> ready`;
    const expected =
      `${ESC}[2J${ESC}[H` +
      `${ESC}[1;32mSleep Foundation${ESC}[0m\n` +
      `> ready`;
    expect(stripTerminalQueries(input)).toBe(expected);
  });
});

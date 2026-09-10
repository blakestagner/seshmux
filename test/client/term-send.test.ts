// The right pane writes into a terminal it does not own: TerminalPane publishes its
// socket writer here while the socket is up, and MemoryPanel resolves it at click time.
//
// The lifetime is the whole point. "A sender exists" has to mean "this terminal is
// writable" — if a stale entry outlives its socket the panel reports a successful load
// while the text goes nowhere, which is worse than an error.
import { describe, it, expect, beforeEach } from 'vitest';
import { registerTermSend, getTermSend } from '../../lib/client/term-send';

// The registry is a module singleton, so each case cleans up after itself.
const cleanups: (() => void)[] = [];
beforeEach(() => {
  for (const off of cleanups.splice(0)) off();
});

function track(off: () => void): () => void {
  cleanups.push(off);
  return off;
}

describe('registerTermSend', () => {
  it('publishes a writer that can be resolved by ptyId', () => {
    const sent: string[] = [];
    track(registerTermSend('pty-1', (d) => sent.push(d)));

    getTermSend('pty-1')!('hello');
    expect(sent).toEqual(['hello']);
  });

  it('resolves nothing for a pty that never registered', () => {
    expect(getTermSend('pty-9')).toBeUndefined();
  });

  it('resolves nothing for an undefined ptyId (a tab with no live PTY)', () => {
    expect(getTermSend(undefined)).toBeUndefined();
  });

  it('keeps writers for different PTYs apart', () => {
    const a: string[] = [];
    const b: string[] = [];
    track(registerTermSend('pty-1', (d) => a.push(d)));
    track(registerTermSend('pty-2', (d) => b.push(d)));

    getTermSend('pty-1')!('to-a');
    getTermSend('pty-2')!('to-b');
    expect(a).toEqual(['to-a']);
    expect(b).toEqual(['to-b']);
  });

  it('unregisters on cleanup, so a closed socket stops looking writable', () => {
    const off = registerTermSend('pty-1', () => {});
    expect(getTermSend('pty-1')).toBeDefined();
    off();
    expect(getTermSend('pty-1')).toBeUndefined();
  });

  it('is idempotent — unregistering twice is not an error', () => {
    const off = registerTermSend('pty-1', () => {});
    off();
    expect(() => off()).not.toThrow();
    expect(getTermSend('pty-1')).toBeUndefined();
  });

  // React can mount the replacement BEFORE the outgoing effect's cleanup runs, which is
  // exactly what StrictMode does in dev. A blind delete on cleanup would then drop the
  // live writer and leave the panel unable to load into a perfectly healthy terminal.
  it('a late cleanup from a replaced registration does not evict the live one', () => {
    const stale: string[] = [];
    const fresh: string[] = [];
    const offStale = registerTermSend('pty-1', (d) => stale.push(d));
    track(registerTermSend('pty-1', (d) => fresh.push(d))); // remount, same ptyId

    offStale(); // the OLD effect's cleanup, arriving after the new registration

    const send = getTermSend('pty-1');
    expect(send).toBeDefined();
    send!('still works');
    expect(fresh).toEqual(['still works']);
    expect(stale).toEqual([]);
  });

  it('a re-registration replaces the previous writer for that pty', () => {
    const first: string[] = [];
    const second: string[] = [];
    track(registerTermSend('pty-1', (d) => first.push(d)));
    track(registerTermSend('pty-1', (d) => second.push(d)));

    getTermSend('pty-1')!('x');
    expect(first).toEqual([]);
    expect(second).toEqual(['x']);
  });
});

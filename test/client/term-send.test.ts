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
    track(registerTermSend('pty-1', (d) => { sent.push(d); return true; }));

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
    track(registerTermSend('pty-1', (d) => { a.push(d); return true; }));
    track(registerTermSend('pty-2', (d) => { b.push(d); return true; }));

    getTermSend('pty-1')!('to-a');
    getTermSend('pty-2')!('to-b');
    expect(a).toEqual(['to-a']);
    expect(b).toEqual(['to-b']);
  });

  // Being registered is not the same as being writable. A PTY can exit, or the socket can
  // be mid-reconnect after a server update, while the entry still stands — so the writer
  // reports delivery and a one-shot caller (the memory panel's Load) must check it rather
  // than assume the paste landed.
  it('reports a write that did not go out', () => {
    let open = true;
    track(registerTermSend("pty-1", () => open));

    expect(getTermSend("pty-1")!("hi")).toBe(true);
    open = false; // socket dropped, entry not yet withdrawn
    expect(getTermSend("pty-1")!("hi")).toBe(false);
  });

  it('unregisters on cleanup, so a closed socket stops looking writable', () => {
    const off = registerTermSend('pty-1', () => true);
    expect(getTermSend('pty-1')).toBeDefined();
    off();
    expect(getTermSend('pty-1')).toBeUndefined();
  });

  it('is idempotent — unregistering twice is not an error', () => {
    const off = registerTermSend('pty-1', () => true);
    off();
    expect(() => off()).not.toThrow();
    expect(getTermSend('pty-1')).toBeUndefined();
  });

  // Registration happens after the pane's dynamic import()s resolve, so a replaced
  // instance's cleanup can land AFTER the fresh one registered. A blind delete would then
  // drop the live writer and leave the panel unable to load into a healthy terminal.
  it('a late cleanup from a replaced registration does not evict the live one', () => {
    const stale: string[] = [];
    const fresh: string[] = [];
    const offStale = registerTermSend('pty-1', (d) => { stale.push(d); return true; });
    track(registerTermSend('pty-1', (d) => { fresh.push(d); return true; })); // remount, same ptyId

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
    track(registerTermSend('pty-1', (d) => { first.push(d); return true; }));
    track(registerTermSend('pty-1', (d) => { second.push(d); return true; }));

    getTermSend('pty-1')!('x');
    expect(first).toEqual([]);
    expect(second).toEqual(['x']);
  });
});

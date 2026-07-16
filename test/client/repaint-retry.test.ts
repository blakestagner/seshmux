import { describe, it, expect } from 'vitest';
import { retryRepaintUntilReady } from '../../lib/client/repaint-retry';

// Fake rAF: records scheduled callbacks, run() drains one at a time so tests
// stay synchronous and deterministic — no real frames, no DOM.
function fakeScheduler() {
  const queue: (() => void)[] = [];
  return {
    schedule: (cb: () => void) => queue.push(cb),
    // Drains until empty or `limit` ticks — guards an infinite-loop bug from
    // hanging the test.
    drain: (limit = 1000) => {
      let n = 0;
      while (queue.length && n++ < limit) queue.shift()!();
    },
  };
}

describe('retryRepaintUntilReady', () => {
  it('cols<10 initially then >=10: repaints once, settles after', () => {
    let cols = 5;
    let repaints = 0;
    let settled = false;
    const { schedule, drain } = fakeScheduler();
    retryRepaintUntilReady(
      () => cols,
      () => repaints++,
      () => (settled = true),
      schedule,
    );
    expect(repaints).toBe(0); // not ready yet — no repaint on first tick
    expect(settled).toBe(false);
    cols = 12; // fit settles
    drain();
    expect(repaints).toBe(1);
    expect(settled).toBe(true);
  });

  it('cols>=10 from the start: repaints immediately, no scheduling', () => {
    let repaints = 0;
    let settled = false;
    const { schedule } = fakeScheduler();
    let scheduledCalls = 0;
    retryRepaintUntilReady(
      () => 80,
      () => repaints++,
      () => (settled = true),
      (cb) => {
        scheduledCalls++;
        schedule(cb);
      },
    );
    expect(repaints).toBe(1);
    expect(settled).toBe(true);
    expect(scheduledCalls).toBe(0);
  });

  it('cols always <10: gives up after the bound, still settles, never repaints', () => {
    let repaints = 0;
    let settled = false;
    const { schedule, drain } = fakeScheduler();
    retryRepaintUntilReady(
      () => 3,
      () => repaints++,
      () => (settled = true),
      schedule,
      5, // small bound for a fast test
    );
    drain();
    expect(repaints).toBe(0);
    expect(settled).toBe(true);
  });
});

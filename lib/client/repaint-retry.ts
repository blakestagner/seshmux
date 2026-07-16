// Degrade-path repaint retry (BUG B hardening — see
// docs/plans/2026-07-10-subagent-attach-bugs-rootcause.md). On the
// getTermHistory-failure branch, forceRepaint's own `cols < 10` guard can no-op
// if the initial fit hasn't settled yet, leaving the just-wiped ('\x1bc') pane
// blank forever once the caller clears the connecting overlay. Pure/injectable
// so it's testable without a DOM: poll `getCols()` via `schedule` (a fake rAF
// in tests) until it's a paintable size, run `doRepaint()` once, then
// `onSettled()`. Bounded — a genuinely 0-width (disposed/hidden) pane gives up
// and still calls `onSettled()` so the overlay never sticks.
export function retryRepaintUntilReady(
  getCols: () => number,
  doRepaint: () => void,
  onSettled: () => void,
  schedule: (cb: () => void) => void,
  maxAttempts = 30,
): void {
  let attempts = 0;
  const tick = () => {
    if (getCols() >= 10) {
      doRepaint();
      onSettled();
      return;
    }
    attempts++;
    if (attempts >= maxAttempts) {
      onSettled(); // give up — don't leave the overlay stuck
      return;
    }
    schedule(tick);
  };
  tick();
}

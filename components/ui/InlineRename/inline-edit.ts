// Pure decision logic for InlineRename (kept out of the .tsx so it is unit-testable
// without a DOM or the SCSS module).

/**
 * True when `a` and `b` are the same text under `normalize`. Hosts pass the SAME
 * normalizer their save path uses (for session names: normalizeSessionName, which
 * also maps control chars and caps the length), so "unchanged" here and "no change"
 * there can never disagree.
 */
export function isUnchangedEdit(a: string, b: string, normalize: (s: string) => string): boolean {
  return normalize(a) === normalize(b);
}

export type EditState = {
  // Enter / blur (true) vs Escape (false).
  wantCommit: boolean;
  value: string;
  // What the field OPENED with — a mount-time snapshot.
  openedWith: string;
  // The host's CURRENT value for the field (the live `initial` prop), which can
  // change under an open editor: a rescan gives an 'untitled' row its real title,
  // or another browser renames the session over the WS.
  current: string;
  // Has the user typed anything since the field opened?
  dirty: boolean;
  normalize: (s: string) => string;
};

/**
 * The end-of-edit decision InlineRename makes. 'cancel' for Escape; for an untouched
 * field (Enter/blur on the prefill must never persist it — e.g. a term tab's project
 * name as a "custom" name, or a stale 'untitled' prefill after the real title
 * landed); and for an edit that ends where it started AND matches what the host
 * shows now. Otherwise 'commit' — including typing the opened value back after
 * someone else renamed it meanwhile (the user explicitly wants that value).
 */
export function editOutcome(s: EditState): 'commit' | 'cancel' {
  if (!s.wantCommit || !s.dirty) return 'cancel';
  const sameAsOpened = isUnchangedEdit(s.value, s.openedWith, s.normalize);
  const sameAsCurrent = isUnchangedEdit(s.value, s.current, s.normalize);
  return sameAsOpened && sameAsCurrent ? 'cancel' : 'commit';
}

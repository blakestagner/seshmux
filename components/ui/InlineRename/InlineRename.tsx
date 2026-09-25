'use client';

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, SyntheticEvent } from 'react';
import { editOutcome } from './inline-edit';
import styles from './InlineRename.module.scss';

export type InlineRenameProps = {
  // Starting text (the current custom name, or '' to start blank over the auto title).
  initial: string;
  // Shown when the field is empty — the auto title the session reverts to.
  placeholder?: string;
  maxLength?: number;
  ariaLabel?: string;
  // Enter or blur. Receives the raw text; the caller trims/normalizes and
  // decides what '' means (clear → revert to the auto title). `viaKeyboard` is
  // true for Enter — the host should put focus back on the row/tab it came from
  // (the field unmounts, and focus would otherwise fall to <body>); false for a
  // blur, where the user already moved focus somewhere on purpose.
  // Only called when the text actually changed from `initial`.
  onCommit: (value: string, viaKeyboard: boolean) => void;
  // Escape — or Enter/blur on UNCHANGED text (see isUnchangedEdit). Nothing is
  // saved. `viaKeyboard` has the same focus-restore meaning as for onCommit.
  onCancel: (viaKeyboard: boolean) => void;
  // Canonical form for the "unchanged?" test — the save path's own normalizer, so
  // the two can't disagree. Required: a second, private notion of "same text"
  // would drift.
  normalize: (s: string) => string;
};

// Swallow an event so the row/tab the field sits in never sees it — a click
// would activate the tab, Space/Enter would re-trigger the host's key handler,
// and a drag would start a tab/project reorder mid-edit.
const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * Single-line in-place editor for a label (session rename, issue #63).
 * Enter saves, Escape cancels, blur saves; saving unchanged text cancels.
 * Focuses + selects on mount.
 * Text styling is inherited from the host label (t-inline-edit).
 */
export default function InlineRename({
  initial,
  placeholder,
  maxLength,
  ariaLabel,
  onCommit,
  onCancel,
  normalize,
}: InlineRenameProps) {
  const [value, setValue] = useState(initial);
  // What the field OPENED with (mount-time snapshot) and whether the user has typed
  // since. With the live `initial` prop these feed editOutcome(): an untouched field
  // never saves even if the host re-rendered under it, while a deliberate edit back
  // to the opened value still saves if someone else renamed it meanwhile.
  const openedWith = useRef(initial).current;
  const [dirty, setDirty] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  // Enter/Escape unmount the field; the blur that follows must not commit twice
  // (or commit after a cancel).
  const doneRef = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  function finish(commit: boolean, viaKeyboard: boolean) {
    if (doneRef.current) return;
    doneRef.current = true;
    // An untouched prefill is a cancel, never a save: otherwise opening the editor
    // and clicking away would persist the prefill (a term tab's project name, or
    // the current auto title) as a permanent custom name.
    const outcome = editOutcome({ wantCommit: commit, value, openedWith, current: initial, dirty, normalize });
    if (outcome === 'commit') onCommit(value, viaKeyboard);
    else onCancel(viaKeyboard);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    // Enter/Escape while an IME composition is open confirm/dismiss the candidate,
    // not the edit (keyCode 229 covers browsers that fire keydown before isComposing).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false, true);
    }
  }

  return (
    <input
      ref={ref}
      className={styles.input}
      type="text"
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck={false}
      onChange={(e) => {
        setValue(e.target.value);
        setDirty(true);
      }}
      onKeyDown={onKeyDown}
      onBlur={() => {
        // The window losing focus (alt-tab) also blurs the field — that is not
        // "done editing", so keep the edit open; it resumes on return.
        if (typeof document !== 'undefined' && !document.hasFocus()) return;
        finish(true, false);
      }}
      onClick={stop}
      onDoubleClick={stop}
      onMouseDown={stop}
      onPointerDown={stop}
      onContextMenu={stop}
      draggable={false}
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    />
  );
}

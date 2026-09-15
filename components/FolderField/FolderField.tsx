'use client';

// Path input + "Browse…" for the New project / Add project dialogs: a typed
// path, with the native folder chooser (server/lib/folder-picker.ts) one click
// away wherever this machine can show one.
//
// Clicking the input opens the chooser too — but only until you type in it. A
// field you've typed in is a field you're editing, and a click there means "put
// the cursor here", not "throw a dialog over the screen": fixing a typo after
// "no such directory" used to be impossible by mouse. A pick doesn't count as
// typing, so clicking again after choosing a folder re-opens the chooser.

import { useId, useState } from 'react';
import { pickFolder } from '../../lib/client/api';
import Button from '../ui/Button/Button';
import TextInput from '../ui/TextInput/TextInput';
import styles from './FolderField.module.scss';

export type FolderFieldProps = {
  value: string;
  onChange: (value: string) => void;
  // A folder chosen in the native dialog. Never called on cancel.
  onPick: (path: string) => void;
  // Whether a native chooser can be opened here (getHomeDir().picker).
  hasPicker: boolean;
  // Where the chooser opens; the OS default when empty.
  startIn?: string;
  placeholder?: string;
  // <datalist> suggestions — parent dirs of the projects already in the rail.
  suggestions: string[];
  onSubmit: () => void;
  // Chooser failures go to the dialog's own error line; null clears it.
  onError: (message: string | null) => void;
};

export default function FolderField({
  value,
  onChange,
  onPick,
  hasPicker,
  startIn,
  placeholder,
  suggestions,
  onSubmit,
  onError,
}: FolderFieldProps) {
  const listId = useId();
  const [browsing, setBrowsing] = useState(false);
  const [typed, setTyped] = useState(false);

  async function browse() {
    // A second open while one is up would make the server dismiss the first mid-pick.
    if (browsing) return;
    setBrowsing(true);
    onError(null);
    try {
      const { path } = await pickFolder(startIn?.trim() || undefined);
      if (path) {
        setTyped(false);
        onPick(path);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : 'could not open the folder chooser');
    }
    setBrowsing(false);
  }

  const clickOpens = hasPicker && (!typed || !value.trim());

  return (
    <span className={styles.row}>
      {/* Wrapper, not a className on TextInput: the class lands on the
          <input>, while the flex child is TextInput's own wrap span. */}
      <span className={styles.input}>
        <TextInput
          value={value}
          onChange={(v) => {
            setTyped(true);
            onChange(v);
          }}
          placeholder={placeholder}
          list={listId}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          onClick={clickOpens ? () => void browse() : undefined}
        />
      </span>
      {hasPicker ? (
        <Button
          disabled={browsing}
          onClick={() => void browse()}
          title="Open the system folder chooser (its New folder button can create one)"
        >
          {browsing ? 'Choosing…' : 'Browse…'}
        </Button>
      ) : null}
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </span>
  );
}

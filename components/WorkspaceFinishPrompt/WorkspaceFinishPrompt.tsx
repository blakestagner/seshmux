'use client';
// 3-way finish prompt for a workspace session (Spec 1): Merge / Keep / Discard.
// Never silent-discard uncommitted work — Discard with a dirty tree requires a
// typed confirm, same posture as any other destructive-action affordance.

import { useState } from 'react';
import Button from '../ui/Button/Button';
import TextInput from '../ui/TextInput/TextInput';
import OptionRow from '../ui/OptionRow/OptionRow';
import type { WorkspaceFinishMode } from '../../lib/client/api';
import styles from './WorkspaceFinishPrompt.module.scss';

export type WorkspaceFinishPromptProps = {
  open: boolean;
  branch: string;
  filesChanged: number;
  busy?: boolean;
  error?: string | null;
  // force is true only for a discard past the typed-confirm gate (dirty tree) —
  // the caller passes it straight through to the server's own dirty guard.
  onFinish: (mode: WorkspaceFinishMode, force: boolean) => void;
  onClose: () => void;
};

const CONFIRM_WORD = 'discard';

export default function WorkspaceFinishPrompt({
  open,
  branch,
  filesChanged,
  busy,
  error,
  onFinish,
  onClose,
}: WorkspaceFinishPromptProps) {
  const [confirmText, setConfirmText] = useState('');
  const dirty = filesChanged > 0;

  if (!open) return null;

  const discardReady = !dirty || confirmText.trim().toLowerCase() === CONFIRM_WORD;

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal} role="dialog" aria-modal="true">
        <h3 className={styles.title}>Finish workspace</h3>
        <div className={styles.meta}>
          {branch} · {filesChanged} file{filesChanged === 1 ? '' : 's'} changed
        </div>

        <OptionRow
          icon="⇄"
          title="Merge into the repo"
          desc="git merge --no-ff · keeps history · removes the worktree"
          disabled={busy}
          onClick={() => onFinish('merge', false)}
        />

        <OptionRow
          icon="⎇"
          title="Keep branch, remove worktree"
          desc="branch survives · come back to it later"
          disabled={busy}
          onClick={() => onFinish('keep', false)}
        />

        <OptionRow
          icon="✕"
          title="Discard everything"
          desc="deletes the branch AND the worktree — cannot be undone"
          danger
          disabled={busy || !discardReady}
          onClick={() => onFinish('discard', dirty)}
        />

        {dirty ? (
          <div className={styles.confirmRow}>
            <span className={styles.confirmLabel}>
              Uncommitted changes — type “{CONFIRM_WORD}” to enable discard
            </span>
            <TextInput value={confirmText} onChange={setConfirmText} placeholder={CONFIRM_WORD} />
          </div>
        ) : null}

        {error ? <div className={styles.error}>{error}</div> : null}

        <div className={styles.foot}>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

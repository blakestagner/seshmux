'use client';

// "+ Add project" (rail footer, beside "+ New project"). Starts a session in a
// folder that ALREADY exists — typically a repo seshmux has never seen an agent
// run in, so it isn't in the rail yet.
//
// Same model as New project: seshmux has no project registry, so the session is
// what makes the folder a project. The difference is that nothing is ever
// created — the server refuses anything that isn't an existing directory, so a
// typo fails loudly instead of leaving a stray empty folder behind.

import { useEffect, useState } from 'react';
import { getHomeDir, openProjectFolder, pickFolder } from '../../lib/client/api';
import { baseName } from '../../lib/client/fs-path';
import type { ProviderId } from '../../lib/client/types';
import Modal from '../ui/Modal/Modal';
import Button from '../ui/Button/Button';
import TextInput from '../ui/TextInput/TextInput';
import Segmented from '../ui/Segmented/Segmented';
import styles from './AddProjectModal.module.scss';

const PROV_LABEL: Record<string, string> = { claude: '✳ Claude Code', codex: '⬡ Codex' };

export type AddProjectModalProps = {
  providers: ProviderId[];
  // Parent dirs of the projects already in the rail — datalist suggestions and
  // where the folder chooser opens, since existing repos tend to live together.
  suggestions: string[];
  onAdd: (path: string, name: string, provider: ProviderId) => Promise<void>;
  onClose: () => void;
};

export default function AddProjectModal({ providers, suggestions, onAdd, onClose }: AddProjectModalProps) {
  const [folder, setFolder] = useState('');
  const [provider, setProvider] = useState<ProviderId>(providers[0] ?? 'claude');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [hasPicker, setHasPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the picker flag. The field starts empty: unlike New project there is
  // no sensible default folder to pre-fill — any guess would be a wrong repo.
  useEffect(() => {
    getHomeDir()
      .then(({ picker }) => setHasPicker(picker))
      .catch(() => {});
  }, []);

  async function browse() {
    // Clicking the field while a dialog is already open must not stack a second
    // one (the server would dismiss the first mid-pick).
    if (browsing) return;
    setBrowsing(true);
    setError(null);
    try {
      const { path } = await pickFolder(folder.trim() || suggestions[0] || undefined);
      if (path) setFolder(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not open the folder chooser');
    }
    setBrowsing(false);
  }

  const canAdd = folder.trim().length > 0 && !busy;

  async function submit() {
    if (!canAdd) return;
    setBusy(true);
    setError(null);
    try {
      const { path } = await openProjectFolder(folder);
      // A drive root has no leaf name; label the tab with the path instead.
      await onAdd(path, baseName(path) || path, provider);
      onClose();
    } catch (e) {
      // Stay open with the path still typed — the usual failure is a typo.
      setError(e instanceof Error ? e.message : 'could not add the project');
      setBusy(false);
    }
  }

  return (
    <Modal open title="Add project" onClose={onClose}>
      <div className={styles.body}>
        <div className={styles.hint}>Start a session in a folder you already have. Nothing is created or moved.</div>

        <label className={styles.field}>
          <span className={styles.label}>Folder</span>
          <span className={styles.locationRow}>
            {/* Wrapper, not a className on TextInput: the class lands on the
                <input>, while the flex child is TextInput's own wrap span. */}
            <span className={styles.locationInput}>
              <TextInput
                value={folder}
                onChange={setFolder}
                placeholder={hasPicker ? 'Click to choose a folder, or type a path' : '~/Documents/GitHub/my-app'}
                list="seshmux-add-project-parents"
                // Click opens the folder chooser; Tab still focuses it for typing,
                // and cancelling the chooser leaves the field focused to type in.
                onClick={hasPicker ? () => void browse() : undefined}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
              />
            </span>
            {hasPicker ? (
              <Button disabled={browsing} onClick={() => void browse()} title="Open the system folder chooser">
                {browsing ? 'Choosing…' : 'Browse…'}
              </Button>
            ) : null}
          </span>
          <datalist id="seshmux-add-project-parents">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>

        {providers.length > 1 ? (
          <div className={styles.field}>
            <span className={styles.label}>Agent</span>
            <Segmented
              options={providers.map((p) => ({ id: p, label: PROV_LABEL[p] ?? p }))}
              value={provider}
              onChange={(id) => setProvider(id as ProviderId)}
            />
          </div>
        ) : null}

        {error ? <div className={styles.error}>{error}</div> : null}

        <div className={styles.actions}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canAdd} onClick={() => void submit()}>
            {busy ? 'Starting…' : 'Add & start session'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

'use client';

// "+ New project" (rail footer). Creates a folder anywhere on the machine and
// starts a session in it.
//
// seshmux has NO project registry — a project is simply a cwd an agent has run
// in — so this dialog does exactly two things: make the directory, then start
// the session. The project appears in the rail because the session exists.
//
// "Browse…" opens the real OS folder chooser — the server runs on this machine,
// so it can (see server/lib/folder-picker.ts); the browser's own picker is
// sandboxed and returns a handle, never a path. It selects the PROJECT FOLDER,
// so the dialog's own "New Folder" button creates one; the pick is split back
// into Location + Folder name, both still editable. Where no dialog can be shown
// (headless host, no zenity/kdialog) the button hides and the typed path is the
// whole story: seeded with the home dir, with the parents of existing projects
// offered as a datalist so the common case stays one click.

import { useEffect, useState } from 'react';
import { createProjectFolder, getHomeDir, pickFolder } from '../../lib/client/api';
import type { ProviderId } from '../../lib/client/types';
import Modal from '../ui/Modal/Modal';
import Button from '../ui/Button/Button';
import TextInput from '../ui/TextInput/TextInput';
import Segmented from '../ui/Segmented/Segmented';
import styles from './NewProjectModal.module.scss';

const PROV_LABEL: Record<string, string> = { claude: '✳ Claude Code', codex: '⬡ Codex' };

export type NewProjectModalProps = {
  providers: ProviderId[];
  // Parent dirs of the projects already in the rail — the datalist suggestions.
  suggestions: string[];
  onCreate: (path: string, name: string, provider: ProviderId) => Promise<void>;
  onClose: () => void;
};

export default function NewProjectModal({ providers, suggestions, onCreate, onClose }: NewProjectModalProps) {
  const [parent, setParent] = useState('');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<ProviderId>(providers[0] ?? 'claude');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [hasPicker, setHasPicker] = useState(false);
  // Set once the native dialog returned a path. That folder EXISTS on disk
  // already (Finder's New Folder made it), so its name is no longer a choice —
  // editing it would create a second, differently-named folder and leave the
  // one the user just made empty. Typing in Location clears this and hands the
  // form back to the manual flow.
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Seed with the most-used project parent, else the home dir; the same call
    // reports whether a native chooser can be opened here.
    getHomeDir()
      .then(({ home, picker }) => {
        setHasPicker(picker);
        setParent((cur) => cur || suggestions[0] || home);
      })
      .catch(() => setParent((cur) => cur || suggestions[0] || ''));
  }, [suggestions]);

  // Browse picks the PROJECT FOLDER itself, not its parent — the OS dialog's
  // own "New Folder" button is then the whole create flow, which is the point
  // of having a native picker at all. The result is split back into the two
  // fields so it stays visible and editable before Create.
  async function browse() {
    setBrowsing(true);
    setError(null);
    try {
      const { path } = await pickFolder(parent.trim() || undefined);
      if (path) {
        const cut = path.lastIndexOf('/');
        // Picking '/' itself leaves the name empty rather than inventing one.
        if (cut > 0) {
          setParent(path.slice(0, cut));
          setName(path.slice(cut + 1));
          setPicked(path);
        } else {
          setParent(path);
          setPicked(null);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not open the folder chooser');
    }
    setBrowsing(false);
  }

  const canCreate = parent.trim().length > 0 && name.trim().length > 0 && !busy;

  async function submit() {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const { path } = await createProjectFolder(parent, name);
      await onCreate(path, name.trim(), provider);
      onClose();
    } catch (e) {
      // Stay open with everything typed still there — the usual failure is a
      // location typo, and retyping the whole form for that is hostile.
      setError(e instanceof Error ? e.message : 'could not create the project');
      setBusy(false);
    }
  }

  return (
    <Modal open title="New project" onClose={onClose}>
      <div className={styles.body}>
        <label className={styles.field}>
          <span className={styles.label}>Location</span>
          <span className={styles.locationRow}>
            {/* Wrapper, not a className on TextInput: the class lands on the
                <input>, while the flex child is TextInput's own wrap span. */}
            <span className={styles.locationInput}>
              <TextInput
                value={parent}
                onChange={(v) => {
                  setPicked(null);
                  setParent(v);
                }}
                placeholder="~/Documents/GitHub"
                list="seshmux-project-parents"
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
              />
            </span>
            {hasPicker ? (
              <Button
                disabled={browsing}
                onClick={() => void browse()}
                title="Open the system folder chooser (its New Folder button creates one)"
              >
                {browsing ? 'Choosing…' : 'Browse…'}
              </Button>
            ) : null}
          </span>
          <datalist id="seshmux-project-parents">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>
            Folder name{picked ? <span className={styles.lockNote}> · chosen in Finder</span> : null}
          </span>
          <TextInput
            value={name}
            onChange={setName}
            placeholder="my-new-app"
            disabled={!!picked}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
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

        <div className={styles.preview}>
          {parent.trim() && name.trim() ? `${parent.trim().replace(/\/+$/, '')}/${name.trim()}` : ' '}
        </div>
        {error ? <div className={styles.error}>{error}</div> : null}

        <div className={styles.actions}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canCreate} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create & start session'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

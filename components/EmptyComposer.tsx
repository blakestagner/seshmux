'use client';

import { useState } from 'react';
import Select from './ui/Select';
import TextInput from './ui/TextInput';
import IconButton from './ui/IconButton';
import BranchLabel from './ui/BranchLabel';
import { PROV } from './ui/ProviderBadge';
import { startSession } from '../lib/client/api';
import type { Project, ProviderId } from '../lib/client/types';
import { useAppState } from '../lib/client/store';
import styles from './EmptyComposer.module.scss';

// Empty-pane composer (image ref): pick a project + agent, type a first prompt,
// spawn. Reuses the same startSession path as NewSessionModal — the prompt is
// seeded via the server's firstPrompt write once the TUI settles.
export type EmptyComposerProps = {
  projects: Project[];
  providers: ProviderId[];
};

export default function EmptyComposer({ projects, providers }: EmptyComposerProps) {
  const { dispatch } = useAppState();
  // Key by id, not name — the store can hold multiple projects with the same
  // display name (e.g. two repos both called "org"), so name is not unique.
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [provider, setProvider] = useState<ProviderId>(providers[0] ?? 'claude');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  const project = projects.find((p) => p.id === projectId) ?? projects[0];

  async function launch() {
    if (!project || busy) return;
    setBusy(true);
    try {
      const { tabMeta } = await startSession({
        projectPath: project.path,
        provider,
        mode: 'new',
        firstPrompt: prompt.trim() || undefined,
      });
      dispatch({ type: 'openTerm', ptyId: tabMeta.ptyId, projectId: project.id, label: project.name, provider });
    } catch {
      // Spawn failures surface via the events toast wave; keep the composer usable.
      setBusy(false);
    }
  }

  if (!project) {
    return <div className={styles.hint}>No projects yet — start a session in a repo to see it here.</div>;
  }

  const provLabel = (p: ProviderId) => `${PROV[p].glyph} ${PROV[p].name}`;

  return (
    <div className={styles.composer}>
      <div className={styles.headline}>
        <span className={styles.lead}>New session in</span>
        <span className={styles.pickerWrap}>
          <span className={styles.pickerIcon}>▢</span>
          <Select
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
            value={project.id}
            onChange={setProjectId}
          />
        </span>
        <span className={styles.lead}>with</span>
        <span className={styles.pickerWrap}>
          <Select
            options={providers.map(provLabel)}
            value={provLabel(provider)}
            onChange={(label) => {
              const hit = providers.find((p) => provLabel(p) === label);
              if (hit) setProvider(hit);
            }}
          />
        </span>
      </div>

      <div className={styles.promptBox}>
        <TextInput value={prompt} onChange={setPrompt} placeholder="What are you building?" multiline={3} />
        <div className={styles.promptFoot}>
          <span className={styles.footChip}>{PROV[provider].glyph} {PROV[provider].name}</span>
          <span className={styles.footSpacer} />
          <IconButton label="Start session" onClick={launch}>
            ↵
          </IconButton>
        </div>
      </div>

      <div className={styles.foot}>
        {/* ponytail: worktree + approvals are static labels — worktree spawn and
            per-session approval config are separate features. Wire when added. */}
        <span className={styles.footNote}>⛨ Default Approvals</span>
        <span className={styles.footSpacer} />
        <BranchLabel branch="main" />
      </div>
    </div>
  );
}

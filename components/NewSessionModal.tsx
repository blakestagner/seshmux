'use client';
// New-session modal (mockup .modal). Provider Segmented on top (Claude Code /
// Codex / "✳⬡ Both" when both providers are available). Selecting "Both"
// collapses the fresh/continue/plan mode options into a single Plan-off
// option (Task 16.8) that hands off to the parent via onPlanoff. Plan mode
// availability is driven by the server's per-provider hasPlan flag, not a
// hardcoded provider check. argv/binary names never appear here (hard rule
// 3) — command preview text comes from GET /api/env's commands map, this
// modal only sends {provider, mode}.

import { useEffect, useState } from 'react';
import type { ProviderId } from '../lib/client/types';
import { getEnvCommands, type CommandPreview } from '../lib/client/api';
import Segmented from './ui/Segmented';
import OptionRow from './ui/OptionRow';
import styles from './NewSessionModal.module.scss';

export type SessionMode = 'new' | 'continue' | 'plan';
type ModalProvider = ProviderId | 'both';

export type NewSessionModalProps = {
  projectPath: string;
  projectName: string;
  // Providers available to start with (claude always; codex when detected).
  providers: ProviderId[];
  onStart: (provider: ProviderId, mode: SessionMode) => void;
  // Fired when the user picks the "Both" → Plan-off option. Single-provider
  // modes keep going through onStart.
  onPlanoff?: () => void;
  // "New workspace" power path (Spec 1 Task 4): isolated git worktree +
  // branch, then a session spawned in it with the picked provider/mode.
  // Omitted -> the option doesn't render (e.g. project isn't a git repo).
  onStartWorkspace?: (provider: ProviderId, mode: SessionMode) => void;
  // Team entry point (Task 5) — claude-only. Omitted -> the option doesn't
  // render. When present, teamsGateOk decides disabled vs enabled (Task 5
  // Step 1b's teammateMode gate; the caller resolves it once for the app).
  onStartTeam?: () => void;
  teamsGateOk?: boolean;
  onClose: () => void;
};

const PROV_LABEL: Record<ModalProvider, string> = {
  claude: '✳ Claude Code',
  codex: '⬡ Codex',
  both: '✳⬡ Both',
};

export default function NewSessionModal({
  projectPath,
  projectName,
  providers,
  onStart,
  onPlanoff,
  onStartWorkspace,
  onStartTeam,
  teamsGateOk,
  onClose,
}: NewSessionModalProps) {
  const [provider, setProvider] = useState<ModalProvider>(providers[0] ?? 'claude');
  const [previews, setPreviews] = useState<Record<string, CommandPreview>>({});
  const both = provider === 'both';
  const activeProvider: ProviderId = both ? (providers[0] ?? 'claude') : provider;
  const preview = previews[activeProvider];

  useEffect(() => {
    getEnvCommands()
      .then(setPreviews)
      .catch(() => {});
  }, []);

  const options: { mode: SessionMode; icon: string; title: string; desc: string }[] = [
    { mode: 'new', icon: '❯', title: 'Fresh session', desc: preview ? `${preview.fresh} — new conversation in this repo` : 'new conversation in this repo' },
    {
      mode: 'continue',
      icon: '↻',
      title: 'Continue last',
      desc: preview ? `${preview.continue} — pick up most recent session` : 'pick up most recent session',
    },
    // Plan mode: only offered when the server reports this provider supports it.
    ...(preview?.hasPlan
      ? [
          {
            mode: 'plan' as const,
            icon: '▤',
            title: 'Plan mode',
            desc: `${preview.plan} — read-only planning`,
          },
        ]
      : []),
  ];

  const provOptions = providers.length > 1 ? [...providers.map((p) => ({ id: p, label: PROV_LABEL[p] })), { id: 'both', label: PROV_LABEL.both }] : [];

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal} role="dialog" aria-modal="true">
        <h3 className={styles.title}>New session</h3>
        <div className={styles.path}>{projectPath || projectName}</div>

        {provOptions.length ? (
          <Segmented
            className={styles.provSeg}
            options={provOptions}
            value={provider}
            onChange={(id) => setProvider(id as ModalProvider)}
          />
        ) : null}

        {both ? (
          <OptionRow
            icon="⚖"
            title="Plan-off — parallel planning"
            desc="✳ and ⬡ each draft a plan read-only · compare side by side · winner executes"
            onClick={() => onPlanoff?.()}
          />
        ) : (
          options.map((opt) => (
            <OptionRow
              key={opt.mode}
              icon={opt.icon}
              title={opt.title}
              desc={opt.desc}
              onClick={() => onStart(provider, opt.mode)}
            />
          ))
        )}

        {!both && onStartWorkspace ? (
          <OptionRow
            icon="⑃"
            title="New workspace"
            desc={`${preview ? `${preview.fresh} — ` : ''}isolated git worktree + branch, own working tree`}
            onClick={() => onStartWorkspace(provider, 'new')}
          />
        ) : null}

        {/* Teams are claude-only (native claude-swarm teammates) — never
            offered for codex or "Both". Gated per Task 5 Step 1b's
            teammateMode read: not tmux/iterm2 -> disabled with a warning
            instead of spawning a lead whose members would be invisible. */}
        {!both && provider === 'claude' && onStartTeam ? (
          <OptionRow
            icon="⚑"
            title="Team…"
            desc={teamsGateOk ? 'assemble a claude-swarm team for this task' : 'Teams needs teammateMode: tmux'}
            disabled={!teamsGateOk}
            onClick={() => onStartTeam()}
          />
        ) : null}

        <button className={styles.cancel} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

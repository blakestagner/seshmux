'use client';
// Team modal (Task 5): assemble a claude-swarm team for a project. Two paths —
// Predefined (pick a saved template, GET /api/teams) and Inline define (name +
// member rows built here, optionally saved as a template). Layout/state only
// (hard rule 1); all text via t-* mixins, all visuals composed from ui/
// primitives (hard rule 2). Start hands the composed payload to the caller
// (Rail owns the actual POST /api/teams/start + tab-open, same split as
// NewSessionModal's onStart) — this file stays pure/testable.

import { useEffect, useState } from 'react';
import Modal from './ui/Modal';
import OptionRow from './ui/OptionRow';
import TextInput from './ui/TextInput';
import Segmented from './ui/Segmented';
import Toggle from './ui/Toggle';
import Button from './ui/Button';
import { getTeamTemplates } from '../lib/client/api';
import type { TeamDef, TeamMemberTemplate, TeamStartPayload, TeamTemplate } from '../lib/client/api';
import styles from './TeamModal.module.scss';

// Task 5 Step 1b: only these backends produce attachable member jsonls — any
// other value (undefined/'in-process'/'auto') means teammates would be
// invisible in seshmux, so entry points gate on this before ever opening the
// modal (kept here too so a directly-rendered modal can't be reached ungated).
export function teamsAllowed(teammateMode?: string): boolean {
  return teammateMode === 'tmux' || teammateMode === 'iterm2';
}

const MODEL_OPTIONS = [
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

type MemberRow = TeamMemberTemplate & { id: string };

let rowSeq = 0;
const newRow = (): MemberRow => ({ id: `m${++rowSeq}`, name: '', role: '', model: 'sonnet' });

// Pure — the actual payload the Start button sends (minus projectId, which
// only the caller knows). Trims/drops empty rows so a stray blank row never
// reaches the server's isTeamDef validation.
export function buildInlinePayload(
  name: string,
  rows: TeamMemberTemplate[],
  task: string,
  saveTemplate: boolean,
): Omit<TeamStartPayload, 'projectId'> {
  const members = rows
    .map((m) => ({ name: m.name.trim(), role: m.role.trim(), model: m.model }))
    .filter((m) => m.name && m.role);
  const inline: TeamDef = { name: name.trim(), members };
  return { inline, task: task.trim(), saveTemplate };
}

export function buildPredefinedPayload(template: TeamTemplate, task: string): Omit<TeamStartPayload, 'projectId'> {
  return { template: { name: template.name, members: template.members }, task: task.trim() };
}

export type TeamModalProps = {
  projectName: string;
  // Rejecting = the start failed: the modal stays open, shows the error
  // inline, and keeps everything the user typed. Only the caller closes it
  // (on success, or via onClose).
  onStart: (payload: Omit<TeamStartPayload, 'projectId'>) => Promise<void>;
  onClose: () => void;
};

export default function TeamModal({ projectName, onStart, onClose }: TeamModalProps) {
  const [mode, setMode] = useState<'predefined' | 'inline'>('predefined');
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [selected, setSelected] = useState<TeamTemplate | null>(null);
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [rows, setRows] = useState<MemberRow[]>([newRow()]);
  const [saveTemplate, setSaveTemplate] = useState(false);

  useEffect(() => {
    getTeamTemplates()
      .then(setTemplates)
      .catch(() => {});
  }, []);

  function updateRow(id: string, patch: Partial<MemberRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  const inlineReady = name.trim() && rows.some((r) => r.name.trim() && r.role.trim()) && task.trim();
  const predefinedReady = !!selected && task.trim();

  async function handleStart() {
    const payload =
      mode === 'predefined' && selected && task.trim()
        ? buildPredefinedPayload(selected, task)
        : mode === 'inline' && inlineReady
          ? buildInlinePayload(name, rows, task, saveTemplate)
          : null;
    if (!payload || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onStart(payload);
    } catch (e) {
      // Failed start: modal stays open, typed state intact, error shown inline.
      setError(e instanceof Error ? e.message : 'failed to start team');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Team…">
      <div className={styles.path}>{projectName}</div>

      <Segmented
        className={styles.modeSeg}
        options={[
          { id: 'predefined', label: 'Predefined' },
          { id: 'inline', label: 'New team' },
        ]}
        value={mode}
        onChange={(id) => setMode(id as 'predefined' | 'inline')}
      />

      {mode === 'predefined' ? (
        <div className={styles.body}>
          {templates.length === 0 ? (
            <div className={styles.empty}>No saved teams yet — switch to “New team” to define one.</div>
          ) : (
            templates.map((t) => (
              <OptionRow
                key={t.name}
                icon="⚑"
                title={t.name}
                desc={`${t.members.length} member${t.members.length === 1 ? '' : 's'} · ${t.members.map((m) => m.role).join(', ')}`}
                onClick={() => setSelected(t)}
                disabled={selected?.name === t.name}
              />
            ))
          )}
          {selected ? (
            <div className={styles.taskWrap}>
              <div className={styles.label}>Task for {selected.name}</div>
              <TextInput value={task} onChange={setTask} placeholder="what should the team do?" multiline={3} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className={styles.body}>
          <div className={styles.label}>Team name</div>
          <TextInput value={name} onChange={setName} placeholder="e.g. Recon" />

          <div className={styles.label}>Members</div>
          {rows.map((r) => (
            <div key={r.id} className={styles.memberRow}>
              <TextInput value={r.name} onChange={(v) => updateRow(r.id, { name: v })} placeholder="name" />
              <TextInput value={r.role} onChange={(v) => updateRow(r.id, { role: v })} placeholder="role" />
              <Segmented
                options={MODEL_OPTIONS}
                value={r.model ?? 'sonnet'}
                onChange={(id) => updateRow(r.id, { model: id as MemberRow['model'] })}
              />
              <Button
                variant="ghost"
                title="Remove member"
                onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((x) => x.id !== r.id) : prev))}
              >
                ×
              </Button>
            </div>
          ))}
          <Button variant="ghost" onClick={() => setRows((prev) => [...prev, newRow()])}>
            + add member
          </Button>

          <div className={styles.label}>Task</div>
          <TextInput value={task} onChange={setTask} placeholder="what should the team do?" multiline={3} />

          <div className={styles.saveRow}>
            <span className={styles.label}>Save as template</span>
            <Toggle on={saveTemplate} onChange={setSaveTemplate} />
          </div>
        </div>
      )}

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.foot}>
        <Button
          variant="primary"
          disabled={busy || (mode === 'predefined' ? !predefinedReady : !inlineReady)}
          onClick={() => void handleStart()}
        >
          {busy ? 'Starting…' : 'Start'}
        </Button>
      </div>
    </Modal>
  );
}

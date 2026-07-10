'use client';

import { useState } from 'react';
import type { ProviderId } from '../lib/client/types';
import ProviderBadge, { PROV } from './ui/ProviderBadge';
import Card from './ui/Card';
import Button from './ui/Button';
import TextInput from './ui/TextInput';
import { bridgePlanoff, bridgePlanoffPick, type PlanResult, type PlanoffResult } from '../lib/client/api';
import styles from './Planoff.module.scss';

// Ported from mockup.html planoffHTML() (~1736-1771) + .planoff-inner/.plan-col
// CSS (~855-870). Owns the run lifecycle: task input → POST /api/bridge/planoff
// (blocking, returns both plans) → render two columns → pick a winner to execute.

// Plan text comes back as raw markdown from the CLIs; render inline `backtick`
// code via split-and-map (no HTML trust), everything else as plain text lines.
function renderPlan(plan: string) {
  return plan.split('\n').map((line, li) => (
    <div key={li} className={styles.planLine}>
      {line.split(/(`[^`]+`)/g).map((part, i) =>
        part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part,
      )}
    </div>
  ));
}

function secs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function PlanColumn({ result, onPick, picking }: { result: PlanResult; onPick: () => void; picking: boolean }) {
  return (
    <Card>
      <div className={styles.col}>
        <div className={styles.colHead}>
          <ProviderBadge provider={result.provider} withName />
          <span className={styles.planMeta}>read-only plan · {secs(result.durationMs)}</span>
        </div>
        {result.ok ? (
          <div className={styles.steps}>{renderPlan(result.plan)}</div>
        ) : (
          <div className={styles.angle}>Plan failed: {result.error ?? 'unknown error'}</div>
        )}
        <div className={styles.pick}>
          <Button variant="primary" disabled={!result.ok || picking} onClick={onPick}>
            Use this plan — execute with {PROV[result.provider].glyph} {result.provider}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export type PlanoffProps = {
  projectId: string;
  repo: string;
  // Called with the winning provider once execution starts (parent opens the term tab).
  onExecute?: (provider: ProviderId, ptyId: string) => void;
};

type Phase =
  | { state: 'input' }
  | { state: 'running'; task: string }
  | { state: 'done'; task: string; result: PlanoffResult }
  | { state: 'error'; task: string; message: string };

export default function Planoff({ projectId, repo, onExecute }: PlanoffProps) {
  const [phase, setPhase] = useState<Phase>({ state: 'input' });
  const [task, setTask] = useState('');
  const [picking, setPicking] = useState(false);

  async function run() {
    const t = task.trim();
    if (!t || t.startsWith('-')) return; // server rejects leading-dash (flag injection)
    setPhase({ state: 'running', task: t });
    try {
      const result = await bridgePlanoff(projectId, t);
      setPhase({ state: 'done', task: t, result });
    } catch (e) {
      setPhase({ state: 'error', task: t, message: e instanceof Error ? e.message : 'plan-off failed' });
    }
  }

  async function pick(provider: ProviderId) {
    if (phase.state !== 'done' || picking) return;
    setPicking(true);
    try {
      const { ptyId } = await bridgePlanoffPick(projectId, provider, phase.task, phase.result);
      onExecute?.(provider, ptyId);
    } catch {
      setPicking(false);
    }
  }

  return (
    <div className={styles.transcript}>
      <div className={styles.inner}>
        <div className={styles.header}>
          <h1 className={styles.title}>Plan-off</h1>
          <div className={styles.meta}>
            <span>{repo}</span>
            {phase.state !== 'input' ? <span>task: {phase.state === 'running' ? phase.task : phase.task}</span> : null}
            {phase.state === 'running' ? <span>✳ planning… · ⬡ planning…</span> : null}
            {phase.state === 'done' ? <span>both plans complete</span> : null}
          </div>
        </div>

        {phase.state === 'input' ? (
          <div className={styles.taskForm}>
            <TextInput
              value={task}
              onChange={setTask}
              placeholder="Describe the task both agents should plan (read-only)…"
              multiline={3}
            />
            <Button variant="primary" disabled={!task.trim()} onClick={run}>
              ⚖ Run plan-off
            </Button>
          </div>
        ) : phase.state === 'running' ? (
          <div className={styles.running}>
            Each agent is drafting a read-only plan for “{phase.task}” — this can take a couple of minutes.
          </div>
        ) : phase.state === 'error' ? (
          <div className={styles.running}>Plan-off failed: {phase.message}</div>
        ) : (
          <div className={styles.grid}>
            {[phase.result.claude, phase.result.codex].map((result) => (
              <PlanColumn
                key={result.provider}
                result={result}
                picking={picking}
                onPick={() => pick(result.provider)}
              />
            ))}
          </div>
        )}

        <div className={styles.note}>
          Each agent planned read-only, in parallel. The winner&apos;s plan is written to
          .seshmux/planoff-winner.md and seeds the execution session; the loser&apos;s plan stays in the scratchpad for
          reference.
        </div>
      </div>
    </div>
  );
}

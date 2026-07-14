'use client';

import { useEffect, useState } from 'react';
import Button from '../ui/Button/Button';
import IconButton from '../ui/IconButton/IconButton';
import ProviderBadge from '../ui/ProviderBadge/ProviderBadge';
import styles from './ApprovalToast.module.scss';

// MCP bridge approval prompt (Task 16.7 ask_codex/ask_claude; Spec 5 adds
// wait_for_status/read_terminal — same flow, reading/blocking on another
// agent's session is a cross-agent action too). Blocks server-side until the
// user allows or denies here; the server auto-denies at expiresAt (120s), so
// we count down and auto-dismiss.
export type ApprovalToastProps = {
  open: boolean;
  tool: 'ask_codex' | 'ask_claude' | 'wait_for_status' | 'read_terminal';
  question: string;
  cwd: string;
  hop: number;
  expiresAt: number; // epoch ms
  onResolve: (approved: boolean) => void;
  onExpire: () => void;
};

// ask_* names which agent WOULD run — map to its provider so ProviderBadge
// carries the glyph + identity color (never redeclare ✳/⬡ or tint them accent).
// wait_for_status/read_terminal don't run a specific agent (they act on a
// SESSION, not spawn one), so they fall back to plain tool-name text below.
const TOOL_PROVIDER = { ask_codex: 'codex', ask_claude: 'claude' } as const;

export default function ApprovalToast({
  open,
  tool,
  question,
  cwd,
  hop,
  expiresAt,
  onResolve,
  onExpire,
}: ApprovalToastProps) {
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.round((expiresAt - now()) / 1000)));

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => {
      const left = Math.max(0, Math.round((expiresAt - now()) / 1000));
      setRemaining(left);
      if (left <= 0) onExpire();
    }, 1000);
    return () => clearInterval(id);
  }, [open, expiresAt, onExpire]);

  if (!open) return null;

  return (
    <div className={`${styles.toast} ${styles.show}`}>
      <div className={styles.body}>
        <div className={styles.head}>
          {tool in TOOL_PROVIDER ? (
            <ProviderBadge provider={TOOL_PROVIDER[tool as keyof typeof TOOL_PROVIDER]} withName />
          ) : (
            <span className={styles.toolName}>{tool}</span>
          )}
          <span className={styles.count}>
            hop {hop} · {remaining}s
          </span>
        </div>
        <div className={styles.question}>{question}</div>
        <div className={styles.cwd}>{cwd}</div>
      </div>
      <div className={styles.actions}>
        <span className={styles.allow}>
          <Button variant="primary" onClick={() => onResolve(true)}>
            Allow
          </Button>
        </span>
        <Button onClick={() => onResolve(false)}>Deny</Button>
      </div>
      <IconButton label="Deny" onClick={() => onResolve(false)}>
        ✕
      </IconButton>
    </div>
  );
}

// now() is isolated so the one Date use is easy to see; the component only reads
// wall-clock for the countdown (safe — this is runtime UI, not a workflow script).
function now(): number {
  return Date.now();
}

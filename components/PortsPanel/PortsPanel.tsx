'use client';

// Ports panel: TCP ports currently listening from a process whose cwd is inside
// this session's repo (or any subdir of it — a monorepo's apps/web dev server
// reports `apps/web`, so five independently-started Next apps list as five
// rows). Opened from the terminal statusbar's ports chip; lives in the same
// right-pane tab strip as the folder/agents/team panels.
//
// Data: GET /api/git/ports on mount + a 5s tick. No watcher — ports come and go
// with `npm run dev`, and a poll is cheaper than watching /proc.

import { useCallback, useEffect, useState } from 'react';
import { getPorts, killPort as killPortApi, type PortEntry } from '../../lib/client/api';
import Button from '../ui/Button/Button';
import IconButton from '../ui/IconButton/IconButton';
import styles from './PortsPanel.module.scss';

export interface PortsPanelProps {
  projectId: string;
  branch?: string | null;
  // The active terminal's PTY: lets the server scan that terminal's actual cwd
  // (correct for worktree sessions, where the branch alone can misresolve).
  ptyId?: string | null;
  onClose: () => void;
}

export default function PortsPanel({ projectId, branch, ptyId, onClose }: PortsPanelProps) {
  const [ports, setPorts] = useState<PortEntry[] | null>(null);
  // 'repo' = every row's owner runs inside this project (lsof). 'machine' =
  // everything listening on the box, because win32 exposes no cwd per port and
  // so cannot attribute one. The panel must say which it is showing.
  const [scope, setScope] = useState<'repo' | 'machine'>('repo');
  const [killing, setKilling] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getPorts(projectId, branch, ptyId);
      setPorts(res.ports);
      setScope(res.scope ?? 'repo');
    } catch {
      /* best-effort; next tick retries */
    }
  }, [projectId, branch, ptyId]);

  // SIGTERM, then re-poll: a dev server usually takes a second to actually go
  // away, so the row lingers until the next tick rather than lying immediately.
  const kill = async (p: PortEntry) => {
    setKilling(p.pid);
    setError(null);
    try {
      await killPortApi(projectId, branch, p.port, p.pid, ptyId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'kill failed');
    }
    setKilling(null);
    void load();
  };

  useEffect(() => {
    setPorts(null);
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.title}>ports</span>
        {/* Say the scope out loud. These rows look identical either way, and
            silently widening "ports in this repo" to "ports on this machine"
            would be a lie the user has no way to detect. */}
        {scope === 'machine' ? (
          <span className={styles.scope} title="Windows exposes no working directory per port, so ports cannot be attributed to a repo">
            this machine
          </span>
        ) : null}
        <IconButton label="Close ports panel" className={styles.headGlyph} onClick={onClose}>
          ✕
        </IconButton>
      </div>
      <div className={styles.body}>
        {error ? <div className={styles.empty}>{error}</div> : null}
        {ports === null ? (
          <div className={styles.empty}>loading…</div>
        ) : ports.length === 0 ? (
          <div className={styles.empty}>
            {scope === 'machine' ? 'nothing listening on this machine' : 'nothing listening in this repo'}
          </div>
        ) : (
          ports.map((p) => (
            <div key={`${p.pid}:${p.port}`} className={styles.row}>
              <a
                className={styles.link}
                href={`http://localhost:${p.port}`}
                target="_blank"
                rel="noreferrer"
                title={`pid ${p.pid} · ${p.command}`}
              >
                <span className={styles.port}>:{p.port}</span>
                {/* No cwd on win32, so there is no subdir to show — the owning
                    process name is the only identifying thing we have. */}
                <span className={styles.dir}>{scope === 'machine' ? p.command : p.dir || './'}</span>
                <span className={styles.cmd}>{scope === 'machine' ? `pid ${p.pid}` : p.command}</span>
              </a>
              <Button
                variant="chip"
                className={styles.kill}
                title={`SIGTERM pid ${p.pid}`}
                disabled={killing === p.pid}
                onClick={() => void kill(p)}
              >
                {killing === p.pid ? '…' : 'kill'}
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

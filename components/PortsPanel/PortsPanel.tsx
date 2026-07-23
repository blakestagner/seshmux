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
  onClose: () => void;
}

export default function PortsPanel({ projectId, branch, onClose }: PortsPanelProps) {
  const [ports, setPorts] = useState<PortEntry[] | null>(null);
  const [supported, setSupported] = useState(true);
  const [killing, setKilling] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getPorts(projectId, branch);
      setPorts(res.ports);
      setSupported(res.supported);
    } catch {
      /* best-effort; next tick retries */
    }
  }, [projectId, branch]);

  // SIGTERM, then re-poll: a dev server usually takes a second to actually go
  // away, so the row lingers until the next tick rather than lying immediately.
  const kill = async (p: PortEntry) => {
    setKilling(p.pid);
    setError(null);
    try {
      await killPortApi(projectId, branch, p.port, p.pid);
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
        <IconButton label="Close ports panel" className={styles.headGlyph} onClick={onClose}>
          ✕
        </IconButton>
      </div>
      <div className={styles.body}>
        {error ? <div className={styles.empty}>{error}</div> : null}
        {!supported ? (
          <div className={styles.empty}>port detection needs lsof (macOS/Linux)</div>
        ) : ports === null ? (
          <div className={styles.empty}>loading…</div>
        ) : ports.length === 0 ? (
          <div className={styles.empty}>nothing listening in this repo</div>
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
                <span className={styles.dir}>{p.dir || './'}</span>
                <span className={styles.cmd}>{p.command}</span>
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

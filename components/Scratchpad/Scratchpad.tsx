'use client';

import { useEffect, useState } from 'react';
import ProviderBadge from '../ui/ProviderBadge/ProviderBadge';
import BranchLabel from '../ui/BranchLabel/BranchLabel';
import Button from '../ui/Button/Button';
import { renderMarkdown } from '../Transcript/Transcript';
import { getScratchpad, putScratchpad } from '../../lib/client/api';
import type { ProviderId } from '../../lib/client/types';
import styles from './Scratchpad.module.scss';

// Ported from mockup.html scratchpadHTML() (~1782-1804). Header: title, path
// meta, Open in editor / Clear actions. Body: parsed entries (provider badge,
// optional branch chip, timestamp) each with a markdown body, plus a footer
// note. Route (GET /api/scratchpad/:projectId) isn't landed yet — see TODO
// below; a 404/fetch failure just falls back to the empty state.

export type ScratchEntry = {
  provider: ProviderId;
  branch?: string | null;
  time: string;
  body: string;
};

// Mockup entry-header convention: "## <glyph> <provider> [· ⎇ <branch>] · <time>"
// e.g. "## ✳ claude · ⎇ fix/nav-zindex · today 14:32". Bodies are everything
// until the next header or EOF.
const HEADER_RE = /^##\s*(?:✳|⬡)\s*(claude|codex)\s*(?:·\s*⎇\s*([^\s·][^·]*?)\s*)?·\s*(.+?)\s*$/;

export function parseScratchpad(md: string): ScratchEntry[] {
  const lines = md.split('\n');
  const entries: ScratchEntry[] = [];
  let current: ScratchEntry | null = null;
  let bodyLines: string[] = [];

  function flush() {
    if (current) entries.push({ ...current, body: bodyLines.join('\n').trim() });
    bodyLines = [];
  }

  for (const line of lines) {
    const m = HEADER_RE.exec(line.trim());
    if (m) {
      flush();
      current = { provider: m[1] as ProviderId, branch: m[2]?.trim() || null, time: m[3].trim(), body: '' };
    } else if (current) {
      bodyLines.push(line);
    }
  }
  flush();
  return entries;
}

export type ScratchpadProps = {
  projectId: string;
  path: string;
  refreshKey?: number;
};

export default function Scratchpad({ projectId, path, refreshKey }: ScratchpadProps) {
  const [entries, setEntries] = useState<ScratchEntry[] | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    // Route may not be registered yet server-side — 404/network failure both
    // just render the empty state below, no crash.
    getScratchpad(projectId)
      .then(({ content }) => {
        if (!cancelled) setEntries(content ? parseScratchpad(content) : []);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  function handleClear() {
    setClearing(true);
    putScratchpad(projectId, '')
      .then(() => setEntries([]))
      .catch(() => {})
      .finally(() => setClearing(false));
  }

  return (
    <div className={styles.transcript}>
      <div className={styles.inner}>
        <div className={styles.header}>
          <h1 className={styles.title}>Shared scratchpad</h1>
          <div className={styles.meta}>
            <span>{path}/.seshmux/handoff.md</span>
            <span>both agents read &amp; write this file</span>
          </div>
          <div className={styles.actions}>
            {/* TODO(wire): $EDITOR open is server-side, not landed */}
            <Button onClick={() => {}}>Open in editor</Button>
            <Button onClick={handleClear} disabled={clearing}>
              Clear
            </Button>
          </div>
        </div>

        {entries === null ? (
          <div className={styles.loading}>Loading scratchpad…</div>
        ) : entries.length === 0 ? (
          <div className={styles.loading}>No entries yet — agents append notes here after handoffs and reviews.</div>
        ) : (
          entries.map((entry, i) => (
            <div className={styles.entry} key={i}>
              <div className={styles.entryHead}>
                <ProviderBadge provider={entry.provider} withName />
                {entry.branch ? <BranchLabel branch={entry.branch} /> : null}
                <span className={styles.time}>{entry.time}</span>
              </div>
              <div
                className={styles.body}
                // eslint-disable-next-line react/no-danger -- renderMarkdown escapes HTML before parsing (see Transcript.tsx)
                dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.body) }}
              />
            </div>
          ))
        )}

        <div className={styles.note}>
          Agents are nudged to read this file at session start and after each seshmux handoff/review. The filesystem
          is the message bus — works even when only one agent is running.
        </div>
      </div>
    </div>
  );
}

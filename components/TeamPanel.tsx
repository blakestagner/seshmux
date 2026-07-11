'use client';
// Teams v1 (Task 6): live roster + member transcript pane for a claude-swarm team
// lead tab. Renders beside the terminal (app/page.tsx team-split, reusing the
// bridge pair-split / subagent-viewer split mechanics). Member transcripts reuse
// the EXISTING Transcript component unchanged (do NOT fork/import SubagentViewer/
// SubagentDetail) — teammate PTYs live in native claude-swarm tmux, not daemon-owned,
// so there is no live terminal for a teammate: only its on-disk jsonl, re-read here.

import { useEffect, useRef, useState } from 'react';
import { getTeamMembers } from '../lib/client/api';
import type { TeamInfo, TeamMemberInfo } from '../lib/client/api';
import Transcript from './Transcript';
import StatusDot from './ui/StatusDot';
import styles from './TeamPanel.module.scss';

export interface TeamPanelProps {
  leadSessionId: string;
  projectId: string;
  // Bumped by the parent on each {event:'team'} ping for this leadSessionId → refetch.
  refreshKey?: number;
  // Keyed by sessionId, bumped on each {event:'session-touch'} — the 'team' ping only
  // fires on config.json changes (member join/finish), NOT on a member's jsonl
  // growing, so the open member's transcript freshness rides the existing
  // session-touch watch (Task 4) instead of a bespoke poller.
  touchPings: Record<string, number>;
}

// Fresh-start race: Rail marks the lead tab isTeamLead immediately (before the lead
// session even has a jsonl), but claude-swarm's config.json can take a beat to
// appear after that. Bounded retries ONLY while we've never resolved a roster at
// all — once resolved once, a later 404 unambiguously means "team dir gone".
const RETRY_DELAYS_MS = [1000, 2000, 4000];

type PanelStatus = 'loading' | 'live' | 'gone' | 'unresolved';

// joinedAt is the only timestamp TeamMemberInfo carries (no endedAt) — "time since
// joined" is the closest honest duration signal available; not a literal task
// duration, but real derived data, never an invented number.
function timeSince(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const m = Math.floor(diff / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

export default function TeamPanel({ leadSessionId, projectId, refreshKey, touchPings }: TeamPanelProps) {
  const [info, setInfo] = useState<TeamInfo | null>(null);
  const [status, setStatus] = useState<PanelStatus>('loading');
  const [openMember, setOpenMember] = useState<TeamMemberInfo | null>(null);
  const [memberKey, setMemberKey] = useState(0);
  const everResolvedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function attempt(retry: number) {
      getTeamMembers(leadSessionId)
        .then((data) => {
          if (cancelled) return;
          everResolvedRef.current = true;
          setInfo(data);
          setStatus('live');
        })
        .catch(() => {
          if (cancelled) return;
          if (everResolvedRef.current) {
            // Team dir gone (lead exited, config.json removed) — final rollup off
            // the LAST known roster, stop refreshing. Distinct from "members
            // present but inactive": member transcripts stay viewable either way.
            setStatus('gone');
            return;
          }
          if (retry < RETRY_DELAYS_MS.length) {
            timer = setTimeout(() => attempt(retry + 1), RETRY_DELAYS_MS[retry]);
          } else {
            setStatus('unresolved');
          }
        });
    }
    everResolvedRef.current = false;
    setStatus('loading');
    attempt(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // leadSessionId change = a different team entirely (fresh state); refreshKey
    // bump = the 'team' event for THIS team, refetch in place.
  }, [leadSessionId, refreshKey]);

  // Keep the open member's transcript fresh on a session-touch matching its
  // sessionId. Transcript owns its own fetch effect and takes no refreshKey prop
  // of its own (never forked to add one) — bump a React `key` instead to force a
  // clean remount, which re-triggers that effect. Mirrors SubagentViewer's
  // refreshKey→refetch pattern, just via remount rather than a prop dependency.
  const openSessionId = openMember?.sessionId ?? null;
  const lastTouchRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    lastTouchRef.current = undefined;
  }, [openSessionId]);
  useEffect(() => {
    if (!openSessionId) return;
    const touch = touchPings[openSessionId];
    if (touch === undefined) return;
    if (lastTouchRef.current !== undefined && touch !== lastTouchRef.current) {
      setMemberKey((k) => k + 1);
    }
    lastTouchRef.current = touch;
  }, [openSessionId, touchPings]);

  // Fresh-lead rescue: a lead session can take 15-60s+ to write config.json
  // (claude-swarm only creates it once the lead model makes named Agent
  // calls) — long past RETRY_DELAYS_MS's ~7s budget. Once retries exhaust and
  // status lands on 'unresolved', the only further signal we get is the
  // lead's OWN jsonl growing (touchPings bumps on every session-touch), so
  // re-attempt resolution on each bump instead of leaving 'unresolved'
  // permanent. No new plumbing: reuses the existing touchPings prop.
  useEffect(() => {
    if (status !== 'unresolved') return;
    if (touchPings[leadSessionId] === undefined) return;
    let cancelled = false;
    getTeamMembers(leadSessionId).then((data) => {
      if (cancelled) return;
      everResolvedRef.current = true;
      setInfo(data);
      setStatus('live');
    }, () => {});
    return () => {
      cancelled = true;
    };
  }, [status, leadSessionId, touchPings[leadSessionId]]);

  const members = info?.members ?? [];
  const rolledUp = status === 'gone';

  if (openMember) {
    return (
      <div className={styles.panel}>
        <div className={styles.head}>
          <button type="button" className={styles.back} onClick={() => setOpenMember(null)}>
            ← Roster
          </button>
        </div>
        {openMember.sessionId ? (
          <div className={styles.transcriptWrap}>
            <Transcript
              key={`${openMember.sessionId}-${memberKey}`}
              projectId={projectId}
              sessionId={openMember.sessionId}
              title={openMember.name}
              provider="claude"
            />
          </div>
        ) : (
          <div className={styles.empty}>
            No attachable transcript — {openMember.name} runs in-process, with no session file of its own.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.title}>Team</span>
        {rolledUp ? <span className={styles.note}>session ended</span> : null}
      </div>
      {status === 'loading' ? (
        <div className={styles.empty}>Resolving team roster…</div>
      ) : status === 'unresolved' ? (
        <div className={styles.empty}>No live roster for this session.</div>
      ) : members.length === 0 ? (
        <div className={styles.empty}>No teammates joined yet.</div>
      ) : (
        <ul className={styles.roster}>
          {members.map((m) => (
            <RosterRow
              key={m.name}
              member={m}
              finished={rolledUp || m.isActive === false}
              onOpen={() => setOpenMember(m)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function RosterRow({
  member,
  finished,
  onOpen,
}: {
  member: TeamMemberInfo;
  finished: boolean;
  onOpen: () => void;
}) {
  // Status dot (per Task 6 research): drive ONLY off isActive — no richer
  // per-member live-status signal exists than config.json's isActive. in-process /
  // no-session members get a neutral "headless" glyph instead of a fabricated dot.
  const headless = member.backendType === 'in-process' || member.sessionId === null;
  const dotStatus = headless ? 'neutral' : member.isActive ? 'live' : 'done';
  return (
    <li className={styles.row} onClick={onOpen}>
      <StatusDot status={dotStatus} size={8} />
      <span className={styles.name}>{member.name}</span>
      {member.model ? <span className={styles.model}>{member.model}</span> : null}
      {finished ? (
        <span className={styles.check} aria-label="finished">
          ✓
        </span>
      ) : null}
      {/* No token/usage field exists on TeamMemberInfo (Task 6 finding) — honest
          placeholder rather than an invented number or a heavy new per-member parse. */}
      <span className={styles.tokens}>—</span>
      <span className={styles.duration}>{timeSince(member.joinedAt)}</span>
    </li>
  );
}

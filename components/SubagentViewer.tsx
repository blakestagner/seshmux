'use client';

// Stateful container for the subagent viewer — the ONLY place in this feature that
// fetches. Owns nodes/selection/collapse/detail; renders the shareable, props-only
// SubagentTree / SubagentDetail (which the teams feature reuses unchanged). Lives as a
// synthetic right-pane beside the terminal (app/page.tsx split).
//
// Live updates: the parent bumps `refreshKey` when a {event:'subagents'} ping arrives for
// this session (same ping→refetch pattern as scratchpad) → the tree refetches, and if a
// detail is open it refetches too so a running agent's transcript grows.

import { useCallback, useEffect, useState } from 'react';
import type { SubagentDetail, SubagentNode } from '../lib/client/types';
import { getSubagentDetail, getSubagents } from '../lib/client/api';
import SubagentTree from './SubagentTree';
import SubagentDetailPane from './SubagentDetail';
import IconButton from './ui/IconButton';
import styles from './SubagentViewer.module.scss';

export interface SubagentViewerProps {
  projectId: string;
  sessionId: string;
  // Bumped by the parent on each {event:'subagents'} ping for this session → refetch.
  refreshKey?: number;
  onClose: () => void;
}

export default function SubagentViewer({ projectId, sessionId, refreshKey, onClose }: SubagentViewerProps) {
  const [nodes, setNodes] = useState<SubagentNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<SubagentDetail | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [detailReloadKey, setDetailReloadKey] = useState(0);

  // Refetch the tree. Seed collapsedIds from finished top-level roots on the FIRST load
  // only (auto-collapse finished branches, keep running paths open) — never clobber the
  // user's manual expand/collapse on later refetches.
  const seededRef = useState({ done: false })[0];
  const loadTree = useCallback(async () => {
    try {
      const { nodes: fresh } = await getSubagents(projectId, sessionId);
      setNodes(fresh);
      if (!seededRef.done) {
        seededRef.done = true;
        const finishedRoots = fresh
          .filter((n) => n.parentId === null && n.status !== 'running')
          .map((n) => n.id);
        if (finishedRoots.length) setCollapsedIds(new Set(finishedRoots));
      }
    } catch {
      /* best-effort; viewer stays usable, next ping retries */
    }
  }, [projectId, sessionId, seededRef]);

  useEffect(() => {
    void loadTree();
  }, [loadTree, refreshKey]);

  // Selection change → null (show loading) + fetch the newly-selected agent's detail.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null); // loading state ONLY on a real selection change
    setDetailError(false);
    getSubagentDetail(projectId, sessionId, selectedId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetailError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, projectId, sessionId, detailReloadKey]);

  // A ping (refreshKey) while a detail is open → refetch and REPLACE IN PLACE (no
  // setDetail(null)), so a running agent's transcript grows without a loading flicker
  // (acceptance item 3: "detail appends as its file grows").
  useEffect(() => {
    if (refreshKey === undefined || !selectedId) return;
    let cancelled = false;
    getSubagentDetail(projectId, sessionId, selectedId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        /* transient — keep the current detail, next ping retries */
      });
    return () => {
      cancelled = true;
    };
    // selectedId intentionally excluded: selection changes are owned by the effect
    // above; this one fires only on refreshKey bumps for the already-open detail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const onToggleCollapse = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className={styles.viewer}>
      <div className={styles.viewerHead}>
        <span className={styles.viewerTitle}>Subagents</span>
        <IconButton label="Close subagent viewer" onClick={onClose}>
          ✕
        </IconButton>
      </div>
      {selectedId ? (
        <SubagentDetailPane
          detail={detail}
          error={detailError}
          onRetry={() => setDetailReloadKey((k) => k + 1)}
          onBack={() => setSelectedId(null)}
        />
      ) : (
        <SubagentTree
          nodes={nodes}
          selectedId={selectedId}
          onSelect={setSelectedId}
          collapsedIds={collapsedIds}
          onToggleCollapse={onToggleCollapse}
        />
      )}
    </div>
  );
}

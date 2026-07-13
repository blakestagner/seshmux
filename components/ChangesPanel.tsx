'use client';

// Changes panel: the repo's file tree with branch changes highlighted, opened
// from the terminal statusbar's +N/-N chip. Read-only v1 — no per-file diff
// view. Lives in the same right-pane split slot as SubagentViewer/TeamPanel
// (app/page.tsx owns the split + exclusivity).
//
// Data: GET /api/git/changes?tree=1, refetched on a 10s tick while open (same
// cadence as the statusbar chip; no watcher, no WS event). The collapsed set
// seeds ONCE from collapsedByDefault (unchanged subtrees folded, changed paths
// open) and is user-owned afterward — refetches never clobber manual toggles.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getGitChanges, type GitChanges } from '../lib/client/api';
import { buildTree, collapsedByDefault, type TreeNode } from '../lib/client/git-tree';
import IconButton from './ui/IconButton';
import styles from './ChangesPanel.module.scss';

export interface ChangesPanelProps {
  projectId: string;
  branch?: string | null;
  onClose: () => void;
}

function Row({
  node,
  depth,
  collapsed,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
}) {
  const isCollapsed = collapsed.has(node.path);
  const hasDirShape = node.children.length > 0;
  return (
    <>
      <div
        className={`${styles.row} ${node.change ? styles.rowChanged : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={hasDirShape ? () => onToggle(node.path) : undefined}
        role={hasDirShape ? 'button' : undefined}
      >
        {hasDirShape ? (
          <span className={styles.caret}>{isCollapsed ? '▸' : '▾'}</span>
        ) : (
          <span className={styles.caretSpacer} />
        )}
        <span className={`${styles.name} ${node.change?.status === 'D' ? styles.deleted : ''}`}>
          {node.name}
          {hasDirShape ? '/' : ''}
        </span>
        {node.change ? (
          <span className={styles.stats}>
            {node.change.added > 0 ? <span className={styles.added}>+{node.change.added}</span> : null}
            {node.change.removed > 0 ? <span className={styles.removed}>−{node.change.removed}</span> : null}
          </span>
        ) : null}
      </div>
      {hasDirShape && !isCollapsed
        ? node.children.map((c) => <Row key={c.path} node={c} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} />)
        : null}
    </>
  );
}

export default function ChangesPanel({ projectId, branch, onClose }: ChangesPanelProps) {
  const [data, setData] = useState<GitChanges | null>(null);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const seededRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await getGitChanges(projectId, branch, true);
      setData(res);
      const tree = buildTree(res.tree ?? [], res.files);
      setNodes(tree);
      if (!seededRef.current) {
        seededRef.current = true;
        setCollapsed(collapsedByDefault(tree));
      }
    } catch {
      /* best-effort; next tick retries */
    }
  }, [projectId, branch]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.title}>changes{branch ? ` · ${branch}` : ''}</span>
        {data ? (
          <span className={styles.totals}>
            <span className={styles.added}>+{data.added}</span>
            <span className={styles.removed}>−{data.removed}</span>
          </span>
        ) : null}
        <IconButton label="Close changes panel" onClick={onClose}>
          ✕
        </IconButton>
      </div>
      <div className={styles.tree}>
        {nodes.length === 0 ? (
          <div className={styles.empty}>{data ? 'no files' : 'loading…'}</div>
        ) : (
          nodes.map((n) => <Row key={n.path} node={n} depth={0} collapsed={collapsed} onToggle={toggle} />)
        )}
      </div>
    </div>
  );
}

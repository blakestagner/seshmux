'use client';

// Changes panel: the repo's file tree with branch changes highlighted, opened
// from the terminal statusbar's +N/-N chip. Clicking a changed file swaps the
// panel to that file's color-coded unified diff (‹ back returns to the tree).
// Lives in the same right-pane split slot as SubagentViewer/TeamPanel
// (app/page.tsx owns the split + exclusivity).
//
// Data: GET /api/git/changes?tree=1, refetched on a 10s tick while open (same
// cadence as the statusbar chip; no watcher, no WS event). The collapsed set
// seeds ONCE from collapsedByDefault (unchanged subtrees folded, changed paths
// open) and is user-owned afterward — refetches never clobber manual toggles.
// The file diff fetches on open only (no tick — a diff shifting under a
// reading eye is worse than a stale one; back-and-reopen refreshes).

import { useCallback, useEffect, useRef, useState } from 'react';
import { getGitChanges, getGitFileDiff, type FileChange, type GitChanges } from '../../lib/client/api';
import { buildTree, collapsedByDefault, type TreeNode } from '../../lib/client/git-tree';
import { parseUnifiedDiff, type DiffLine } from '../../lib/client/diff';
import { glyphFor } from '../../lib/client/file-glyphs';
import Button from '../ui/Button/Button';
import IconButton from '../ui/IconButton/IconButton';
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
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (change: FileChange) => void;
}) {
  const isCollapsed = collapsed.has(node.path);
  const hasDirShape = node.children.length > 0;
  const fg = hasDirShape ? null : glyphFor(node.name);
  return (
    <>
      <div
        className={`${styles.row} ${node.change ? styles.rowChanged : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={
          hasDirShape ? () => onToggle(node.path) : node.change ? () => onOpenFile(node.change!) : undefined
        }
        role={hasDirShape || node.change ? 'button' : undefined}
      >
        {hasDirShape ? (
          <span className={styles.caret}>{isCollapsed ? '▸' : '▾'}</span>
        ) : (
          <span className={styles.glyph} style={{ color: `var(${fg!.colorVar})` }}>
            {fg!.glyph}
          </span>
        )}
        <span
          className={`${styles.name} ${node.change?.status === 'D' ? styles.deleted : ''}`}
          // Deleted files skip the tint: inline style beats the .deleted class
          // rule, so tinting here would override its faint color.
          style={fg && node.change?.status !== 'D' ? { color: `var(${fg.colorVar})` } : undefined}
        >
          {node.name}
          {hasDirShape ? '/' : ''}
        </span>
        {node.change ? (
          <span className={styles.stats}>
            {node.change.added > 0 ? (
              <span className={styles.added}>
                +{node.change.added}
                {node.change.approx ? '+' : ''}
              </span>
            ) : null}
            {node.change.removed > 0 ? <span className={styles.removed}>−{node.change.removed}</span> : null}
          </span>
        ) : null}
      </div>
      {hasDirShape && !isCollapsed
        ? node.children.map((c) => (
            <Row
              // dir/file discriminator in the key: a deleted file and a new
              // directory can legitimately share a path (both rows render).
              key={`${c.children.length ? 'd' : 'f'}:${c.path}`}
              node={c}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
            />
          ))
        : null}
    </>
  );
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className={styles.diff}>
      {lines.map((l, i) =>
        l.kind === 'hunk' ? (
          <div key={i} className={styles.diffHunk}>
            {l.text}
          </div>
        ) : (
          <div
            key={i}
            className={`${styles.diffLine} ${l.kind === 'add' ? styles.diffAdd : l.kind === 'del' ? styles.diffDel : ''}`}
          >
            <span className={styles.diffGutter}>{l.oldNo ?? ''}</span>
            <span className={styles.diffGutter}>{l.newNo ?? ''}</span>
            <span className={styles.diffMarker}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
            <span className={styles.diffText}>{l.text}</span>
          </div>
        ),
      )}
    </div>
  );
}

export default function ChangesPanel({ projectId, branch, onClose }: ChangesPanelProps) {
  const [data, setData] = useState<GitChanges | null>(null);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const seededRef = useRef(false);
  // Panel-swap file view: non-null while reading one file's diff.
  const [openFile, setOpenFile] = useState<FileChange | null>(null);
  const [diffLines, setDiffLines] = useState<DiffLine[] | null>(null);
  const [diffTruncated, setDiffTruncated] = useState(false);
  // Which file's diff response is allowed to land — a slow fetch for file A
  // must not paint under file B's header after the user navigated on.
  const openPathRef = useRef<string | null>(null);
  // The tracked file list barely changes; fetch it once per mount and tick
  // with totals/files only (changed paths are unioned into the tree client-
  // side, so new work still appears — only brand-new UNCHANGED tracked files
  // wait for a panel reopen).
  const treeRef = useRef<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      const wantTree = treeRef.current === null;
      const res = await getGitChanges(projectId, branch, wantTree);
      // degraded = git failed server-side (index.lock contention etc): keep
      // the last good render, next tick retries. Critically, do NOT let the
      // tree-less degraded payload poison treeRef — only a response actually
      // carrying a tree satisfies the fetch-once contract.
      if (res.degraded) return;
      if (wantTree && res.tree) treeRef.current = res.tree;
      setData(res);
      const tree = buildTree(treeRef.current ?? [], res.files);
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
    // New project/branch → reset EVERYTHING, not just the tree: the old
    // collapsed set, an open file diff, and the seeded flag all describe the
    // previous target and would render the new one under stale UI state.
    treeRef.current = null;
    seededRef.current = false;
    openPathRef.current = null;
    setData(null);
    setNodes([]);
    setCollapsed(new Set());
    setOpenFile(null);
    setDiffLines(null);
    setDiffTruncated(false);
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

  const openFileDiff = (change: FileChange) => {
    setOpenFile(change);
    setDiffLines(null);
    setDiffTruncated(false);
    openPathRef.current = change.path;
    getGitFileDiff(projectId, branch, change.path)
      .then((res) => {
        if (openPathRef.current !== change.path) return; // stale response
        setDiffLines(parseUnifiedDiff(res.diff));
        setDiffTruncated(!!res.truncated);
      })
      .catch(() => {
        if (openPathRef.current === change.path) setDiffLines([]);
      });
  };

  const closeFileDiff = () => {
    openPathRef.current = null;
    setOpenFile(null);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        {openFile ? (
          <>
            <Button variant="chip" className={styles.backBtn} title="Back to file tree" onClick={closeFileDiff}>
              ‹ back
            </Button>
            <span className={styles.title}>{openFile.path}</span>
            <span className={styles.totals}>
              {openFile.added > 0 ? <span className={styles.added}>+{openFile.added}</span> : null}
              {openFile.removed > 0 ? <span className={styles.removed}>−{openFile.removed}</span> : null}
            </span>
          </>
        ) : (
          <>
            <span className={styles.title}>changes{branch ? ` · ${branch}` : ''}</span>
            {data ? (
              <span className={styles.totals}>
                <span className={styles.added}>
                  +{data.added}
                  {data.files.some((f) => f.approx) ? '+' : ''}
                </span>
                <span className={styles.removed}>−{data.removed}</span>
              </span>
            ) : null}
          </>
        )}
        <IconButton label="Close changes panel" onClick={onClose}>
          ✕
        </IconButton>
      </div>
      {openFile ? (
        diffLines === null ? (
          <div className={styles.empty}>loading…</div>
        ) : diffLines.length === 0 ? (
          <div className={styles.empty}>no diff (binary or unchanged)</div>
        ) : (
          <>
            <DiffView lines={diffLines} />
            {diffTruncated ? <div className={styles.empty}>diff truncated — showing the first 5,000 lines</div> : null}
          </>
        )
      ) : (
        <div className={styles.tree}>
          {nodes.length === 0 ? (
            <div className={styles.empty}>{data ? 'no files' : 'loading…'}</div>
          ) : (
            nodes.map((n) => (
              <Row
                key={`${n.children.length ? 'd' : 'f'}:${n.path}`}
                node={n}
                depth={0}
                collapsed={collapsed}
                onToggle={toggle}
                onOpenFile={openFileDiff}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

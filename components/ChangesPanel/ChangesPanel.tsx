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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getGitChanges, getGitFile, getGitFileDiff, type FileChange, type GitChanges } from '../../lib/client/api';
import { buildTree, collapsedByDefault, type TreeNode } from '../../lib/client/git-tree';
import { parseUnifiedDiff, type DiffLine } from '../../lib/client/diff';
import { glyphFor } from '../../lib/client/file-glyphs';
import { languageFor, loadHighlighter, escapeHtml, type Highlighter } from '../../lib/client/highlight';
import Button from '../ui/Button/Button';
import IconButton from '../ui/IconButton/IconButton';
import Segmented from '../ui/Segmented/Segmented';
import SearchView from './SearchView';
import { FT_CLASS } from './ft-class';
import styles from './ChangesPanel.module.scss';

const VIEW_OPTIONS = [
  { id: 'diff', label: 'diff' },
  { id: 'full', label: 'full' },
];

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
  onOpenFile: (node: TreeNode) => void;
}) {
  const isCollapsed = collapsed.has(node.path);
  const hasDirShape = node.children.length > 0;
  const fg = hasDirShape ? null : glyphFor(node.name);
  return (
    <>
      <div
        className={`${styles.row} ${node.change ? styles.rowChanged : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={hasDirShape ? () => onToggle(node.path) : () => onOpenFile(node)}
        role="button"
      >
        {hasDirShape ? (
          <span className={styles.caret}>{isCollapsed ? '▸' : '▾'}</span>
        ) : (
          <span className={`${styles.glyph} ${FT_CLASS[fg!.category]}`}>{fg!.glyph}</span>
        )}
        <span
          className={`${styles.name} ${fg ? FT_CLASS[fg.category] : ''} ${node.change?.status === 'D' ? styles.deleted : ''}`}
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

function CodeText({ text, lang, hl }: { text: string; lang: string | null; hl: Highlighter | null }) {
  const html = hl ? hl.line(text, lang) : escapeHtml(text);
  // Safe: hljs escapes its input; the plain path is escapeHtml. Never raw text.
  return <span className={styles.diffText} dangerouslySetInnerHTML={{ __html: html }} />;
}

function DiffView({ lines, lang, hl }: { lines: DiffLine[]; lang: string | null; hl: Highlighter | null }) {
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
            <CodeText text={l.text} lang={lang} hl={hl} />
          </div>
        ),
      )}
    </div>
  );
}

function FullView({
  content,
  lang,
  hl,
  addedLines,
}: {
  content: string;
  lang: string | null;
  hl: Highlighter | null;
  addedLines: Set<number>;
}) {
  return (
    <div className={styles.diff}>
      {content.split('\n').map((text, i) => (
        <div key={i} className={`${styles.diffLine} ${addedLines.has(i + 1) ? styles.diffAdd : ''}`}>
          <span className={styles.diffGutter}>{i + 1}</span>
          <CodeText text={text} lang={lang} hl={hl} />
        </div>
      ))}
    </div>
  );
}

export default function ChangesPanel({ projectId, branch, onClose }: ChangesPanelProps) {
  const [data, setData] = useState<GitChanges | null>(null);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const seededRef = useRef(false);
  // Panel-swap file view: non-null while reading one file's diff. `change` is
  // null for unchanged files opened straight into the full-file view.
  const [openFile, setOpenFile] = useState<{ path: string; change: FileChange | null } | null>(null);
  const [diffLines, setDiffLines] = useState<DiffLine[] | null>(null);
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [viewMode, setViewMode] = useState<'diff' | 'full'>('diff');
  const [fullFile, setFullFile] = useState<{ content: string; truncated: boolean } | 'binary' | 'missing' | null>(
    null,
  );
  const [hl, setHl] = useState<Highlighter | null>(null);
  // Search mode replaces the tree (the file view still wins over both).
  const [searching, setSearching] = useState(false);
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
    setViewMode('diff');
    setFullFile(null);
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

  const loadFull = (p: string) => {
    setFullFile(null);
    getGitFile(projectId, branch, p)
      .then((res) => {
        if (openPathRef.current !== p) return; // stale response
        if (res.binary) setFullFile('binary');
        else if (typeof res.content === 'string') setFullFile({ content: res.content, truncated: !!res.truncated });
        else setFullFile('missing');
      })
      .catch(() => {
        if (openPathRef.current === p) setFullFile('missing');
      });
  };

  // Opens either a tree node or a bare path (search results, which don't carry
  // change info — those land in the full-file view like any unchanged file).
  const openFileDiff = (node: { path: string; change?: FileChange | null }) => {
    const change = node.change ?? null;
    setOpenFile({ path: node.path, change });
    setDiffLines(null);
    setDiffTruncated(false);
    setFullFile(null);
    openPathRef.current = node.path;
    if (!hl) void loadHighlighter().then(setHl);
    if (!change) {
      // Unchanged file: no diff to fetch, go straight to the full-file view.
      setViewMode('full');
      loadFull(node.path);
      return;
    }
    setViewMode('diff');
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

  const lang = useMemo(() => (openFile ? languageFor(openFile.path) : null), [openFile]);
  const addedLines = useMemo(
    () => new Set((diffLines ?? []).filter((l) => l.kind === 'add' && l.newNo != null).map((l) => l.newNo!)),
    [diffLines],
  );

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        {openFile ? (
          <>
            <Button variant="chip" className={styles.backBtn} title="Back to file tree" onClick={closeFileDiff}>
              ‹ back
            </Button>
            <span className={styles.title}>{openFile.path}</span>
            {openFile.change ? (
              <span className={styles.totals}>
                {openFile.change.added > 0 ? <span className={styles.added}>+{openFile.change.added}</span> : null}
                {openFile.change.removed > 0 ? (
                  <span className={styles.removed}>−{openFile.change.removed}</span>
                ) : null}
              </span>
            ) : null}
            {openFile.change ? (
              <Segmented
                className={styles.viewToggle}
                options={VIEW_OPTIONS}
                value={viewMode}
                onChange={(id) => {
                  const mode = id as 'diff' | 'full';
                  setViewMode(mode);
                  if (mode === 'full' && fullFile === null) loadFull(openFile.path);
                }}
              />
            ) : null}
          </>
        ) : (
          <>
            <span className={styles.title}>
              {searching ? 'search' : 'changes'}
              {branch ? ` · ${branch}` : ''}
            </span>
            {!searching && data ? (
              <span className={styles.totals}>
                <span className={styles.added}>
                  +{data.added}
                  {data.files.some((f) => f.approx) ? '+' : ''}
                </span>
                <span className={styles.removed}>−{data.removed}</span>
              </span>
            ) : null}
            <IconButton
              label={searching ? 'Back to file tree' : 'Search files'}
              active={searching}
              className={styles.headGlyphSearch}
              onClick={() => setSearching((v) => !v)}
            >
              ⌕
            </IconButton>
          </>
        )}
        <IconButton label="Close changes panel" className={styles.headGlyph} onClick={onClose}>
          ✕
        </IconButton>
      </div>
      <div className={styles.body}>
        {/* Search stays MOUNTED AND IN LAYOUT under the file view: clicking a
            result and coming back must restore the query, flags, results and
            the scroll position. Hiding it with display:none would have dropped
            the scroll (the box leaves layout), so the file view overlays it. */}
        {searching ? (
          <SearchView projectId={projectId} branch={branch} onOpenFile={(path) => openFileDiff({ path })} />
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
        {openFile ? (
          <div className={styles.fileOverlay}>
            {viewMode === 'full' ? (
              fullFile === null ? (
                <div className={styles.empty}>loading…</div>
              ) : fullFile === 'binary' ? (
                <div className={styles.empty}>binary file</div>
              ) : fullFile === 'missing' ? (
                <div className={styles.empty}>file not found</div>
              ) : (
                <>
                  <FullView content={fullFile.content} lang={lang} hl={hl} addedLines={addedLines} />
                  {fullFile.truncated ? (
                    <div className={styles.empty}>file truncated — showing the first 5,000 lines</div>
                  ) : null}
                </>
              )
            ) : diffLines === null ? (
              <div className={styles.empty}>loading…</div>
            ) : diffLines.length === 0 ? (
              <div className={styles.empty}>no diff (binary or unchanged)</div>
            ) : (
              <>
                <DiffView lines={diffLines} lang={lang} hl={hl} />
                {diffTruncated ? (
                  <div className={styles.empty}>diff truncated — showing the first 5,000 lines</div>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

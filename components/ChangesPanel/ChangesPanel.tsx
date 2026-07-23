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
import {
  getGitChanges,
  getGitDir,
  getGitFile,
  getGitFileDiff,
  checkSyntax,
  revealInFileManager,
  saveGitFile,
  uploadFile,
  type FileChange,
  type GitChanges,
} from '../../lib/client/api';
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

// macOS says "Finder", everyone else says something different — name the one
// the user actually has rather than a generic phrase.
const REVEAL_LABEL =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)
    ? 'Reveal in Finder'
    : 'Reveal in file manager';

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
  root,
  dropDir,
  onToggle,
  onOpenFile,
  onDropFiles,
  onDropOver,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  root: string | null;
  dropDir: string | null;
  onToggle: (node: TreeNode) => void;
  onOpenFile: (node: TreeNode) => void;
  onDropFiles: (dir: string, files: FileList) => void;
  onDropOver: (dir: string | null) => void;
}) {
  const isCollapsed = collapsed.has(node.path);
  const hasDirShape = node.children.length > 0 || !!node.lazy;
  const fg = hasDirShape ? null : glyphFor(node.name);
  const abs = root ? `${root}/${node.path}` : null;
  return (
    <>
      <div
        className={`${styles.row} ${node.change ? styles.rowChanged : ''} ${
          dropDir === node.path ? styles.dropTarget : ''
        }`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={hasDirShape ? () => onToggle(node) : () => onOpenFile(node)}
        role="button"
        // Drag OUT: the absolute path as plain text, which is what a terminal
        // drop (and any other text target) can actually use.
        draggable={!!abs}
        onDragStart={(e) => {
          if (!abs) return;
          e.dataTransfer.setData('text/plain', abs);
          // uri-list too: it is what the terminal's drop gate matches on (a
          // bare text/plain drag is left alone so selections still drag), and
          // it makes a row droppable into other apps as a real file.
          e.dataTransfer.setData('text/uri-list', 'file://' + encodeURI(abs));
          e.dataTransfer.effectAllowed = 'copy';
        }}
        // Drop IN: only directories accept files; a file row hands the drop to
        // its parent dir via the tree container (no stopPropagation here).
        onDragOver={
          hasDirShape
            ? (e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';
                onDropOver(node.path);
              }
            : undefined
        }
        onDrop={
          hasDirShape
            ? (e) => {
                if (!e.dataTransfer.files.length) return;
                e.preventDefault();
                e.stopPropagation();
                onDropFiles(node.path, e.dataTransfer.files);
              }
            : undefined
        }
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
              key={`${c.children.length || c.lazy ? 'd' : 'f'}:${c.path}`}
              node={c}
              depth={depth + 1}
              collapsed={collapsed}
              root={root}
              dropDir={dropDir}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onDropFiles={onDropFiles}
              onDropOver={onDropOver}
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

// Highlighted editor. Two stacked layers sharing one geometry: a <pre> that
// paints the colors and a transparent textarea that owns the caret, selection
// and scrolling. The pre is scrolled programmatically to follow it.
//
// Lines are highlighted individually, exactly like the read-only FullView, so
// the two views agree — and, like FullView, a multi-line construct (block
// comment, template literal) is coloured per line rather than as one span.
const HIGHLIGHT_MAX_LINES = 2000;

function Editor({
  value,
  lang,
  hl,
  errorLines,
  onChange,
  onSave,
}: {
  value: string;
  lang: string | null;
  hl: Highlighter | null;
  errorLines: Set<number>;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  const preRef = useRef<HTMLPreElement | null>(null);
  // Re-highlighting the whole buffer runs on every keystroke, so past a few
  // thousand lines the layer is dropped and the textarea paints itself. Typing
  // that lags is worse than typing without colour.
  // ponytail: an incremental/visible-window highlighter if this ceiling bites.
  const html = useMemo(() => {
    const lines = value.split('\n');
    if (!hl || lines.length > HIGHLIGHT_MAX_LINES) return null;
    // Trailing newline keeps the pre's scroll height equal to the textarea's
    // when the buffer ends on a blank line.
    // Each line is its own span so a syntax error can underline exactly that
    // line's text (wavy red) without disturbing the shared geometry.
    return (
      lines
        .map((l, i) => `<span class="${errorLines.has(i + 1) ? styles.errLine : ''}">${hl.line(l, lang)}</span>`)
        .join('\n') + '\n'
    );
  }, [value, lang, hl, errorLines]);

  return (
    <div className={styles.editorWrap}>
      {html !== null ? (
        // Safe: hljs escapes its input (same contract as CodeText above).
        <pre ref={preRef} className={styles.editorHighlight} aria-hidden dangerouslySetInnerHTML={{ __html: html }} />
      ) : null}
      <textarea
        className={`${styles.editor} ${html === null ? styles.editorPlain : ''}`}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          const pre = preRef.current;
          if (!pre) return;
          pre.scrollTop = e.currentTarget.scrollTop;
          pre.scrollLeft = e.currentTarget.scrollLeft;
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            onSave();
          }
        }}
      />
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
  const [fullFile, setFullFile] = useState<
    { content: string; truncated: boolean; mtimeMs: number } | 'binary' | 'missing' | null
  >(null);
  // Editing is FULL-VIEW ONLY: a diff has no single buffer to write back, and a
  // truncated read has no tail — saving either would silently destroy content.
  // `draft` non-null = in edit mode.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Syntax check of the draft (debounced). `null` = nothing to say — either no
  // checker exists for this file type or the draft parses clean.
  const [syntax, setSyntax] = useState<{ line: number; message: string }[]>([]);
  const [hl, setHl] = useState<Highlighter | null>(null);
  // Absolute repo/worktree root — powers drag-out (a terminal needs a real
  // path) and survives the tree-less polls that follow the first fetch.
  const [root, setRoot] = useState<string | null>(null);
  // Dir row currently under a file drag ('' = the tree background = repo root).
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
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
  // Paths pulled in by expanding an ignored directory (git lists those dirs
  // collapsed — `node_modules/` — so their contents arrive only on demand).
  // Merged into every rebuild so a poll can't fold an expanded dir back up.
  const extraRef = useRef<string[]>([]);
  const filesRef = useRef<FileChange[]>([]);
  const expandingRef = useRef<Set<string>>(new Set());

  const rebuild = useCallback(() => {
    const tree = buildTree([...(treeRef.current ?? []), ...extraRef.current], filesRef.current);
    setNodes(tree);
    return tree;
  }, []);

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
      if (res.root) setRoot(res.root); // tree requests only — keep the last one
      setData(res);
      filesRef.current = res.files;
      const tree = rebuild();
      if (!seededRef.current) {
        seededRef.current = true;
        setCollapsed(collapsedByDefault(tree));
      }
    } catch {
      /* best-effort; next tick retries */
    }
  }, [projectId, branch, rebuild]);

  useEffect(() => {
    // New project/branch → reset EVERYTHING, not just the tree: the old
    // collapsed set, an open file diff, and the seeded flag all describe the
    // previous target and would render the new one under stale UI state.
    treeRef.current = null;
    seededRef.current = false;
    openPathRef.current = null;
    extraRef.current = [];
    filesRef.current = [];
    expandingRef.current = new Set();
    setData(null);
    setNodes([]);
    setCollapsed(new Set());
    setOpenFile(null);
    setDiffLines(null);
    setDiffTruncated(false);
    setViewMode('diff');
    setFullFile(null);
    setDraft(null);
    setSaveError(null);
    setSyntax([]);
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const toggle = (node: TreeNode) => {
    // First expand of an ignored dir: its contents were never listed, fetch
    // them once. Subdirs come back collapsed too, so the same path repeats.
    // NOT gated on children.length — an ignored dir holding a force-added
    // tracked file already has one child, and gating on that showed the single
    // tracked file and hid everything else. expandingRef is the one-shot gate.
    if (node.lazy && !expandingRef.current.has(node.path)) {
      expandingRef.current.add(node.path);
      getGitDir(projectId, branch, node.path)
        .then(({ entries }) => {
          extraRef.current = [...extraRef.current, ...entries];
          rebuild();
          // Nested dirs arrive collapsed (seeding already ran once at mount),
          // otherwise they'd render open-and-empty until clicked twice.
          setCollapsed((prev) => {
            const next = new Set(prev);
            for (const e of entries) if (e.endsWith('/')) next.add(e.replace(/\/+$/, ''));
            return next;
          });
        })
        .catch(() => expandingRef.current.delete(node.path)); // let a retry through
    }
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
  };

  // Files dropped from the desktop land in `dir` (repo-relative, '' = root).
  // Sequential: a 20-file drop shouldn't open 20 concurrent uploads, and the
  // server's no-overwrite suffixing is cleaner when names arrive in order.
  const dropFiles = async (dir: string, files: FileList) => {
    setDropDir(null);
    setDropError(null);
    try {
      for (const file of Array.from(files)) await uploadFile(projectId, branch, dir, file);
    } catch (e) {
      setDropError(e instanceof Error ? e.message : 'upload failed');
    }
    // New files are untracked, so the next poll's `files` carries them — but
    // the tree list is fetched once per mount, so force a re-fetch of it.
    treeRef.current = null;
    void load();
  };

  // Reveal the OPEN FILE when there is one (the OS highlights it in its
  // folder), else the repo root. Fire-and-forget: the window opens on the
  // machine running seshmux, and a failure there has nothing useful to say.
  const revealPath = () => {
    revealInFileManager(projectId, branch, openFile?.path).catch(() => {});
  };

  const loadFull = (p: string) => {
    setFullFile(null);
    setDraft(null);
    setSaveError(null);
    setSyntax([]);
    getGitFile(projectId, branch, p)
      .then((res) => {
        if (openPathRef.current !== p) return; // stale response
        if (res.binary) setFullFile('binary');
        else if (typeof res.content === 'string')
          setFullFile({ content: res.content, truncated: !!res.truncated, mtimeMs: res.mtimeMs ?? 0 });
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
    setDraft(null);
    setSaveError(null);
    setSyntax([]);
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
    setDraft(null);
    setSaveError(null);
    setSyntax([]);
  };

  // Save the editor buffer. The mtime we read with goes back with it: a 409
  // means an agent (or anything else) wrote the file while it was open, and
  // the draft is KEPT so the edit can be redone against fresh content.
  const saveDraft = async () => {
    if (draft === null || !openFile || typeof fullFile !== 'object' || fullFile === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { mtimeMs } = await saveGitFile(projectId, branch, openFile.path, draft, fullFile.mtimeMs);
      setFullFile({ content: draft, truncated: false, mtimeMs });
      setDraft(null);
      treeRef.current = null; // a brand-new file's edit can change the tree
      void load();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'save failed');
    }
    setSaving(false);
  };

  // Debounced syntax check of the buffer. 500ms after typing stops — this is a
  // round trip per pause, not per keystroke. Failures are silent: no checker
  // and no answer both mean "no squiggles", never a false one.
  useEffect(() => {
    if (draft === null || !openFile) return;
    const path = openFile.path;
    const timer = setTimeout(() => {
      checkSyntax(projectId, branch, path, draft)
        .then((res) => {
          if (openPathRef.current === path) setSyntax(res.checked ? res.errors : []);
        })
        .catch(() => setSyntax([]));
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, openFile, projectId, branch]);

  const lang = useMemo(() => (openFile ? languageFor(openFile.path) : null), [openFile]);
  const errorLines = useMemo(() => new Set(syntax.map((e) => e.line)), [syntax]);
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
                  setDraft(null); // leaving full view drops an unsaved buffer
                  if (mode === 'full' && fullFile === null) loadFull(openFile.path);
                }}
              />
            ) : null}
            {/* Edit is offered only for a fully-read file in full view — a
                truncated read has no tail to write back. */}
            {viewMode === 'full' && typeof fullFile === 'object' && fullFile !== null && !fullFile.truncated ? (
              draft === null ? (
                <Button variant="chip" title="Edit this file" onClick={() => setDraft(fullFile.content)}>
                  edit
                </Button>
              ) : (
                <>
                  <Button variant="chip" title="Discard changes" onClick={() => setDraft(null)}>
                    cancel
                  </Button>
                  <Button variant="chip" title="Save to disk" disabled={saving} onClick={() => void saveDraft()}>
                    {saving ? 'saving…' : 'save'}
                  </Button>
                </>
              )
            ) : null}
          </>
        ) : (
          <>
            <span className={styles.title}>
              {searching ? 'search' : 'folder'}
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
        <IconButton label={REVEAL_LABEL} className={styles.headGlyphSearch} onClick={revealPath}>
          ⧉
        </IconButton>
        <IconButton label="Close folder panel" className={styles.headGlyph} onClick={onClose}>
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
          <div
            className={`${styles.tree} ${dropDir === '' ? styles.dropTarget : ''}`}
            // Background of the tree = the repo root. Row handlers stopPropagation,
            // so this only fires for drops that missed a directory row.
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('Files')) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setDropDir('');
            }}
            onDragLeave={() => setDropDir(null)}
            onDrop={(e) => {
              if (!e.dataTransfer.files.length) return;
              e.preventDefault();
              void dropFiles('', e.dataTransfer.files);
            }}
          >
            {dropError ? <div className={styles.empty}>{dropError}</div> : null}
            {nodes.length === 0 ? (
              <div className={styles.empty}>{data ? 'no files' : 'loading…'}</div>
            ) : (
              nodes.map((n) => (
                <Row
                  key={`${n.children.length || n.lazy ? 'd' : 'f'}:${n.path}`}
                  node={n}
                  depth={0}
                  collapsed={collapsed}
                  root={root}
                  dropDir={dropDir}
                  onToggle={toggle}
                  onOpenFile={openFileDiff}
                  onDropFiles={dropFiles}
                  onDropOver={setDropDir}
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
              ) : draft !== null ? (
                <>
                  {saveError ? <div className={styles.empty}>{saveError}</div> : null}
                  <Editor
                    value={draft}
                    lang={lang}
                    hl={hl}
                    errorLines={errorLines}
                    onChange={setDraft}
                    onSave={() => void saveDraft()}
                  />
                  {syntax.length > 0 ? (
                    <div className={styles.syntaxBar} title={syntax.map((e) => `${e.line}: ${e.message}`).join('\n')}>
                      {syntax.length > 1 ? `${syntax.length} syntax errors · ` : ''}
                      line {syntax[0].line}: {syntax[0].message}
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <FullView content={fullFile.content} lang={lang} hl={hl} addedLines={addedLines} />
                  {fullFile.truncated ? (
                    <div className={styles.empty}>file truncated — showing the first 5,000 lines (read-only)</div>
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

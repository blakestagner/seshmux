'use client';

// VS Code-style search/replace over the project's files, rendered inside
// ChangesPanel (shares its .module.scss so the two views read as one panel).
// Backend is `git grep` — see server/lib/git-search.ts.
//
// Search runs debounced and on-demand only: the panel's 10s tree poll must
// never trigger a repo-wide regex sweep. Every request is abortable so a fast
// typist's earlier query can't paint over a later one.
//
// Replace is a write path. Each edit ships the line text the user was looking
// at; the server refuses any line that changed underneath it (see replace()).

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  replaceInFiles,
  searchFiles,
  type ReplaceEdit,
  type SearchFile,
  type SearchQuery,
  type SearchResult,
} from '../../lib/client/api';
import { glyphFor } from '../../lib/client/file-glyphs';
import IconButton from '../ui/IconButton/IconButton';
import TextInput from '../ui/TextInput/TextInput';
import Toggle from '../ui/Toggle/Toggle';
import styles from './ChangesPanel.module.scss';
import { FT_CLASS } from './ft-class';

export interface SearchViewProps {
  projectId: string;
  branch?: string | null;
  onOpenFile: (path: string) => void;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Mirror of buildPattern() in server/lib/git-search.ts — kept in sync by hand
// (4 lines, and server code is not bundled into the client). Used ONLY to
// locate match spans for highlighting; the server owns the actual rewrite.
function buildPattern(q: SearchQuery): RegExp | null {
  try {
    let src = q.regex ? q.query : escapeRe(q.query);
    if (q.wholeWord) src = `\\b(?:${src})\\b`;
    return new RegExp(src, q.caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

// Long lines (minified bundles, data blobs) would blow out the panel — show a
// window around the first match instead of the whole line.
const MAX_LINE = 300;
function windowLine(text: string, at: number): { text: string; offset: number } {
  if (text.length <= MAX_LINE) return { text, offset: 0 };
  const start = Math.max(0, at - 40);
  return { text: text.slice(start, start + MAX_LINE), offset: start };
}

// $&/$1 expansion for the preview only — the server does the real rewrite
// (git-search.replaceInLine) with the identical rule.
function expand(replacement: string, m: RegExpMatchArray, regex: boolean): string {
  if (!regex) return replacement;
  return replacement.replace(/\$(\$|&|\d{1,2})/g, (_, t: string) =>
    t === '$' ? '$' : t === '&' ? m[0] : (m[Number(t)] ?? ''),
  );
}

/** One result line. With a replacement pending it renders VS Code's before/
 *  after pair — the old text struck through in red, the new text in green. */
function MatchText({
  text,
  re,
  replacement,
  regex,
}: {
  text: string;
  re: RegExp | null;
  replacement: string;
  regex: boolean;
}) {
  if (!re) return <span className={styles.matchText}>{text}</span>;
  re.lastIndex = 0;
  const first = re.exec(text);
  const { text: shown, offset } = windowLine(text, first?.index ?? 0);
  const parts: ReactNode[] = [];
  re.lastIndex = 0;
  let last = 0;
  for (const m of shown.matchAll(re)) {
    if (m.index > last) parts.push(shown.slice(last, m.index));
    parts.push(
      replacement ? (
        <span key={`${m.index}`}>
          <del className={styles.hitOld}>{m[0]}</del>
          <ins className={styles.hitNew}>{expand(replacement, m, regex)}</ins>
        </span>
      ) : (
        <mark key={`${m.index}`} className={styles.hit}>
          {m[0]}
        </mark>
      ),
    );
    last = m.index + m[0].length;
    if (m[0].length === 0) break; // zero-width pattern: don't spin
  }
  parts.push(shown.slice(last));
  return (
    <span className={styles.matchText}>
      {offset > 0 ? '…' : ''}
      {parts}
    </span>
  );
}

export default function SearchView({ projectId, branch, onOpenFile }: SearchViewProps) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);

  const q: SearchQuery = { query, caseSensitive, wholeWord, regex, include, exclude, includeIgnored };
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (query: SearchQuery) => {
      abortRef.current?.abort();
      if (!query.query) {
        setResult(null);
        setBusy(false);
        return;
      }
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setBusy(true);
      try {
        const res = await searchFiles(projectId, branch, query, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setResult(res);
      } catch {
        if (!ctrl.signal.aborted) setResult({ files: [], total: 0, truncated: false, error: 'search failed' });
      } finally {
        if (!ctrl.signal.aborted) setBusy(false);
      }
    },
    [projectId, branch],
  );

  // Debounced re-search on any input change. Deps are the primitives, not `q`
  // (a fresh object every render would fire the effect on every keystroke of
  // an unrelated field).
  useEffect(() => {
    const t = setTimeout(
      () => void run({ query, caseSensitive, wholeWord, regex, include, exclude, includeIgnored }),
      250,
    );
    return () => clearTimeout(t);
  }, [run, query, caseSensitive, wholeWord, regex, include, exclude, includeIgnored]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const doReplace = async (edits: ReplaceEdit[]) => {
    if (!edits.length || !replacement) return;
    setBusy(true);
    try {
      const res = await replaceInFiles(projectId, branch, q, replacement, edits);
      const skipped = res.skipped.length;
      setNote(`replaced in ${res.changed.length} file${res.changed.length === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped` : ''}`);
      await run(q); // re-search so the list reflects disk, not our guess
    } catch (e) {
      setNote((e as Error).message || 'replace failed');
    } finally {
      setBusy(false);
    }
  };

  const editsFor = (file: SearchFile, matchIndex?: number, line?: number): ReplaceEdit[] =>
    file.matches
      .filter((m) => line == null || m.line === line)
      .map((m) => ({ path: file.path, line: m.line, expected: m.text, matchIndex }));

  const allEdits = () => (result?.files ?? []).flatMap((f) => editsFor(f));

  const re = buildPattern(q);
  // git grep counts matched LINES; VS Code counts occurrences. Re-count with
  // the same pattern so `10 results` means what the user expects on a line
  // holding two hits. (The server's caps stay line-based — they're about
  // payload size, not what we print.)
  const hits = (text: string) => {
    if (!re) return 1;
    re.lastIndex = 0;
    let n = 0;
    for (const m of text.matchAll(re)) {
      n++;
      if (m[0].length === 0) break; // zero-width pattern: don't spin
    }
    return n || 1;
  };
  const fileHits = (f: SearchFile) => f.matches.reduce((n, m) => n + hits(m.text), 0);
  const totalHits = (result?.files ?? []).reduce((n, f) => n + fileHits(f), 0);
  const toggleFile = (p: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  return (
    <div className={styles.search}>
      <div className={styles.searchForm}>
        <div className={styles.searchRowWrap}>
          <IconButton
            label={showReplace ? 'Hide replace' : 'Show replace'}
            onClick={() => setShowReplace((v) => !v)}
          >
            {showReplace ? '▾' : '▸'}
          </IconButton>
          <div className={styles.searchFields}>
            <div className={styles.searchField}>
              <TextInput value={query} onChange={setQuery} placeholder="Search" className={styles.searchInput} />
              <span className={styles.searchFlags}>
                <IconButton label="Match Case" active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)}>
                  Aa
                </IconButton>
                <IconButton label="Match Whole Word" active={wholeWord} onClick={() => setWholeWord((v) => !v)}>
                  ab
                </IconButton>
                <IconButton label="Use Regular Expression" active={regex} onClick={() => setRegex((v) => !v)}>
                  .*
                </IconButton>
              </span>
            </div>
            {showReplace ? (
              <div className={styles.searchField}>
                <TextInput
                  value={replacement}
                  onChange={setReplacement}
                  placeholder="Replace"
                  className={styles.searchInput}
                />
                <span className={styles.searchFlags}>
                  <IconButton
                    label="Replace All"
                    disabled={!result?.total || !replacement}
                    disabledReason="Enter a search and a replacement first"
                    onClick={() => void doReplace(allEdits())}
                  >
                    AB
                  </IconButton>
                </span>
              </div>
            ) : null}
          </div>
        </div>
        <label className={styles.searchLabel}>files to include</label>
        <TextInput value={include} onChange={setInclude} placeholder="*.ts, app/**" className={styles.searchInput} />
        <label className={styles.searchLabel}>files to exclude</label>
        <TextInput value={exclude} onChange={setExclude} placeholder="*.test.ts, dist" className={styles.searchInput} />
        <div className={styles.searchOption}>
          <Toggle on={includeIgnored} onChange={setIncludeIgnored} />
          <span>search gitignored files</span>
        </div>
      </div>

      <div className={styles.searchResults}>
        {note ? <div className={styles.empty}>{note}</div> : null}
        {result?.error ? (
          <div className={styles.searchError}>{result.error}</div>
        ) : !query ? (
          <div className={styles.empty}>type to search this project</div>
        ) : busy && !result ? (
          <div className={styles.empty}>searching…</div>
        ) : !result || result.total === 0 ? (
          <div className={styles.empty}>no results</div>
        ) : (
          <>
            <div className={styles.searchSummary}>
              {totalHits} result{totalHits === 1 ? '' : 's'} in {result.files.length} file
              {result.files.length === 1 ? '' : 's'}
              {result.truncated ? ' (truncated)' : ''}
            </div>
            {result.files.map((file) => {
              // Filename carries the color, its directory trails dim (VS Code):
              // a column of full paths is unscannable in a narrow panel.
              const slash = file.path.lastIndexOf('/');
              const base = file.path.slice(slash + 1);
              const dir = slash < 0 ? '' : file.path.slice(0, slash);
              const fg = glyphFor(base);
              const isCollapsed = collapsed.has(file.path);
              return (
                <div key={file.path}>
                  <div
                    className={styles.resultFile}
                    onClick={() => toggleFile(file.path)}
                    role="button"
                    title={file.path}
                  >
                    <span className={styles.caret}>{isCollapsed ? '▸' : '▾'}</span>
                    <span className={`${styles.glyph} ${FT_CLASS[fg.category]}`}>{fg.glyph}</span>
                    <span className={`${styles.name} ${FT_CLASS[fg.category]}`}>{base}</span>
                    {dir ? <span className={styles.resultDir}>{dir}</span> : null}
                    <span className={styles.count}>{fileHits(file)}</span>
                    {showReplace && replacement ? (
                      <IconButton
                        label={`Replace all in ${file.path}`}
                        className={styles.rowAction}
                        onClick={(e) => {
                          e.stopPropagation();
                          void doReplace(editsFor(file));
                        }}
                      >
                        ⇄
                      </IconButton>
                    ) : null}
                  </div>
                  {isCollapsed
                    ? null
                    : file.matches.map((m, i) => (
                        <div
                          key={`${m.line}:${i}`}
                          className={styles.resultMatch}
                          onClick={() => onOpenFile(file.path)}
                          role="button"
                        >
                          <span className={styles.diffGutter}>{m.line}</span>
                          <MatchText
                            text={m.text}
                            re={re}
                            replacement={showReplace ? replacement : ''}
                            regex={regex}
                          />
                          {showReplace && replacement ? (
                            <IconButton
                              label="Replace this match"
                              className={styles.rowAction}
                              onClick={(e) => {
                                e.stopPropagation();
                                // matchIndex 0: one row == one LINE, so this
                                // replaces the line's first match. Repeat the
                                // click for later matches on the same line.
                                void doReplace([{ path: file.path, line: m.line, expected: m.text, matchIndex: 0 }]);
                              }}
                            >
                              ⇄
                            </IconButton>
                          ) : null}
                        </div>
                      ))}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

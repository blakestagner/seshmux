'use client';

// Search state used by the right-pane memory panel.
//
// Built once and used by both, so the two surfaces cannot disagree about what "this repo"
// means, how debouncing behaves, or which request wins a race. The alternative — each
// component owning its own copy — is exactly how the scope toggle would end up meaning
// something subtly different in the menu than in the panel.

import { useCallback, useEffect, useRef, useState } from 'react';
import { searchMemory, type MemoryKind, type MemoryRow, type MemoryScopeMode } from '../../lib/client/api';

export const MEMORY_KIND_FILTERS: { id: MemoryKind; label: string }[] = [
  { id: 'decision', label: 'decisions' },
  { id: 'lesson', label: 'lessons' },
  { id: 'prompt', label: 'prompts' },
  { id: 'outcome', label: 'findings' },
  { id: 'error', label: 'errors' },
  { id: 'tool-call', label: 'commands' },
  { id: 'artifact', label: 'files' },
];

/**
 * What a session is actually ABOUT: what was asked, what was concluded, what was decided
 * or learned, and what went wrong.
 *
 * The complement — `tool-call` and `artifact` — is the mechanical record of every command
 * run and every file touched. It is the bulk of any store (~79% of a real one) and almost
 * none of its value: "ran `ls`" and "edited tokens.js" tell a later session nothing it
 * could not work out faster itself. The panel opens on THIS set so the list is legible,
 * and the commands/files chips are still there when you want the mechanical detail.
 */
export const SUBSTANCE_KINDS: MemoryKind[] = ['decision', 'lesson', 'prompt', 'outcome', 'error'];

const DEBOUNCE_MS = 160;

export interface MemorySearchState {
  query: string;
  setQuery: (v: string) => void;
  scope: MemoryScopeMode;
  setScope: (v: MemoryScopeMode) => void;
  kinds: MemoryKind[];
  toggleKind: (k: MemoryKind) => void;
  rows: MemoryRow[];
  total: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useMemorySearch(projectId: string | undefined, refreshKey = 0, limit = 60): MemorySearchState {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<MemoryScopeMode>('project'); // repo-first
  const [kinds, setKinds] = useState<MemoryKind[]>(SUBSTANCE_KINDS);
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // One in-flight request at a time. Without the abort, a fast typist sees results for a
  // prefix land after results for the full query and overwrite them.
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      inflight.current?.abort();
      const ctrl = new AbortController();
      inflight.current = ctrl;
      setLoading(true);
      // An EMPTY chip set means the default view, not "everything". The store reads an
      // empty kind list as no filter at all, so with a non-empty default the last untick
      // would have jumped from five kinds to all seven — narrowing the filter showing
      // MORE. Everything is still reachable: tick commands and files as well.
      const kindFilter = kinds.length ? kinds : SUBSTANCE_KINDS;
      searchMemory({ q: query || undefined, project: projectId, scope, kind: kindFilter, limit }, ctrl.signal)
        .then((res) => {
          if (ctrl.signal.aborted) return;
          setRows(res.rows);
          setTotal(res.total);
          setError(null);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          setError(err instanceof Error ? err.message : 'memory search failed');
          setRows([]);
          setTotal(0);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, projectId, scope, kinds, limit, refreshKey, nonce]);

  useEffect(() => () => inflight.current?.abort(), []);

  const toggleKind = useCallback((k: MemoryKind) => {
    setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { query, setQuery, scope, setScope, kinds, toggleKind, rows, total, loading, error, refresh };
}

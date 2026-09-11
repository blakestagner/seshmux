'use client';

// Search state for the right-pane memory panel.
//
// There is no kind filter. The panel's unit is a SESSION, not a record, and a row of
// seven category chips asked the reader to curate a taxonomy before they could get at
// what a session worked out. The query always runs over SUBSTANCE_KINDS — what was asked,
// concluded, decided, learned and what broke — and never over the mechanical tool-call and
// artifact records, which are ~79% of any real store and almost none of its value.

import { useCallback, useEffect, useRef, useState } from 'react';
import { searchMemory, type MemoryRow, type MemoryScopeMode } from '../../lib/client/api';
import { SUBSTANCE_KINDS } from './kinds';

const DEBOUNCE_MS = 160;

export interface MemorySearchState {
  query: string;
  setQuery: (v: string) => void;
  scope: MemoryScopeMode;
  setScope: (v: MemoryScopeMode) => void;
  rows: MemoryRow[];
  total: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useMemorySearch(projectId: string | undefined, refreshKey = 0, limit = 60): MemorySearchState {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<MemoryScopeMode>('project'); // repo-first
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
      searchMemory({ q: query || undefined, project: projectId, scope, kind: SUBSTANCE_KINDS, limit }, ctrl.signal)
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
  }, [query, projectId, scope, limit, refreshKey, nonce]);

  useEffect(() => () => inflight.current?.abort(), []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { query, setQuery, scope, setScope, rows, total, loading, error, refresh };
}

'use client';

// The search + scope + kind cluster. Built once and composed by BOTH the statusbar dropdown
// and the right-pane panel, so "this repo" cannot come to mean two different things.

import Segmented from '../ui/Segmented/Segmented';
import TextInput from '../ui/TextInput/TextInput';
import type { MemoryKind, MemoryScopeMode } from '../../lib/client/api';
import { MEMORY_KIND_FILTERS } from './useMemorySearch';
import styles from './Memory.module.scss';

const SCOPE_OPTIONS = [
  { id: 'project', label: 'this repo' },
  { id: 'all', label: 'all repos' },
];

export type MemoryFiltersProps = {
  query: string;
  onQuery: (v: string) => void;
  scope: MemoryScopeMode;
  onScope: (v: MemoryScopeMode) => void;
  kinds: MemoryKind[];
  onToggleKind: (k: MemoryKind) => void;
  placeholder?: string;
  autoFocus?: boolean;
};

export default function MemoryFilters({
  query,
  onQuery,
  scope,
  onScope,
  kinds,
  onToggleKind,
  placeholder = 'search memory…',
  autoFocus,
}: MemoryFiltersProps) {
  return (
    <div className={styles.filters}>
      <TextInput value={query} onChange={onQuery} placeholder={placeholder} autoFocus={autoFocus} />
      <Segmented
        options={SCOPE_OPTIONS}
        value={scope}
        onChange={(id) => onScope(id as MemoryScopeMode)}
        variant="raised"
      />
      <div className={styles.kinds}>
        {MEMORY_KIND_FILTERS.map((k) => (
          <button
            key={k.id}
            type="button"
            className={`${styles.kindChip} ${kinds.includes(k.id) ? styles.kindOn : ''}`}
            onClick={() => onToggleKind(k.id)}
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}

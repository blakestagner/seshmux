'use client';

// The search + scope cluster above the session list.
//
// Search and "which repo" only. The kind chips that used to live here are gone: the panel
// hands over a session's memory as one piece, and deciding which of seven record
// categories to include was a taxonomy question nobody wanted to answer first.

import Segmented from '../ui/Segmented/Segmented';
import TextInput from '../ui/TextInput/TextInput';
import type { MemoryScopeMode } from '../../lib/client/api';
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
  placeholder?: string;
  autoFocus?: boolean;
};

export default function MemoryFilters({
  query,
  onQuery,
  scope,
  onScope,
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
    </div>
  );
}

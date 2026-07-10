'use client';

import { useEffect, useRef, useState } from 'react';
import TextInput from './ui/TextInput';
import Segmented from './ui/Segmented';
import StatusDot from './ui/StatusDot';
import IconButton from './ui/IconButton';
import SearchDropdown from './SearchDropdown';
import { search, type SearchHit } from '../lib/client/api';
import { toggleTheme } from '../lib/client/theme';
import { useAppState } from '../lib/client/store';
import { rollup, type AgentBucket } from '../lib/client/status-rollup';
import styles from './TopNav.module.scss';

const VIEW_OPTIONS = [
  { id: 'tabs', label: 'Tabs' },
  { id: 'grid', label: 'Grid' },
  { id: 'agents', label: 'Agents' },
];

export type TopNavProps = {
  onPickHit: (hit: SearchHit) => void;
  onOpenCustomizations: () => void;
};

export default function TopNav({ onPickHit, onOpenCustomizations }: TopNavProps) {
  const { state, dispatch } = useAppState();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTheme((document.documentElement.dataset.theme as 'dark' | 'light') || 'dark');
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setOpen(false);
      return;
    }
    let cancelled = false;
    search(q).then((res) => {
      if (!cancelled) {
        setHits(res);
        setOpen(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [query]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        wrapRef.current?.querySelector('input')?.focus();
      }
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  function handleToggleTheme() {
    toggleTheme();
    setTheme((document.documentElement.dataset.theme as 'dark' | 'light') || 'dark');
  }

  function handlePick(hit: SearchHit) {
    setOpen(false);
    setQuery('');
    onPickHit(hit);
  }

  // Four-state rollup (shared selector — same buckets the Agents view renders).
  const { counts } = rollup(state.tabs);
  const SEGMENTS: { key: AgentBucket; dot: 'live' | 'waiting' | 'unviewed' | 'neutral' }[] = [
    { key: 'working', dot: 'live' },
    { key: 'waiting', dot: 'waiting' },
    { key: 'done', dot: 'unviewed' },
    { key: 'idle', dot: 'neutral' },
  ];
  const visible = SEGMENTS.filter((s) => counts[s.key] > 0);

  return (
    <nav className={styles.nav}>
      <div className={styles.logo}>
        <span className={styles.mark}>s</span>
        seshmux
      </div>
      <div className={styles.searchWrap} ref={wrapRef}>
        <span className={styles.searchIcon}>⌕</span>
        <TextInput value={query} onChange={setQuery} placeholder="Search all transcripts" kbdHint="⌘K" />
        <SearchDropdown open={open} query={query} hits={hits} onPick={handlePick} />
      </div>
      <div className={styles.right}>
        <Segmented
          options={VIEW_OPTIONS}
          value={state.view}
          onChange={(id) => dispatch({ type: 'setView', view: id as 'tabs' | 'grid' | 'agents' })}
        />
        {visible.length > 0 ? (
          <button
            type="button"
            className={styles.liveBadge}
            title="Open agents view"
            onClick={() => dispatch({ type: 'setView', view: 'agents' })}
          >
            {visible.map((s, i) => (
              <span key={s.key} className={styles.badgeText}>
                {i > 0 ? <span className={styles.dot}>·</span> : null}
                <StatusDot status={s.dot} size={7} />
                &nbsp;{counts[s.key]} {s.key}
              </span>
            ))}
          </button>
        ) : null}
        <IconButton label="Toggle light / dark" variant="boxed" onClick={handleToggleTheme}>
          {theme === 'dark' ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <circle cx="12" cy="12" r="4" />
              <line x1="12" y1="2" x2="12" y2="4" />
              <line x1="12" y1="20" x2="12" y2="22" />
              <line x1="4.93" y1="4.93" x2="6.34" y2="6.34" />
              <line x1="17.66" y1="17.66" x2="19.07" y2="19.07" />
              <line x1="2" y1="12" x2="4" y2="12" />
              <line x1="20" y1="12" x2="22" y2="12" />
              <line x1="4.93" y1="19.07" x2="6.34" y2="17.66" />
              <line x1="17.66" y1="6.34" x2="19.07" y2="4.93" />
            </svg>
          )}
        </IconButton>
        <IconButton label="Customizations" variant="boxed" onClick={onOpenCustomizations}>
          {/* agents/skills/hooks/mcp browser — distinct from the Settings sliders glyph */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </svg>
        </IconButton>
        <IconButton
          label="Settings"
          variant="boxed"
          active={state.settingsOpen}
          onClick={() => dispatch({ type: state.settingsOpen ? 'closeSettings' : 'openSettings' })}
        >
          {/* design-markup L38: sliders icon, knob fill matches the bar bg */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <line x1="4" y1="8" x2="20" y2="8" />
            <line x1="4" y1="16" x2="20" y2="16" />
            <circle cx="9" cy="8" r="2.6" fill="var(--bg-panel)" />
            <circle cx="15" cy="16" r="2.6" fill="var(--bg-panel)" />
          </svg>
        </IconButton>
      </div>
    </nav>
  );
}

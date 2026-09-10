'use client';

// The memory surface: browse, curate, and load into the live session.
//
// This used to be half the story — a statusbar dropdown did the loading and this panel
// did everything else, which meant two places to look and a 560px popup that had to be
// squeezed in beside the rail. The picker moved here: same filters, same rows (composed
// from components/Memory), plus the full record body, pin/forget, hand-authoring,
// distillation, and the selection + token budget that loading needs.
//
// The budget is shown BEFORE the load, not after, because context spent on recalled
// memory is context the session cannot spend on anything else.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from '../ui/Button/Button';
import IconButton from '../ui/IconButton/IconButton';
import TextInput from '../ui/TextInput/TextInput';
import MemoryFilters from '../Memory/MemoryFilters';
import MemoryRowItem from '../Memory/MemoryRowItem';
import { useMemorySearch } from '../Memory/useMemorySearch';
import {
  createMemory,
  deleteMemory,
  distillMemory,
  memoryStats,
  packMemory,
  updateMemory,
  type MemoryRow,
  type MemoryStats,
} from '../../lib/client/api';
import { budgetLabel, estimateRowTokens, memoryPaste } from '../../lib/client/memory-paste';
import { getTermSend } from '../../lib/client/term-send';
import type { ProviderId } from '../../lib/client/types';
import styles from './MemoryPanel.module.scss';

export type MemoryPanelProps = {
  projectId?: string;
  /** The session in view — enables distilling just that session. */
  sessionId?: string;
  provider?: ProviderId;
  branch?: string | null;
  /** Bumped by the {event:'memory'} ping. */
  refreshKey?: number;
  /** The PTY to load into. Its writer is looked up at click time from the registry
   *  TerminalPane publishes to (lib/client/term-send). */
  ptyId?: string;
  /** False once the session has exited — Load disables rather than pretending to
   *  paste into a terminal nobody is listening to. */
  canLoad?: boolean;
  budgetTokens?: number;
  /** Setting: press Enter after loading. Default false — the block is staged, not sent. */
  submitOnLoad?: boolean;
  onClose?: () => void;
};

export default function MemoryPanel({
  projectId,
  sessionId,
  provider,
  branch,
  refreshKey = 0,
  ptyId,
  canLoad = false,
  budgetTokens = 1500,
  submitOnLoad = false,
  onClose,
}: MemoryPanelProps) {
  const search = useMemorySearch(projectId, refreshKey, 200);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  // The selected ROWS, not just their ids. Holding ids alone made the token count a
  // function of what happened to be on screen, so narrowing the query after picking
  // silently under-counted while Load still sent everything.
  const [selected, setSelected] = useState<MemoryRow[]>([]);

  const selectedIds = useMemo(() => new Set(selected.map((r) => r.id)), [selected]);
  const used = estimateRowTokens(selected);
  const over = used > budgetTokens;

  const toggle = (id: string) => {
    setNote(null);
    const row = search.rows.find((r) => r.id === id);
    setSelected((cur) => {
      if (cur.some((r) => r.id === id)) return cur.filter((r) => r.id !== id);
      return row ? [...cur, row] : cur;
    });
  };

  async function load() {
    if (!canLoad || selected.length === 0) return;
    // Resolved HERE, not at render: the writer comes and goes with the terminal socket,
    // and a stale capture would paste into a closed one. If it is missing, SAY so — a
    // no-op that still reported success is worse than an error, because the context
    // never arrived and nothing said otherwise.
    const send = getTermSend(ptyId);
    if (!send) {
      setNote({ text: 'this terminal is not connected', error: true });
      return;
    }
    setBusy('load');
    setNote(null);
    try {
      // The server composes the block, so what lands in the terminal is byte-identical
      // to what an agent gets from recall_memory — one composer, not two.
      const packed = await packMemory(
        selected.map((r) => r.id),
        { budgetTokens, scope: search.scope },
      );
      const payload = memoryPaste(packed.text, { submit: submitOnLoad });
      if (!payload) {
        setNote({ text: 'nothing to load', error: false });
        return;
      }
      // packMemory TRIMS to the budget, so the count that matters is the one that came
      // back. Reporting the tick count made "select all" over budget claim it loaded 70
      // records when the server had packed the top ~20.
      const n = packed.count;
      if (!send(payload)) {
        // Registered but not writable: the socket is closed or mid-reconnect after a
        // server update. Keep the selection so the user can simply try again.
        setNote({ text: 'this terminal is not connected', error: true });
        return;
      }
      setSelected([]);
      setNote({
        text:
          n < selected.length
            ? `loaded the top ${n} of ${selected.length} — the rest did not fit the budget`
            : `loaded ${n} record${n === 1 ? '' : 's'} into the session`,
        error: false,
      });
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : 'load failed', error: true });
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    let alive = true;
    memoryStats()
      .then((s) => alive && setStats(s))
      .catch(() => alive && setStats(null));
    return () => {
      alive = false;
    };
  }, [refreshKey, search.rows.length]);

  const act = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(label);
      setNote(null);
      try {
        await fn();
        search.refresh();
      } catch (err) {
        setNote({ text: err instanceof Error ? err.message : `${label} failed`, error: true });
      } finally {
        setBusy(null);
      }
    },
    [search],
  );

  const onPin = (row: MemoryRow) => act('pin', () => updateMemory(row.id, { pinned: !row.pinned }));
  // Selection is held as ROWS and survives the query changing. Narrowing the search to
  // find the next record to add is the normal way to use this panel, so reconciling the
  // selection against what happens to be VISIBLE silently threw away earlier picks.
  // Being forgotten is the one thing that should unselect a record, so do it here.
  const onDelete = (row: MemoryRow) =>
    act('forget', async () => {
      await deleteMemory(row.id);
      setSelected((cur) => cur.filter((r) => r.id !== row.id));
    });

  const onRemember = () => {
    if (!projectId || !draft.trim()) return;
    void act('remember', async () => {
      await createMemory({ projectId, text: draft, kind: 'lesson' });
      setDraft('');
    });
  };

  const onDistill = () => {
    if (!projectId || !sessionId) return;
    void act('distill', async () => {
      const res = await distillMemory({ projectId, sessionId, provider, branch });
      setNote(
        res.error
          ? { text: `distill failed: ${res.error}`, error: true }
          : {
              text: `distilled ${res.facts} fact${res.facts === 1 ? '' : 's'} from ${res.chunks} chunk${res.chunks === 1 ? '' : 's'}`,
              error: false,
            },
      );
    });
  };

  return (
    <div className={styles.panel}>
      {/* Same head as ChangesPanel/PortsPanel/TeamPanel, so the right-pane slot reads as
          one family and the panel is closable from the panel itself, not only its tab. */}
      <div className={styles.head}>
        <span className={styles.headGlyph} aria-hidden="true">
          ◆
        </span>
        <span className={styles.title}>Memory</span>
        {onClose ? (
          <IconButton label="Close memory" onClick={onClose}>
            ✕
          </IconButton>
        ) : null}
      </div>
      <MemoryFilters
        query={search.query}
        onQuery={search.setQuery}
        scope={search.scope}
        onScope={search.setScope}
        kinds={search.kinds}
        onToggleKind={search.toggleKind}
        placeholder="search everything agents have done here…"
      />

      <div className={styles.list}>
        {search.error ? <p className={styles.empty}>{search.error}</p> : null}
        {!search.error && search.rows.length === 0 ? (
          <p className={styles.empty}>
            {search.loading ? 'searching…' : 'Nothing remembered yet — memory fills in as sessions run.'}
          </p>
        ) : null}
        {search.rows.map((row) => (
          <MemoryRowItem
            key={row.id}
            row={row}
            expanded
            selected={selectedIds.has(row.id)}
            onToggle={toggle}
            onPin={onPin}
            onDelete={onDelete}
            showRepo={search.scope === 'all'}
          />
        ))}
      </div>

      {/* Loading bar. Always present once there is anything to load, because the common
          intent is "take what this session worked out into the next one" — and having to
          hunt for a checkbox to tick before the Load button even appears is a poor way to
          ask for that. Empty-handed it offers to take the lot. */}
      {search.rows.length > 0 ? (
        <div className={styles.loadBar}>
          <span className={over ? styles.budgetOver : styles.budget}>
            {selected.length > 0
              ? `${selected.length} selected · ${budgetLabel(used, budgetTokens)}`
              : `${search.rows.length} shown`}
          </span>
          <Button
            variant="link"
            className={styles.clear}
            onClick={() => setSelected(selected.length > 0 ? [] : [...search.rows])}
          >
            {selected.length > 0 ? 'clear' : 'select all'}
          </Button>
          <Button
            variant="primary"
            disabled={busy === 'load' || !canLoad || selected.length === 0}
            title={
              !canLoad
                ? 'this session is not live'
                : over
                  ? 'over budget — the pack will be trimmed to the highest-ranked records'
                  : 'paste into this session (does not press Enter)'
            }
            onClick={load}
          >
            {busy === 'load' ? 'loading…' : 'Load into session'}
          </Button>
        </div>
      ) : null}

      <div className={styles.compose}>
        <TextInput
          value={draft}
          onChange={setDraft}
          placeholder="remember something for future sessions here…"
          multiline={2}
        />
        <div className={styles.composeRow}>
          <Button disabled={!projectId || !draft.trim() || busy === 'remember'} onClick={onRemember}>
            {busy === 'remember' ? 'saving…' : 'Remember'}
          </Button>
          <Button
            disabled={!projectId || !sessionId || busy === 'distill'}
            title={
              sessionId
                ? 'Run the agent over this session to extract decisions and lessons'
                : 'Open a session to distil it'
            }
            onClick={onDistill}
          >
            {busy === 'distill' ? 'distilling…' : 'Distil session'}
          </Button>
          {note ? (
            <span className={note.error ? styles.noteError : styles.note}>{note.text}</span>
          ) : null}
          {stats ? (
            <span className={styles.stats}>
              {search.total} shown · {stats.total} stored · {stats.pinned} pinned
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

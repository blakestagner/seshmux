'use client';

// The memory surface: pick a session's memory and hand it on.
//
// The panel deals in SESSIONS, not records. You tick the sessions whose work you want,
// and Copy or Load hands over everything they learned as one block. The records are
// underneath for checking what you are about to pass along, and pin/forget curate them,
// but nothing here asks you to assemble a payload out of individual rows or to decide
// which of seven record categories counts — that was a taxonomy quiz standing in front of
// a simple intention.
//
// The budget is shown BEFORE the hand-off, not after, because context spent on recalled
// memory is context the session cannot spend on anything else.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from '../ui/Button/Button';
import IconButton from '../ui/IconButton/IconButton';
import TextInput from '../ui/TextInput/TextInput';
import MemoryFilters from '../Memory/MemoryFilters';
import MemoryGroupList from '../Memory/MemoryGroupList';
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
import { groupBySession, type MemoryGroup } from '../../lib/client/memory-groups';
import { getTermSend } from '../../lib/client/term-send';
import type { ProviderId } from '../../lib/client/types';
import styles from './MemoryPanel.module.scss';

/** Records fetched per query, across ALL sessions — not per session. */
const ROW_LIMIT = 200;

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
  const search = useMemorySearch(projectId, refreshKey, ROW_LIMIT);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  // The selected GROUPS, whole, not just their ids. Holding ids alone would make the
  // token count a function of what happened to be on screen, so narrowing the query after
  // picking would silently under-count while the hand-off still sent everything.
  const [selected, setSelected] = useState<Map<string, MemoryGroup>>(new Map());

  const searching = search.query.trim().length > 0;
  // The query is capped (ROW_LIMIT) across ALL sessions, so a busy store hands back a
  // SLICE of each session and a group's "N records" is the part that made the cut. Say
  // so: this used to be visible as "N shown" in the load bar, and grouping replaced that
  // with a session count — which reads as a complete inventory when it is not.
  const truncated = search.total > search.rows.length;
  // Built here rather than in the list, so the load bar counts the same groups the list
  // draws instead of re-deriving "how many sessions is this" from a second rule.
  const groups = useMemo(() => groupBySession(search.rows, { searching }), [search.rows, searching]);

  // Deduped by id. Selection holds group SNAPSHOTS taken at tick time and is
  // deliberately never reconciled against refetched rows, so the same record can sit in
  // two of them: groupBySession lifts a pinned record out of its session into the Pinned
  // group, and unpinning it between two ticks puts it back. The pack route maps ids
  // straight through, so the block would have carried it twice and over-counted the
  // budget against it.
  const selectedRows = useMemo(
    () => [...new Map([...selected.values()].flatMap((g) => g.rows).map((r) => [r.id, r])).values()],
    [selected],
  );
  const selectedIds = useMemo(() => new Set(selected.keys()), [selected]);
  const used = estimateRowTokens(selectedRows);
  const over = used > budgetTokens;

  const toggleGroup = (group: MemoryGroup, select: boolean) => {
    setNote(null);
    setSelected((cur) => {
      const next = new Map(cur);
      if (select) next.set(group.id, group);
      else next.delete(group.id);
      return next;
    });
  };

  const selectAll = (select: boolean) =>
    setSelected(select ? new Map(groups.map((g) => [g.id, g])) : new Map());

  /**
   * The one block these sessions add up to.
   *
   * The SERVER composes it, so what you copy, what lands in a terminal and what an agent
   * gets from recall_memory are byte-identical — one composer, not three. It also trims
   * to the budget, which is why the caller reports the count that came BACK: reporting
   * the tick count made an over-budget selection claim it handed over 70 records when the
   * server had packed the top ~20.
   */
  const packSelection = () =>
    packMemory(
      selectedRows.map((r) => r.id),
      { budgetTokens, scope: search.scope },
    );

  const handedOver = (n: number, verb: string) =>
    n < selectedRows.length
      ? `${verb} the top ${n} of ${selectedRows.length} records — the rest did not fit the budget`
      : `${verb} ${n} record${n === 1 ? '' : 's'} from ${selected.size} session${selected.size === 1 ? '' : 's'}`;

  async function copy() {
    if (selectedRows.length === 0) return;
    setBusy('copy');
    setNote(null);
    try {
      const packed = await packSelection();
      await navigator.clipboard.writeText(packed.text);
      setNote({ text: handedOver(packed.count, 'copied'), error: false });
    } catch (err) {
      // Clipboard writes are refused outside a secure context or without permission, and
      // silently "succeeding" would leave the user pasting whatever was there before.
      setNote({ text: err instanceof Error ? err.message : 'copy failed', error: true });
    } finally {
      setBusy(null);
    }
  }

  async function load() {
    if (!canLoad || selectedRows.length === 0) return;
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
      const packed = await packSelection();
      const payload = memoryPaste(packed.text, { submit: submitOnLoad });
      if (!payload) {
        setNote({ text: 'nothing to load', error: false });
        return;
      }
      if (!send(payload)) {
        // Registered but not writable: the socket is closed or mid-reconnect after a
        // server update. Keep the selection so the user can simply try again.
        setNote({ text: 'this terminal is not connected', error: true });
        return;
      }
      const n = packed.count;
      setSelected(new Map());
      setNote({ text: handedOver(n, 'loaded'), error: false });
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
  // Selection holds whole GROUPS and survives the query changing. Narrowing the search to
  // find the next session to add is the normal way to use this panel, so reconciling the
  // selection against what happens to be VISIBLE would silently throw away earlier picks.
  // A forgotten record is the one thing that has to be dropped from it — otherwise the
  // token count, and the hand-off, would still carry a record that no longer exists.
  const onDelete = (row: MemoryRow) =>
    act('forget', async () => {
      await deleteMemory(row.id);
      setSelected((cur) => {
        const next = new Map(cur);
        for (const [id, group] of next) {
          if (!group.rows.some((r) => r.id === row.id)) continue;
          const rows = group.rows.filter((r) => r.id !== row.id);
          if (rows.length) next.set(id, { ...group, rows });
          else next.delete(id);
        }
        return next;
      });
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
        placeholder="search what these sessions worked out…"
      />

      <div className={styles.list}>
        {search.error ? <p className={styles.empty}>{search.error}</p> : null}
        {!search.error && search.rows.length === 0 ? (
          <p className={styles.empty}>
            {search.loading ? 'searching…' : 'Nothing remembered yet — memory fills in as sessions run.'}
          </p>
        ) : null}
        {groups.length > 0 ? (
          <MemoryGroupList
            groups={groups}
            searching={searching}
            selectedGroups={selectedIds}
            onToggleGroup={toggleGroup}
            onPin={onPin}
            onDelete={onDelete}
            showRepo={search.scope === 'all'}
          />
        ) : null}
      </div>

      {/* The hand-off bar. Always present once there is anything to hand over, because the
          common intent is "take what that session worked out into this one" — and having
          to hunt for a checkbox to tick before the buttons even appear is a poor way to
          ask for that. Empty-handed it offers to take the lot.

          Copy sits beside Load because the destination is not always a terminal: a
          session's memory is just as often pasted into a review, an issue, or another
          machine's agent. Same block either way. */}
      {groups.length > 0 ? (
        <div className={styles.loadBar}>
          <span className={over ? styles.budgetOver : styles.budget}>
            {selected.size > 0
              ? `${selected.size} session${selected.size === 1 ? '' : 's'} · ${budgetLabel(used, budgetTokens)}`
              : `${groups.length} session${groups.length === 1 ? '' : 's'}${truncated ? ` · top ${search.rows.length} of ${search.total} records` : ''}`}
          </span>
          <Button variant="link" className={styles.clear} onClick={() => selectAll(selected.size === 0)}>
            {selected.size > 0 ? 'clear' : 'select all'}
          </Button>
          <Button
            disabled={busy === 'copy' || selected.size === 0}
            title="copy this memory to the clipboard"
            onClick={copy}
          >
            {busy === 'copy' ? 'copying…' : 'Copy'}
          </Button>
          <Button
            variant="primary"
            disabled={busy === 'load' || !canLoad || selected.size === 0}
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
              {/* `search.total` is the match count BEFORE the row limit, so labelling it
                  "shown" overstated the list whenever the two differed. */}
              {search.rows.length} shown · {search.total} matched · {stats.total} stored ·{' '}
              {stats.pinned} pinned
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

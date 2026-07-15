'use client';
// Read-only Copilot-style customizations browser (Task 6). Left nav + right
// content: Overview cards, then per-concept list/detail (agents, skills,
// instructions, hooks, MCP servers), plus a Projects section (Task 7 fills
// in the body — this task ships the nav entry + placeholder only). Scope
// (global vs one project) drives which GET /api/customizations call fires;
// pre-scoped when opened from a project row via projectId/projectName.

import { useEffect, useRef, useState } from 'react';
import styles from './CustomizationsModal.module.scss';
import menu from '../ui/Menu/Menu.module.scss';
import OptionRow from '../ui/OptionRow/OptionRow';
import TextInput from '../ui/TextInput/TextInput';
import ProjectVisibilityList from '../ProjectVisibilityList/ProjectVisibilityList';
import {
  getCustomizations,
  putCustomizationItem,
  assistCustomization,
  startSession,
  type CustomizationsPayload,
} from '../../lib/client/api';
import { renderMarkdown } from '../Transcript/Transcript';
import Button from '../ui/Button/Button';
import { PROV } from '../ui/ProviderBadge/ProviderBadge';
import { useAppState } from '../../lib/client/store';
import type { CustomizationItem, Project, ProviderId } from '../../lib/client/types';

// Server enforces the same pattern (server/lib/providers/customizations.ts) —
// mirrored here so Save disables client-side before a round trip.
const NAME_RE = /^[a-z0-9-]{1,64}$/;

const SKILL_TEMPLATE = '---\nname: \ndescription: \n---\n\n';

// filePath -> the kebab name Save needs. Skills live at .../skills/<name>/SKILL.md
// (parent dir is the name); agents are flat .../agents/<name>.md.
function kebabFromItem(section: 'agents' | 'skills', item: CustomizationItem): string {
  const parts = item.filePath.split('/');
  if (section === 'skills') return parts[parts.length - 2] ?? '';
  const base = parts[parts.length - 1] ?? '';
  return base.replace(/\.md$/, '');
}

type Editing = { section: 'agents' | 'skills'; name: string; content: string; isNew: boolean };

// SKILL_TEMPLATE seeds `name: ` blank — if the user never touches it, save
// would otherwise ship an empty frontmatter name and the list falls back to
// showing the filename ("SKILL") instead of the item's real name.
function fillBlankFrontmatterName(content: string, name: string): string {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return content;
  const fm = content.slice(0, end);
  return fm.replace(/^name:[ \t]*$/m, `name: ${name}`) + content.slice(end);
}

type Section = 'overview' | 'agents' | 'skills' | 'instructions' | 'hooks' | 'mcp' | 'projects';

const NAV: { key: Section; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'agents', label: 'Agents' },
  { key: 'skills', label: 'Skills' },
  { key: 'instructions', label: 'Instructions' },
  { key: 'hooks', label: 'Hooks' },
  { key: 'mcp', label: 'MCP Servers' },
  { key: 'projects', label: 'Projects' },
];

const OVERVIEW_SECTIONS: { key: Exclude<Section, 'overview' | 'projects'>; label: string; icon: string }[] = [
  { key: 'agents', label: 'Agents', icon: '◈' },
  { key: 'skills', label: 'Skills', icon: '✦' },
  { key: 'instructions', label: 'Instructions', icon: '▤' },
  { key: 'hooks', label: 'Hooks', icon: '⚡' },
  { key: 'mcp', label: 'MCP Servers', icon: '⬡' },
];

// Provider glyphs are decoration-only, never Anthropic/OpenAI marks (hard rule 5).
const PROV_GLYPH: Record<string, string> = { claude: '✳', codex: '⬡' };

function providerGlyphs(items: CustomizationItem[]): string {
  const seen = new Set(items.map((i) => i.provider));
  return [...seen].map((p) => PROV_GLYPH[p] ?? '').join(' ');
}

function itemDesc(section: Section, item: CustomizationItem): string {
  if (section === 'hooks') return `${item.meta.event ?? ''} · ${item.meta.command ?? ''}`;
  if (section === 'mcp') return item.meta.command ?? '';
  return item.meta.description || item.filePath;
}

// JSON-shaped content (hooks/mcp entries) is pretty-printed already by the
// scanner — render as-is; markdown-shaped content (agents/skills/instructions)
// goes through the same escape+marked pipeline as transcript messages.
function isJsonSection(section: Section): boolean {
  return section === 'hooks' || section === 'mcp';
}

export type CustomizationsModalProps = {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  projectName?: string;
  // Projects section stays store-agnostic: page.tsx passes ALL projects
  // (unfiltered — the rail is the one that filters hidden ones out) plus the
  // hidden-id list and a toggle callback that mirrors Rail's handleTogglePin.
  projects?: Project[];
  hidden?: string[];
  onToggleHidden?: (id: string) => void;
};

export default function CustomizationsModal({
  open,
  onClose,
  projectId,
  projectName,
  projects = [],
  hidden = [],
  onToggleHidden,
}: CustomizationsModalProps) {
  const [section, setSection] = useState<Section>('overview');
  const [scope, setScope] = useState<'global' | 'project'>(projectId ? 'project' : 'global');
  const [data, setData] = useState<CustomizationsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [detail, setDetail] = useState<CustomizationItem | null>(null);
  const [detailSection, setDetailSection] = useState<Section>('overview');
  const { dispatch } = useAppState();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [assisting, setAssisting] = useState(false);
  const [making, setMaking] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [undoText, setUndoText] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setData(null);
    setLoadError(null);
    // Project scope shows BOTH levels (project first, then user-global) — each
    // item keeps its own `scope` field, rendered as a project/user chip.
    const load =
      scope === 'project'
        ? Promise.all([getCustomizations('project', projectId), getCustomizations('global')]).then(([p, g]) => ({
            agents: [...p.agents, ...g.agents],
            skills: [...p.skills, ...g.skills],
            instructions: [...p.instructions, ...g.instructions],
            hooks: [...p.hooks, ...g.hooks],
            mcp: [...p.mcp, ...g.mcp],
          }))
        : getCustomizations('global');
    load.then(setData).catch((e) => setLoadError((e as Error).message || 'failed to load'));
  }, [open, scope, projectId, reloadKey]);

  // Reset to Overview + re-scope whenever the modal is (re)opened for a
  // (possibly different) project — stale nav position from a prior open
  // would otherwise persist across re-mounts of the same component instance.
  useEffect(() => {
    if (!open) return;
    setSection('overview');
    setDetail(null);
    setEditing(null);
    setUndoText(null);
    setEditorError(null);
    setScope(projectId ? 'project' : 'global');
  }, [open, projectId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  function openSection(key: Section) {
    setDetail(null);
    setEditing(null);
    setSection(key);
  }

  function openDetail(key: Section, item: CustomizationItem) {
    setDetailSection(key);
    setDetail(item);
    setEditing(null);
  }

  const items: CustomizationItem[] = data && section !== 'overview' && section !== 'projects' ? data[section] : [];
  const project = projects.find((p) => p.id === projectId);
  // Editor only offered when scoped to a project and viewing an editable
  // section (agents/skills). Read-only otherwise (global scope, other sections).
  const editable = Boolean(projectId) && (section === 'agents' || section === 'skills');

  function startNew(key: 'agents' | 'skills') {
    setDetail(null);
    setUndoText(null);
    setEditorError(null);
    setEditing({ section: key, name: '', content: key === 'skills' ? SKILL_TEMPLATE : '', isNew: true });
  }

  function startEdit(key: 'agents' | 'skills', item: CustomizationItem) {
    setUndoText(null);
    setEditorError(null);
    setEditing({ section: key, name: kebabFromItem(key, item), content: item.content, isNew: false });
  }

  async function handleSave() {
    if (!editing || !projectId) return;
    setSaving(true);
    setEditorError(null);
    try {
      await putCustomizationItem({
        projectId,
        provider: 'claude',
        section: editing.section,
        name: editing.name,
        content: fillBlankFrontmatterName(editing.content, editing.name),
      });
      setEditing(null);
      setUndoText(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setEditorError((e as Error).message || 'save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handlePolish(provider: ProviderId) {
    if (!editing || !projectId || assisting) return;
    setAssisting(true);
    setEditorError(null);
    try {
      const { text } = await assistCustomization({
        projectId,
        provider,
        section: editing.section,
        name: editing.name,
        draft: editing.content,
      });
      setUndoText(editing.content);
      setEditing({ ...editing, content: text });
    } catch (e) {
      setEditorError((e as Error).message || 'polish failed');
    } finally {
      setAssisting(false);
    }
  }

  async function handleMakeIt(provider: ProviderId) {
    if (!editing || !project || making) return;
    setMaking(true);
    const file = editing.section === 'skills' ? `.claude/skills/${editing.name}/SKILL.md` : `.claude/agents/${editing.name}.md`;
    const brief =
      `Create ${file} in this repo${editing.content.trim() ? ` for this purpose:\n${editing.content}` : ` named "${editing.name}"`}.\n` +
      `Follow ${editing.section === 'skills' ? 'SKILL.md' : 'Claude Code agent-definition'} conventions (frontmatter with name + description, clear body). Write the file, then stop.`;
    try {
      const { tabMeta } = await startSession({ projectPath: project.path, provider, mode: 'new', firstPrompt: brief });
      dispatch({ type: 'openTerm', ptyId: tabMeta.ptyId, projectId: project.id, label: project.name, provider });
      onClose(); // watch the session work
    } catch (e) {
      setEditorError((e as Error).message || 'session start failed');
    } finally {
      setMaking(false);
    }
  }

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Customizations">
        <div className={styles.header}>
          <h3 className={styles.title}>Customizations</h3>
          <span className={styles.scopeLabel}>{scope === 'project' ? projectName ?? 'Project' : 'Global'}</span>
          <button type="button" className={styles.glyphBtn} aria-label="Close" title="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className={styles.body}>
          <nav className={styles.nav}>
            {NAV.map((n) => (
              <button
                key={n.key}
                type="button"
                className={`${styles.navItem} ${section === n.key ? styles.navItemActive : ''}`}
                onClick={() => openSection(n.key)}
              >
                {n.label}
              </button>
            ))}
          </nav>
          <div className={styles.content}>
            {(() => {
              // Back arrow (detail open) and "+ New" (authorable section) share one
              // header row; either side may be absent.
              const detailOpen = !editing && !!detail && detailSection === section && section !== 'overview' && section !== 'projects';
              const canNew = editable && (section === 'agents' || section === 'skills') && !editing;
              if (!detailOpen && !canNew) return null;
              return (
                <div className={styles.contentHeader}>
                  {detailOpen ? (
                    <button type="button" className={styles.glyphBtn} aria-label="Back" title="Back" onClick={() => setDetail(null)}>
                      ←
                    </button>
                  ) : (
                    <span />
                  )}
                  {canNew ? (
                    <Button variant="primary" onClick={() => startNew(section)}>
                      + New
                    </Button>
                  ) : null}
                </div>
              );
            })()}
            {editing ? (
              <EditorPane
                editing={editing}
                setEditing={setEditing}
                saving={saving}
                assisting={assisting}
                making={making}
                editorError={editorError}
                undoText={undoText}
                onSave={handleSave}
                onCancel={() => {
                  setEditing(null);
                  setUndoText(null);
                  setEditorError(null);
                }}
                onPolish={handlePolish}
                onMakeIt={handleMakeIt}
                onUndo={() => {
                  if (undoText !== null) setEditing({ ...editing, content: undoText });
                  setUndoText(null);
                }}
              />
            ) : section === 'projects' ? (
              <ProjectVisibilityList projects={projects} hidden={hidden} onToggleHidden={(id) => onToggleHidden?.(id)} />
            ) : loadError ? (
              <div className={styles.empty}>
                Failed to load: {loadError} <Button onClick={() => setReloadKey((k) => k + 1)}>Retry</Button>
              </div>
            ) : !data ? (
              <div className={styles.empty}>Loading…</div>
            ) : section === 'overview' ? (
              <div className={styles.overviewGrid}>
                {OVERVIEW_SECTIONS.map((s) => {
                  const list = data[s.key];
                  return (
                    <button key={s.key} type="button" className={styles.card} onClick={() => openSection(s.key)}>
                      <span className={styles.cardIcon}>{s.icon}</span>
                      <span className={styles.cardTitle}>{s.label}</span>
                      <span className={styles.cardCount}>{list.length}</span>
                      <span className={styles.cardGlyphs}>{providerGlyphs(list)}</span>
                    </button>
                  );
                })}
                <button type="button" className={styles.card} onClick={() => openSection('projects')}>
                  <span className={styles.cardIcon}>▦</span>
                  <span className={styles.cardTitle}>Projects</span>
                </button>
              </div>
            ) : detail && detailSection === section ? (
              <div className={styles.detail}>
                <h4 className={styles.detailTitle}>
                  {detail.title}{' '}
                  <span className={detail.scope === 'project' ? styles.scopeProject : styles.scopeUser}>
                    {detail.scope === 'project' ? 'project' : 'user'}
                  </span>
                </h4>
                <div className={styles.detailPath}>{detail.filePath}</div>
                {editable && detail.provider === 'claude' && detail.scope === 'project' && (section === 'agents' || section === 'skills') ? (
                  <Button onClick={() => startEdit(section, detail)}>Edit</Button>
                ) : null}
                {detail.parseError ? <span className={styles.badge}>parse error</span> : null}
                {detail.parseError || isJsonSection(section) ? (
                  <pre className={styles.pre}>{detail.content}</pre>
                ) : (
                  <div
                    className={styles.markdown}
                    // eslint-disable-next-line react/no-danger -- renderMarkdown escapes entities before parsing (see Transcript.tsx)
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.content) }}
                  />
                )}
              </div>
            ) : items.length === 0 ? (
              <div className={styles.empty}>Nothing found in {scope === 'project' ? projectName ?? 'this project' : 'global'} scope.</div>
            ) : (
              <div className={styles.list}>
                {items.map((item) => (
                  <OptionRow
                    key={item.id}
                    icon={PROV_GLYPH[item.provider] ?? '·'}
                    title={item.title}
                    desc={
                      <>
                        <span className={item.scope === 'project' ? styles.scopeProject : styles.scopeUser}>
                          {item.scope === 'project' ? 'project' : 'user'}
                        </span>{' '}
                        {itemDesc(section, item)}
                        {item.parseError ? <span className={styles.badge}>parse error</span> : null}
                      </>
                    }
                    onClick={() => openDetail(section, item)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Dropdown of provider choices for the two AI-assist actions — same
// open/close/Escape/click-outside pattern as BridgeMenu, composing the
// shared ui/Menu surface.
function AssistMenu({
  label,
  disabled,
  onPick,
}: {
  label: string;
  disabled?: boolean;
  onPick: (provider: ProviderId) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    // stopPropagation (not just close) so the modal's own window-level Escape
    // listener never sees this keypress — bubble order runs document-level
    // listeners before window-level ones regardless of registration order,
    // so this is deterministic, not a listener-order race.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (provider: ProviderId) => {
    setOpen(false);
    onPick(provider);
  };

  return (
    <span className={styles.assistMenuWrap} ref={wrapRef}>
      <Button disabled={disabled} onClick={() => setOpen((v) => !v)}>
        {label} <span>{open ? '▴' : '▾'}</span>
      </Button>
      {open ? (
        <div className={`${menu.menu} ${styles.assistMenu}`} role="menu">
          {(Object.keys(PROV) as ProviderId[]).map((p) => (
            <button key={p} type="button" className={menu.item} role="menuitem" onClick={() => pick(p)}>
              {PROV[p].glyph} {p}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

type EditorPaneProps = {
  editing: Editing;
  setEditing: (e: Editing) => void;
  saving: boolean;
  assisting: boolean;
  making: boolean;
  editorError: string | null;
  undoText: string | null;
  onSave: () => void;
  onCancel: () => void;
  onPolish: (provider: ProviderId) => void;
  onMakeIt: (provider: ProviderId) => void;
  onUndo: () => void;
};

function EditorPane({
  editing,
  setEditing,
  saving,
  assisting,
  making,
  editorError,
  undoText,
  onSave,
  onCancel,
  onPolish,
  onMakeIt,
  onUndo,
}: EditorPaneProps) {
  const filePath =
    editing.section === 'skills' ? `.claude/skills/${editing.name || '<name>'}/SKILL.md` : `.claude/agents/${editing.name || '<name>'}.md`;

  return (
    <div className={styles.editor}>
      <TextInput
        value={editing.name}
        onChange={(v) => {
          if (!editing.isNew) return;
          setEditing({ ...editing, name: v.toLowerCase().replace(/[^a-z0-9-]+/g, '-') });
        }}
        placeholder="name"
        disabled={!editing.isNew}
      />
      <div className={styles.editorFilePath}>{filePath}</div>
      <TextInput
        value={editing.content}
        onChange={(v) => setEditing({ ...editing, content: v })}
        placeholder="Write the body…"
        multiline={12}
        className={styles.editorArea}
      />
      {editorError ? <div className={styles.badge}>{editorError}</div> : null}
      <div className={styles.editorActions}>
        <Button variant="primary" disabled={saving || !NAME_RE.test(editing.name)} onClick={onSave}>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
        {undoText !== null ? <Button onClick={onUndo}>Undo polish</Button> : null}
        <AssistMenu label="✦ Polish with" disabled={assisting || !editing.content.trim()} onPick={onPolish} />
        <AssistMenu label="◈ Make it for me" disabled={assisting || making} onPick={onMakeIt} />
      </div>
    </div>
  );
}

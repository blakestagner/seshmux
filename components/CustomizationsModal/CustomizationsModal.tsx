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
import { useDropdown } from '../ui/Menu/useDropdown';
import OptionRow from '../ui/OptionRow/OptionRow';
import TextInput from '../ui/TextInput/TextInput';
import Segmented from '../ui/Segmented/Segmented';
import ProjectVisibilityList from '../ProjectVisibilityList/ProjectVisibilityList';
import {
  getCustomizations,
  putCustomizationItem,
  assistCustomization,
  startSession,
  getMarketplaceSources,
  addMarketplaceSource,
  browseMarketplace,
  getMarketplaceItem,
  installMarketplaceItem,
  getMarketplacePlugins,
  installMarketplacePlugin,
  type CustomizationsPayload,
  type MarketplaceItem,
  type MarketplaceFile,
  type MarketplacePlugin,
  type MarketplaceInfo,
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

// Display/brief-only path preview — NOT the write path. The real target is
// resolved server-side by provider.customizationWriteTarget() (the provider
// seam owns actual paths; see server/lib/providers/customizations.ts).
function targetPathFor(section: 'agents' | 'skills', name: string): string {
  return section === 'skills' ? `.claude/skills/${name}/SKILL.md` : `.claude/agents/${name}.md`;
}

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

type Section = 'overview' | 'agents' | 'skills' | 'instructions' | 'hooks' | 'mcp' | 'marketplace' | 'projects';

const NAV: { key: Section; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'agents', label: 'Agents' },
  { key: 'skills', label: 'Skills' },
  { key: 'instructions', label: 'Instructions' },
  { key: 'hooks', label: 'Hooks' },
  { key: 'mcp', label: 'MCP Servers' },
  { key: 'marketplace', label: 'Marketplace' },
  { key: 'projects', label: 'Projects' },
];

// Mirrors server SOURCE_RE (server/routes/marketplace.ts) — kebab owner/repo.
const MARKETPLACE_SOURCE_RE = /^[\w.-]+\/[\w.-]+$/;

const OVERVIEW_SECTIONS: { key: Exclude<Section, 'overview' | 'projects' | 'marketplace'>; label: string; icon: string }[] = [
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
    // item keeps its own `scope` field, rendered as a project/user chip. The
    // global fetch is best-effort: if it fails, project items still render
    // (empty payload swapped in) rather than blanking the whole view. Only a
    // failure of the PROJECT fetch itself is a real loadError.
    const EMPTY: CustomizationsPayload = { agents: [], skills: [], instructions: [], hooks: [], mcp: [] };
    const load =
      scope === 'project'
        ? Promise.all([
            getCustomizations('project', projectId),
            getCustomizations('global').catch(() => EMPTY),
          ]).then(([p, g]) => ({
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

  const items: CustomizationItem[] =
    data && section !== 'overview' && section !== 'projects' && section !== 'marketplace' ? data[section] : [];
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
    const file = targetPathFor(editing.section, editing.name);
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
          <button type="button" className={`${styles.glyphBtn} ${styles.glyphBtnLg}`} aria-label="Close" title="Close" onClick={onClose}>
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
            ) : section === 'marketplace' ? (
              <MarketplaceSection
                projectId={projectId}
                projectName={projectName}
                onInstalled={() => setReloadKey((k) => k + 1)}
              />
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

// Dropdown of provider choices for the two AI-assist actions — shares
// open/close/Escape/click-outside behavior with BridgeMenu via useDropdown,
// composing the shared ui/Menu surface.
function AssistMenu({
  label,
  disabled,
  onPick,
}: {
  label: string;
  disabled?: boolean;
  onPick: (provider: ProviderId) => void;
}) {
  const { open, setOpen, wrapRef } = useDropdown();

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
  const filePath = targetPathFor(editing.section, editing.name || '<name>');

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
        {editing.isNew ? (
          <AssistMenu label="◈ Make it for me" disabled={assisting || making || !NAME_RE.test(editing.name)} onPick={onMakeIt} />
        ) : null}
      </div>
    </div>
  );
}

// ── Marketplace section (Task 5) ────────────────────────────────────────────
// Two independent sub-tabs sharing one Segmented: community skill/agent browse
// (GitHub source -> browse -> preview -> install) and the `claude plugin`
// marketplace (list -> install per scope). Neither depends on the customizations
// GET that backs the other sections, so this owns its own load/error state.

type MarketplaceTab = 'skills' | 'plugins';

function MarketplaceSection({
  projectId,
  projectName,
  onInstalled,
}: {
  projectId?: string;
  projectName?: string;
  onInstalled: () => void;
}) {
  const { state, dispatch } = useAppState();
  const [tab, setTab] = useState<MarketplaceTab>('skills');

  // Skills & agents browse/install
  const [sources, setSources] = useState<string[]>([]);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [sourcesReloadKey, setSourcesReloadKey] = useState(0);
  const [source, setSource] = useState('');
  const [addingSource, setAddingSource] = useState(false);
  const [addSourceError, setAddSourceError] = useState<string | null>(null);
  const [items, setItems] = useState<MarketplaceItem[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MarketplaceItem | null>(null);
  const [files, setFiles] = useState<MarketplaceFile[] | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installedItem, setInstalledItem] = useState<MarketplaceItem | null>(null);

  useEffect(() => {
    setSourcesError(null);
    getMarketplaceSources()
      .then(({ sources: s }) => {
        setSources(s);
        setSource((prev) => prev || s[0] || '');
      })
      .catch((e) => setSourcesError((e as Error).message || 'failed to load sources'));
    // Sources list loads once per mount, plus whenever Retry bumps sourcesReloadKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesReloadKey]);

  useEffect(() => {
    if (!source) return;
    let stale = false;
    setItems(null);
    setItemsError(null);
    setSelected(null);
    browseMarketplace(source)
      .then((r) => {
        if (!stale) setItems(r.items);
      })
      .catch((e) => {
        if (!stale) setItemsError((e as Error).message || 'failed to load');
      });
    return () => {
      stale = true;
    };
  }, [source]);

  // Guards against a slow preview response from a prior selection landing
  // after the user has already clicked into a different item.
  const openItemPathRef = useRef<string | null>(null);

  function openItem(item: MarketplaceItem) {
    setSelected(item);
    setFiles(null);
    setFileError(null);
    setInstallError(null);
    setInstalledItem(null);
    openItemPathRef.current = item.path;
    getMarketplaceItem(source, item.path)
      .then((r) => {
        if (openItemPathRef.current === item.path) setFiles(r.files);
      })
      .catch((e) => {
        if (openItemPathRef.current === item.path) setFileError((e as Error).message || 'failed to load');
      });
  }

  async function handleAddSource(next: string) {
    setAddingSource(true);
    setAddSourceError(null);
    try {
      const cfg = await addMarketplaceSource(state.config, next);
      dispatch({ type: 'setConfig', config: cfg });
      const { sources: s } = await getMarketplaceSources();
      setSources(s);
      setSource(next);
      setSourcesError(null);
    } catch (e) {
      setAddSourceError((e as Error).message || 'failed to add source');
      throw e;
    } finally {
      setAddingSource(false);
    }
  }

  async function handleInstall() {
    if (!selected || !projectId || installing) return;
    setInstalling(true);
    setInstallError(null);
    try {
      await installMarketplaceItem({
        projectId,
        source,
        path: selected.path,
        section: selected.section,
        name: selected.name,
      });
      setInstalledItem(selected);
      onInstalled();
    } catch (e) {
      setInstallError((e as Error).message || 'install failed');
    } finally {
      setInstalling(false);
    }
  }

  // Plugins (claude plugin marketplace). `supported` is null until a real
  // server response comes back — a transport failure (network/parse error)
  // must not be conflated with the server actually saying unsupported, or
  // the pane shows a permanent "not supported" note for a retry-able error.
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginsResult, setPluginsResult] = useState<{
    supported: boolean;
    plugins: MarketplacePlugin[];
    marketplaces: MarketplaceInfo[];
  } | null>(null);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [pluginsReloadKey, setPluginsReloadKey] = useState(0);
  const [pluginInstalling, setPluginInstalling] = useState<string | null>(null);
  const [pluginInstallError, setPluginInstallError] = useState<string | null>(null);
  // Keyed by the plugin's full id ("name@marketplace") when a row exposes pluginId;
  // bare name only for rows that don't (installed[] entries from the server always
  // carry the full id, so this only matters for our own optimistic inserts below).
  // Value is the set of scopes ('user' | 'project') installed for that key.
  const [installedScopes, setInstalledScopes] = useState<Map<string, Set<string>>>(new Map());
  // Remembers what the last successful plugins fetch was for, so re-entering the
  // Plugins tab reuses the cached result instead of re-spawning the CLI; bumping
  // pluginsReloadKey (Retry) still forces a refetch.
  const pluginsLoadedForRef = useRef<{ projectId?: string; reloadKey: number } | null>(null);

  useEffect(() => {
    if (tab !== 'plugins') return;
    // pluginsLoadedForRef is only set after a successful fetch (below), so a
    // match here implies pluginsResult is already populated for this projectId.
    const loadedFor = pluginsLoadedForRef.current;
    if (loadedFor && loadedFor.projectId === projectId && loadedFor.reloadKey === pluginsReloadKey) {
      return; // cached — skip the CLI respawn
    }
    let stale = false;
    setPluginsLoading(true);
    setPluginsError(null);
    getMarketplacePlugins(projectId)
      .then((r) => {
        if (stale) return;
        pluginsLoadedForRef.current = { projectId, reloadKey: pluginsReloadKey };
        setPluginsResult({ supported: r.supported, plugins: r.plugins ?? [], marketplaces: r.marketplaces ?? [] });
        const next = new Map<string, Set<string>>();
        for (const entry of r.installed ?? []) {
          if (typeof entry.id !== 'string' || typeof entry.scope !== 'string') continue;
          const set = next.get(entry.id) ?? new Set<string>();
          set.add(entry.scope);
          next.set(entry.id, set);
        }
        setInstalledScopes(next);
      })
      .catch((e) => {
        if (stale) return;
        setPluginsError((e as Error).message || 'failed to load');
      })
      .finally(() => {
        if (!stale) setPluginsLoading(false);
      });
    return () => {
      stale = true;
    };
    // pluginsResult intentionally excluded: it's written by this same effect and
    // pluginsLoadedForRef already gates re-fetching, so including it would just
    // cause a harmless extra re-check on every load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, projectId, pluginsReloadKey]);

  // pluginKey is the id used both for the CLI call (`plugin@marketplace` syntax)
  // and for tracking installed-state, so the two always stay in sync — see
  // PluginRow below, which passes p.pluginId ?? p.name as this same key.
  async function handleInstallPlugin(pluginKey: string, scope: 'user' | 'project') {
    if (!projectId || pluginInstalling) return;
    setPluginInstalling(pluginKey);
    setPluginInstallError(null);
    try {
      await installMarketplacePlugin({ projectId, plugin: pluginKey, scope });
      setInstalledScopes((prev) => {
        const next = new Map(prev);
        const set = new Set(next.get(pluginKey) ?? []);
        set.add(scope);
        next.set(pluginKey, set);
        return next;
      });
    } catch (e) {
      setPluginInstallError((e as Error).message || 'install failed');
    } finally {
      setPluginInstalling(null);
    }
  }

  return (
    <div className={styles.marketplace}>
      <Segmented
        options={[
          { id: 'skills', label: 'Skills & Agents' },
          { id: 'plugins', label: 'Plugins' },
        ]}
        value={tab}
        onChange={(id) => setTab(id as MarketplaceTab)}
      />
      {tab === 'skills' ? (
        selected ? (
          <div className={styles.detail}>
            <div className={styles.contentHeader}>
              <button type="button" className={styles.glyphBtn} aria-label="Back" title="Back" onClick={() => setSelected(null)}>
                ←
              </button>
              <span />
            </div>
            <h4 className={styles.detailTitle}>
              {selected.section === 'skills' ? '✦' : '◈'} {selected.name}
            </h4>
            <div className={styles.detailPath}>
              {source} · {selected.path}
            </div>
            {fileError ? (
              <div className={styles.empty}>Failed to load: {fileError}</div>
            ) : !files ? (
              <div className={styles.empty}>Loading…</div>
            ) : (
              <>
                <div className={styles.mpFileList}>
                  {files.map((f) => (
                    <div key={f.path} className={styles.mpFileName}>
                      {f.path}
                    </div>
                  ))}
                </div>
                <pre className={styles.pre}>{files[0]?.content ?? ''}</pre>
              </>
            )}
            {installError ? <div className={styles.badge}>{installError}</div> : null}
            {installedItem === selected ? (
              <div className={styles.empty}>Installed — source: {source}</div>
            ) : null}
            {projectId ? (
              <Button variant="primary" disabled={installing || !files} onClick={handleInstall}>
                {installing ? 'Installing…' : `Install to ${projectName ?? 'project'}`}
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            <div className={styles.mpSourceRow}>
              <SourceMenu
                sources={sources}
                value={source}
                onPick={setSource}
                onAdd={handleAddSource}
                adding={addingSource}
                addError={addSourceError}
              />
            </div>
            {sourcesError ? (
              <div className={styles.empty}>
                Failed to load sources: {sourcesError} <Button onClick={() => setSourcesReloadKey((k) => k + 1)}>Retry</Button>
              </div>
            ) : itemsError ? (
              <div className={styles.empty}>Failed to load: {itemsError}</div>
            ) : !items ? (
              <div className={styles.empty}>Loading…</div>
            ) : items.length === 0 ? (
              <div className={styles.empty}>Nothing found in {source}.</div>
            ) : (
              <div className={styles.list}>
                {items.map((item) => (
                  <OptionRow
                    key={item.path}
                    icon={item.section === 'skills' ? '✦' : '◈'}
                    title={item.name}
                    desc={
                      <>
                        {item.description || item.path} <span className={styles.scopeUser}>{source}</span>
                      </>
                    }
                    onClick={() => openItem(item)}
                  />
                ))}
              </div>
            )}
          </>
        )
      ) : (
        <PluginsPane
          loading={pluginsLoading}
          supported={pluginsResult?.supported ?? null}
          plugins={pluginsResult?.plugins ?? []}
          marketplaces={pluginsResult?.marketplaces ?? []}
          error={pluginsError}
          installing={pluginInstalling}
          installError={pluginInstallError}
          installedScopes={installedScopes}
          projectId={projectId}
          onInstall={handleInstallPlugin}
          onRetry={() => setPluginsReloadKey((k) => k + 1)}
        />
      )}
    </div>
  );
}

// Source picker: dropdown of known sources + inline "Add source…" form that
// kebab-validates `owner/repo` before enabling Add (mirrors AssistMenu's
// useDropdown + Menu.module.scss composition).
// ponytail: 4th useDropdown+ui/Menu hand-assembly; extract a LabeledDropdown primitive when the next consumer appears
function SourceMenu({
  sources,
  value,
  onPick,
  onAdd,
  adding,
  addError,
}: {
  sources: string[];
  value: string;
  onPick: (source: string) => void;
  onAdd: (source: string) => Promise<void>;
  adding: boolean;
  addError: string | null;
}) {
  const { open, setOpen, wrapRef } = useDropdown();
  const [showAdd, setShowAdd] = useState(false);
  const [text, setText] = useState('');
  const valid = MARKETPLACE_SOURCE_RE.test(text);

  function submit() {
    if (!valid || adding) return;
    onAdd(text)
      .then(() => {
        setText('');
        setShowAdd(false);
      })
      .catch(() => {});
  }

  return (
    <span className={styles.assistMenuWrap} ref={wrapRef}>
      <Button onClick={() => setOpen((v) => !v)}>
        {value || 'Loading…'} <span>{open ? '▴' : '▾'}</span>
      </Button>
      {open ? (
        <div className={`${menu.menu} ${styles.sourceMenu}`} role="menu">
          {sources.map((s) => (
            <button
              key={s}
              type="button"
              className={menu.item}
              role="menuitem"
              onClick={() => {
                onPick(s);
                setOpen(false);
              }}
            >
              {s}
            </button>
          ))}
          <div className={menu.sep} />
          {showAdd ? (
            <div className={styles.addSourceRow}>
              <TextInput value={text} onChange={setText} placeholder="owner/repo" />
              <Button variant="primary" disabled={!valid || adding} onClick={submit}>
                Add
              </Button>
            </div>
          ) : (
            <button type="button" className={menu.item} role="menuitem" onClick={() => setShowAdd(true)}>
              + Add source…
            </button>
          )}
          {addError ? <div className={styles.badge}>{addError}</div> : null}
        </div>
      ) : null}
    </span>
  );
}

function PluginsPane({
  loading,
  supported,
  error,
  plugins,
  marketplaces,
  installing,
  installError,
  installedScopes,
  projectId,
  onInstall,
  onRetry,
}: {
  loading: boolean;
  supported: boolean | null;
  error: string | null;
  plugins: MarketplacePlugin[];
  marketplaces: MarketplaceInfo[];
  installing: string | null;
  installError: string | null;
  installedScopes: Map<string, Set<string>>;
  projectId?: string;
  onInstall: (pluginKey: string, scope: 'user' | 'project') => void;
  onRetry: () => void;
}) {
  if (loading) return <div className={styles.empty}>Loading…</div>;
  // A fetch/transport failure (supported still null) is retry-able and
  // distinct from the server telling us this claude version really doesn't
  // support the plugin marketplace (supported === false).
  if (error && supported === null) {
    return (
      <div className={styles.empty}>
        Failed to load: {error} <Button onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  if (supported === false) return <div className={styles.mpNote}>claude plugin marketplace not supported by this claude version</div>;

  return (
    <div className={styles.list}>
      {marketplaces.length > 0 ? (
        <div className={styles.mpMarketplaces}>
          {marketplaces.map((m, i) => (
            <span key={String(m.name ?? i)} className={styles.scopeUser}>
              {String(m.name ?? 'marketplace')}
            </span>
          ))}
        </div>
      ) : null}
      {installError ? <div className={styles.badge}>{installError}</div> : null}
      {plugins.length === 0 ? (
        <div className={styles.empty}>No plugins available.</div>
      ) : (
        plugins.map((p) => {
          // Match by full pluginId when the row has one; bare-name fallback only
          // for rows without a pluginId (see handleInstallPlugin's optimistic insert).
          const key = p.pluginId ?? p.name;
          return (
            <PluginRow
              key={key}
              plugin={p}
              installedScopes={installedScopes.get(key) ?? EMPTY_SCOPE_SET}
              busy={installing === key}
              projectId={projectId}
              onInstall={(scope) => onInstall(key, scope)}
            />
          );
        })
      )}
    </div>
  );
}

const EMPTY_SCOPE_SET: Set<string> = new Set();

// Install scope defaults to 'user'; a project-scoped modal offers a small
// useDropdown menu to pick 'user' vs 'project' instead. The menu stays enabled
// even when the plugin is installed somewhere — only the scope(s) already
// installed get disabled, since installing "user" doesn't cover "project" or
// vice versa.
function PluginRow({
  plugin,
  installedScopes,
  busy,
  projectId,
  onInstall,
}: {
  plugin: MarketplacePlugin;
  installedScopes: Set<string>;
  busy: boolean;
  projectId?: string;
  onInstall: (scope: 'user' | 'project') => void;
}) {
  const { open, setOpen, wrapRef } = useDropdown();
  const allScopesInstalled = installedScopes.has('user') && installedScopes.has('project');

  return (
    <div className={styles.mpPluginRow}>
      <OptionRow
        icon="⬡"
        title={plugin.name}
        desc={
          <>
            {typeof plugin.description === 'string' ? plugin.description : ''}
            {installedScopes.size > 0 ? (
              <span className={styles.scopeProject}>✓ installed ({[...installedScopes].join(', ')})</span>
            ) : null}
          </>
        }
      />
      {projectId ? (
        <span className={styles.assistMenuWrap} ref={wrapRef}>
          <Button disabled={busy || allScopesInstalled} onClick={() => setOpen((v) => !v)}>
            {busy ? 'Installing…' : allScopesInstalled ? 'Installed' : 'Install'}{' '}
            {!allScopesInstalled ? <span>{open ? '▴' : '▾'}</span> : null}
          </Button>
          {open ? (
            <div className={`${menu.menu} ${styles.mpScopeMenu}`} role="menu">
              <button
                type="button"
                className={menu.item}
                role="menuitem"
                disabled={installedScopes.has('user')}
                onClick={() => {
                  setOpen(false);
                  onInstall('user');
                }}
              >
                user{installedScopes.has('user') ? ' ✓' : ''}
              </button>
              <button
                type="button"
                className={menu.item}
                role="menuitem"
                disabled={installedScopes.has('project')}
                onClick={() => {
                  setOpen(false);
                  onInstall('project');
                }}
              >
                project{installedScopes.has('project') ? ' ✓' : ''}
              </button>
            </div>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

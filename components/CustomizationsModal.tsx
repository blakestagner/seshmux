'use client';
// Read-only Copilot-style customizations browser (Task 6). Left nav + right
// content: Overview cards, then per-concept list/detail (agents, skills,
// instructions, hooks, MCP servers), plus a Projects section (Task 7 fills
// in the body — this task ships the nav entry + placeholder only). Scope
// (global vs one project) drives which GET /api/customizations call fires;
// pre-scoped when opened from a project row via projectId/projectName.

import { useEffect, useState } from 'react';
import styles from './CustomizationsModal.module.scss';
import OptionRow from './ui/OptionRow';
import IconButton from './ui/IconButton';
import ProjectVisibilityList from './ProjectVisibilityList';
import { getCustomizations, type CustomizationsPayload } from '../lib/client/api';
import { renderMarkdown } from './Transcript';
import type { CustomizationItem, Project } from '../lib/client/types';

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
  const [detail, setDetail] = useState<CustomizationItem | null>(null);
  const [detailSection, setDetailSection] = useState<Section>('overview');

  useEffect(() => {
    if (!open) return;
    setData(null);
    getCustomizations(scope, projectId).then(setData).catch(() => setData(null));
  }, [open, scope, projectId]);

  // Reset to Overview + re-scope whenever the modal is (re)opened for a
  // (possibly different) project — stale nav position from a prior open
  // would otherwise persist across re-mounts of the same component instance.
  useEffect(() => {
    if (!open) return;
    setSection('overview');
    setDetail(null);
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
    setSection(key);
  }

  function openDetail(key: Section, item: CustomizationItem) {
    setDetailSection(key);
    setDetail(item);
  }

  const items: CustomizationItem[] = data && section !== 'overview' && section !== 'projects' ? data[section] : [];

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Customizations">
        <div className={styles.header}>
          <h3 className={styles.title}>Customizations</h3>
          <span className={styles.scopeLabel}>{scope === 'project' ? projectName ?? 'Project' : 'Global'}</span>
          <IconButton label="Close" onClick={onClose}>
            ×
          </IconButton>
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
            {section === 'projects' ? (
              <ProjectVisibilityList projects={projects} hidden={hidden} onToggleHidden={(id) => onToggleHidden?.(id)} />
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
                <IconButton label="Back" onClick={() => setDetail(null)}>
                  ←
                </IconButton>
                <h4 className={styles.detailTitle}>{detail.title}</h4>
                <div className={styles.detailPath}>{detail.filePath}</div>
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

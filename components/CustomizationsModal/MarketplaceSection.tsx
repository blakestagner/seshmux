'use client';
// Marketplace UI split out of CustomizationsModal.tsx (was ~55% of that file).
// Two independent sub-tabs sharing one Segmented: community skill/agent browse
// (GitHub source -> browse -> preview -> install) and the `claude plugin`
// marketplace (list -> install per scope). Neither depends on the customizations
// GET that backs the rest of the modal, so this owns its own load/error state.
// Pure mechanical move — no behavior change; see git history for prior home.

import { useEffect, useRef, useState } from 'react';
import styles from './CustomizationsModal.module.scss';
import menu from '../ui/Menu/Menu.module.scss';
import LabeledDropdown, { MenuItem } from '../ui/LabeledDropdown/LabeledDropdown';
import OptionRow from '../ui/OptionRow/OptionRow';
import TextInput from '../ui/TextInput/TextInput';
import Segmented from '../ui/Segmented/Segmented';
import {
  getMarketplaceSources,
  addMarketplaceSource,
  browseMarketplace,
  getMarketplaceItem,
  installMarketplaceItem,
  runSafetyCheck,
  getMarketplacePlugins,
  installMarketplacePlugin,
  uninstallMarketplacePlugin,
  type MarketplaceItem,
  type MarketplaceFile,
  type MarketplacePlugin,
  type MarketplaceInfo,
  type MarketplaceWarning,
  type MarketplaceSource,
} from '../../lib/client/api';
import Button from '../ui/Button/Button';
import { PROV } from '../ui/ProviderBadge/ProviderBadge';
import { useAppState } from '../../lib/client/store';
import type { Project, ProviderId } from '../../lib/client/types';

type SafetyResult = { verdict: 'ok' | 'caution' | 'danger'; concerns: string[]; cached: boolean };

// Mirrors server SOURCE_RE (server/routes/marketplace.ts) — kebab owner/repo.
const MARKETPLACE_SOURCE_RE = /^[\w.-]+\/[\w.-]+$/;

// Stable sort: installed items float to the top, incoming order preserved
// within each group. Skills/agents keep repo-tree order; plugins keep CLI
// order — previously re-alphabetized as a tie-break here, changed to preserve
// order instead so both lists follow the same rule.
function installedFirst<T>(list: T[], isInstalled: (item: T) => boolean): T[] {
  return [...list].sort((a, b) => Number(isInstalled(b)) - Number(isInstalled(a)));
}

// Shared install/uninstall plumbing for plugin scopes: busy-guard, error
// handling, and the Map<string, Set<string>> add/remove-and-prune dance.
// `mutate` decides add vs delete for the given scope; the map entry is
// dropped entirely once its scope set empties.
async function mutatePluginScopes(
  pluginKey: string,
  apiCall: () => Promise<unknown>,
  mutate: (set: Set<string>) => void,
  ctx: {
    busyKey: string | null;
    setBusyKey: (k: string | null) => void;
    setError: (e: string | null) => void;
    setInstalledScopes: (fn: (prev: Map<string, Set<string>>) => Map<string, Set<string>>) => void;
    fallbackError: string;
  },
) {
  if (ctx.busyKey) return;
  ctx.setBusyKey(pluginKey);
  ctx.setError(null);
  try {
    await apiCall();
    ctx.setInstalledScopes((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(pluginKey) ?? []);
      mutate(set);
      if (set.size === 0) next.delete(pluginKey);
      else next.set(pluginKey, set);
      return next;
    });
  } catch (e) {
    ctx.setError((e as Error).message || ctx.fallbackError);
  } finally {
    ctx.setBusyKey(null);
  }
}

type MarketplaceTab = 'skills' | 'plugins';

export default function MarketplaceSection({
  projectId,
  projectName,
  installedNames,
  onInstalled,
}: {
  projectId?: string;
  projectName?: string;
  installedNames: Set<string>;
  onInstalled: () => void;
}) {
  const { state, dispatch } = useAppState();
  const [tab, setTab] = useState<MarketplaceTab>('skills');

  // Skills & agents browse/install
  const [sources, setSources] = useState<MarketplaceSource[]>([]);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [sourcesReloadKey, setSourcesReloadKey] = useState(0);
  const [source, setSource] = useState('');
  const [addingSource, setAddingSource] = useState(false);
  const [addSourceError, setAddSourceError] = useState<string | null>(null);
  const [items, setItems] = useState<MarketplaceItem[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  // sha pins browse -> preview -> install to the exact commit browse resolved
  // (Task 1). curated mirrors the browsed source's flag from the same response.
  const [sha, setSha] = useState<string | null>(null);
  const [curated, setCurated] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<MarketplaceItem | null>(null);
  const [files, setFiles] = useState<MarketplaceFile[] | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<MarketplaceWarning[]>([]);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  // First Install click on an item with warnings arms this instead of installing
  // (Step 5) — reset whenever the previewed item changes (openItem).
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [installedItem, setInstalledItem] = useState<MarketplaceItem | null>(null);
  const [installedTo, setInstalledTo] = useState<string>('');
  // Opt-in Layer 3 AI safety check (Task 6) — strictly click-triggered, never
  // auto-run on openItem (costs provider tokens). Reset alongside warnings
  // whenever the previewed item changes.
  const [safetyChecking, setSafetyChecking] = useState(false);
  const [safetyResult, setSafetyResult] = useState<SafetyResult | null>(null);
  const [safetyError, setSafetyError] = useState<string | null>(null);
  // Install targets: user level plus every ENABLED (non-hidden, non-missing)
  // project — the Projects section's visibility toggles double as the opt-in.
  const enabledProjects = state.projects.filter((p) => !state.config.hidden.includes(p.id) && !p.missing);

  useEffect(() => {
    setSourcesError(null);
    getMarketplaceSources()
      .then(({ sources: s }) => {
        setSources(s);
        setSource((prev) => prev || s[0]?.source || '');
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
    setSha(null);
    browseMarketplace(source)
      .then((r) => {
        if (stale) return;
        setItems(r.items);
        setSha(r.sha);
        setCurated(r.curated);
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
    if (!sha) return;
    setSelected(item);
    setFiles(null);
    setFileError(null);
    setWarnings([]);
    setInstallError(null);
    setInstalledItem(null);
    setInstalledTo('');
    setConfirmInstall(false);
    setSafetyResult(null);
    setSafetyError(null);
    openItemPathRef.current = item.path;
    getMarketplaceItem(source, item.path, sha)
      .then((r) => {
        if (openItemPathRef.current !== item.path) return;
        setFiles(r.files);
        setWarnings(r.warnings);
      })
      .catch((e) => {
        if (openItemPathRef.current !== item.path) return;
        const err = e as Error;
        // Same stale-sha 502 as install (source moved since browse) — see handleInstall.
        setFileError(err.message === 'fetch failed' ? 'Source changed since browsing — go back and re-open it.' : err.message || 'failed to load');
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

  async function handleInstall(target: 'user' | { id: string; name: string }) {
    if (!selected || installing || !sha) return;
    // Step 5: an item with warnings needs a second confirming click before the
    // real install fires — first click only arms confirmInstall (see the
    // Install button's label in InstallMenu below).
    if (warnings.length > 0 && !confirmInstall) {
      setConfirmInstall(true);
      return;
    }
    setInstalling(true);
    setInstallError(null);
    try {
      await installMarketplaceItem({
        projectId: target === 'user' ? undefined : target.id,
        source,
        path: selected.path,
        section: selected.section,
        name: selected.name,
        target: target === 'user' ? 'user' : 'project',
        sha,
      });
      setInstalledItem(selected);
      setInstalledTo(target === 'user' ? 'user' : target.name);
      onInstalled();
    } catch (e) {
      const err = e as Error;
      // Server sends exactly 'fetch failed' on a 502 from install's re-fetch —
      // that means the source moved since browse (sha went stale). Point the
      // user back at re-browsing rather than a generic retry.
      const stale = err.message === 'fetch failed';
      setInstallError(stale ? 'Source changed since preview — re-open it to install the latest version.' : err.message || 'install failed');
    } finally {
      setInstalling(false);
    }
  }

  // Opt-in Layer 3 AI review of the previewed item (Task 4's /safety-check).
  // Needs a project in scope — the route resolves a repo cwd to run the
  // provider CLI against — so the button is disabled/hidden without one (see
  // the global-modal disabled title below). Click-triggered only.
  async function handleSafetyCheck(provider: ProviderId) {
    if (!selected || !sha || !projectId || safetyChecking) return;
    setSafetyChecking(true);
    setSafetyError(null);
    try {
      const result = await runSafetyCheck({ source, sha, path: selected.path, provider, projectId });
      setSafetyResult(result);
    } catch (e) {
      setSafetyError((e as Error).message || 'safety check failed');
    } finally {
      setSafetyChecking(false);
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
  // Tracks the plugin key currently mid-flight for EITHER install or uninstall
  // (only one op per key at a time) — renamed from pluginInstalling since it now
  // gates both operations; PluginRow's 'busy' label covers both.
  const [pluginBusyKey, setPluginBusyKey] = useState<string | null>(null);
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
    // user-scope installs are project-independent (global modal); project scope
    // requires one (the PluginRow menu hides it otherwise).
    if (scope === 'project' && !projectId) return;
    await mutatePluginScopes(
      pluginKey,
      () => installMarketplacePlugin({ projectId, plugin: pluginKey, scope }),
      (set) => set.add(scope),
      {
        busyKey: pluginBusyKey,
        setBusyKey: setPluginBusyKey,
        setError: setPluginInstallError,
        setInstalledScopes,
        fallbackError: 'install failed',
      },
    );
  }

  // Same guards as handleInstallPlugin (user scope allowed without projectId,
  // project needs it); on success remove the scope from installedScopes,
  // deleting the map entry entirely once its scope set empties.
  async function handleUninstallPlugin(pluginKey: string, scope: 'user' | 'project') {
    if (scope === 'project' && !projectId) return;
    await mutatePluginScopes(
      pluginKey,
      () => uninstallMarketplacePlugin({ projectId, plugin: pluginKey, scope }),
      (set) => set.delete(scope),
      {
        busyKey: pluginBusyKey,
        setBusyKey: setPluginBusyKey,
        setError: setPluginInstallError,
        setInstalledScopes,
        fallbackError: 'uninstall failed',
      },
    );
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
              {selected.section === 'skills' ? '✦' : '◈'} {selected.name} <SourceBadge curated={curated} />
            </h4>
            <div className={styles.detailPath}>
              {source} · {selected.path}
            </div>
            {warnings.length > 0 ? (
              <div className={styles.mpWarnings}>
                {warnings.map((w, i) => (
                  <div key={`${w.path}:${w.line}:${i}`} className={styles.mpWarningRow}>
                    <span className={styles.mpWarningRule}>{w.rule}</span>
                    <span className={styles.mpWarningLoc}>{w.path}:{w.line}</span>
                    <span className={styles.mpWarningExcerpt}>{w.excerpt}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className={styles.mpSafetyRow}>
              <SafetyCheckMenu
                label={safetyChecking ? 'Checking…' : 'Safety check with'}
                disabled={safetyChecking || !files}
                projectId={projectId}
                onPick={handleSafetyCheck}
              />
              {safetyResult ? (
                <>
                  <span className={styles[`mpVerdict${safetyResult.verdict[0].toUpperCase()}${safetyResult.verdict.slice(1)}`]}>
                    {safetyResult.verdict}
                  </span>
                  {safetyResult.cached ? <span className={styles.mpSafetyCached}>cached</span> : null}
                </>
              ) : null}
            </div>
            {safetyError ? <div className={styles.badge}>{safetyError}</div> : null}
            {safetyResult && safetyResult.concerns.length > 0 ? (
              <ul className={styles.mpSafetyConcerns}>
                {safetyResult.concerns.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            ) : null}
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
                {/* Preview the item's own markdown (SKILL.md / the agent file),
                    not the alphabetically-first file — that's usually a huge
                    LICENSE.txt that buries the Install button. */}
                <pre className={`${styles.pre} ${styles.mpPreview}`}>
                  {(files.find((f) => f.path.endsWith('SKILL.md')) ?? files.find((f) => f.path.endsWith('.md')) ?? files[0])
                    ?.content ?? ''}
                </pre>
              </>
            )}
            {installError ? <div className={styles.badge}>{installError}</div> : null}
            {installedItem === selected ? (
              <div className={styles.empty}>Installed to {installedTo || 'user'} — source: {source}</div>
            ) : null}
            <InstallMenu
              currentProjectId={projectId}
              projects={enabledProjects}
              installing={installing}
              disabled={!files}
              label={confirmInstall && warnings.length > 0 ? `Install anyway (${warnings.length} warnings)` : 'Install to'}
              onInstall={handleInstall}
            />
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
              <span className={styles.mpSearch}>
                <TextInput value={query} onChange={setQuery} placeholder="Search skills & agents…" />
              </span>
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
            ) : (() => {
              const q = query.trim().toLowerCase();
              const filtered = q
                ? items.filter((i) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
                : items;
              if (filtered.length === 0) return <div className={styles.empty}>No matches for “{query}”.</div>;
              // Installed rows first, incoming (repo-tree) order preserved within
              // each group — mirrors the Plugins tab so installed items aren't
              // scroll-only-findable.
              const shown = installedFirst(filtered, (i) => installedNames.has(i.name));
              return (
              <>
              <div className={styles.mpCount}>
                {q ? `${shown.length} of ${items.length}` : `${items.length} available`}
              </div>
              <div className={styles.list}>
                {shown.map((item) => (
                  <OptionRow
                    key={item.path}
                    icon={item.section === 'skills' ? '✦' : '◈'}
                    title={
                      installedNames.has(item.name) ? (
                        <span className={styles.mpPluginTitle}>
                          {item.name}
                          <span className={styles.scopeProject}>✓ installed</span>
                        </span>
                      ) : (
                        item.name
                      )
                    }
                    desc={
                      <>
                        {item.description || item.path} <span className={styles.scopeUser}>{source}</span>
                      </>
                    }
                    onClick={() => openItem(item)}
                  />
                ))}
              </div>
              </>
              );
            })()}
          </>
        )
      ) : (
        <PluginsPane
          loading={pluginsLoading}
          supported={pluginsResult?.supported ?? null}
          plugins={pluginsResult?.plugins ?? []}
          marketplaces={pluginsResult?.marketplaces ?? []}
          error={pluginsError}
          busyKey={pluginBusyKey}
          installError={pluginInstallError}
          installedScopes={installedScopes}
          projectId={projectId}
          onInstall={handleInstallPlugin}
          onUninstall={handleUninstallPlugin}
          onRetry={() => setPluginsReloadKey((k) => k + 1)}
        />
      )}
    </div>
  );
}

// curated -> live/positive chip labeled "curated" (the two DEFAULT_SOURCES);
// user-added -> dim "unverified" chip. Reuses the scopeProject/scopeUser border
// chip pattern already in this module's scss rather than a new ui/ primitive.
function SourceBadge({ curated }: { curated: boolean }) {
  return (
    <span className={curated ? styles.mpBadgeCurated : styles.mpBadgeUnverified}>
      {curated ? 'curated' : 'unverified'}
    </span>
  );
}

// Source picker: dropdown of known sources + inline "Add source…" form that
// kebab-validates `owner/repo` before enabling Add.
function SourceMenu({
  sources,
  value,
  onPick,
  onAdd,
  adding,
  addError,
}: {
  sources: MarketplaceSource[];
  value: string;
  onPick: (source: string) => void;
  onAdd: (source: string) => Promise<void>;
  adding: boolean;
  addError: string | null;
}) {
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
    <LabeledDropdown label={value || 'Loading…'} menuClassName={styles.sourceMenu}>
      {(close) => (
        <>
          {sources.map((s) => (
            <MenuItem
              key={s.source}
              onClick={() => {
                onPick(s.source);
                close();
              }}
            >
              {s.source} <SourceBadge curated={s.curated} />
            </MenuItem>
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
            <MenuItem onClick={() => setShowAdd(true)}>+ Add source…</MenuItem>
          )}
          {addError ? <div className={styles.badge}>{addError}</div> : null}
        </>
      )}
    </LabeledDropdown>
  );
}

// Provider picker for the opt-in safety check — same LabeledDropdown +
// PROV pattern as CustomizationsModal's AssistMenu ("Polish with"). The route
// needs a repo cwd to run the provider CLI against, so without a projectId
// (global modal) the trigger is a disabled Button with a title explaining why,
// matching how PluginRow disables project-scope actions in the global modal.
function SafetyCheckMenu({
  label,
  disabled,
  projectId,
  onPick,
}: {
  label: string;
  disabled?: boolean;
  projectId?: string;
  onPick: (provider: ProviderId) => void;
}) {
  if (!projectId) {
    return (
      <span title="Safety check needs an open project — open this item from a project's Customizations panel.">
        <Button disabled>Safety check with</Button>
      </span>
    );
  }
  return (
    <LabeledDropdown label={label} disabled={disabled} menuClassName={styles.mpSafetyMenu}>
      {(close) => (
        <>
          {(Object.keys(PROV) as ProviderId[]).map((p) => (
            <MenuItem
              key={p}
              onClick={() => {
                close();
                onPick(p);
              }}
            >
              {PROV[p].glyph} {p}
            </MenuItem>
          ))}
        </>
      )}
    </LabeledDropdown>
  );
}

// Install button for a selected skill/agent preview. With a projectId, "Install"
// is a primary action plus a dropdown menu of install targets: user level
// first, then every ENABLED project (the modal's current project pinned to the
// top of that list). Same menu in project and global scope — only the pin
// differs.
function InstallMenu({
  currentProjectId,
  projects,
  installing,
  disabled,
  label = 'Install to',
  onInstall,
}: {
  currentProjectId?: string;
  projects: Project[];
  installing: boolean;
  disabled: boolean;
  label?: string;
  onInstall: (target: 'user' | { id: string; name: string }) => void;
}) {
  const current = projects.find((p) => p.id === currentProjectId);
  const others = projects.filter((p) => p.id !== currentProjectId);
  const ordered = current ? [current, ...others] : others;

  return (
    <LabeledDropdown
      variant="primary"
      // Never disabled by warnings (Step 5) — only by installing/no-files-yet.
      disabled={installing || disabled}
      label={installing ? 'Installing…' : label}
      menuClassName={`${styles.mpScopeMenu} ${styles.mpInstallMenu}`}
    >
      {(close) => {
        const pick = (target: 'user' | { id: string; name: string }) => {
          close();
          onInstall(target);
        };
        return (
          <>
            <MenuItem onClick={() => pick('user')}>user (all projects)</MenuItem>
            {ordered.map((p) => (
              <MenuItem key={p.id} onClick={() => pick({ id: p.id, name: p.name })}>
                {p.name}
                {p.id === currentProjectId ? ' · current' : ''}
              </MenuItem>
            ))}
          </>
        );
      }}
    </LabeledDropdown>
  );
}

function PluginsPane({
  loading,
  supported,
  error,
  plugins,
  marketplaces,
  busyKey,
  installError,
  installedScopes,
  projectId,
  onInstall,
  onUninstall,
  onRetry,
}: {
  loading: boolean;
  supported: boolean | null;
  error: string | null;
  plugins: MarketplacePlugin[];
  marketplaces: MarketplaceInfo[];
  busyKey: string | null;
  installError: string | null;
  installedScopes: Map<string, Set<string>>;
  projectId?: string;
  onInstall: (pluginKey: string, scope: 'user' | 'project') => void;
  onUninstall: (pluginKey: string, scope: 'user' | 'project') => void;
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
          {/* These come straight from `plugin marketplace list` — the user's own
              configured marketplaces, so third-party names (e.g. ponytail) are
              expected. Label them so the chips aren't mystery data. */}
          <span className={styles.mpMarketplacesLabel}>Your marketplaces:</span>
          {marketplaces.map((m, i) => (
            <span key={String(m.name ?? i)} className={styles.scopeUser}>
              {String(m.name ?? 'marketplace')}
            </span>
          ))}
          <span className={styles.mpMarketplacesLabel}>
            {plugins.length} available · {installedScopes.size} installed
          </span>
        </div>
      ) : null}
      {installError ? <div className={styles.badge}>{installError}</div> : null}
      {plugins.length === 0 ? (
        <div className={styles.empty}>No plugins available.</div>
      ) : (
        // Installed plugins float to the top, incoming (CLI) order preserved
        // within each group — was previously alphabetized as a tie-break here;
        // changed so both marketplace lists follow the same installedFirst rule.
        installedFirst(plugins, (p) => installedScopes.has(p.pluginId ?? p.name)).map((p) => {
          // Match by full pluginId when the row has one; bare-name fallback only
          // for rows without a pluginId (see handleInstallPlugin's optimistic insert).
          const key = p.pluginId ?? p.name;
          return (
            <PluginRow
              key={key}
              plugin={p}
              installedScopes={installedScopes.get(key) ?? EMPTY_SCOPE_SET}
              busy={busyKey === key}
              projectId={projectId}
              onInstall={(scope) => onInstall(key, scope)}
              onUninstall={(scope) => onUninstall(key, scope)}
            />
          );
        })
      )}
    </div>
  );
}

const EMPTY_SCOPE_SET: Set<string> = new Set();

// Install scope defaults to 'user'; a project-scoped modal offers a small
// dropdown menu to pick 'user' vs 'project' instead. An installed scope's
// menu item is no longer disabled — it becomes an uninstall action for that
// scope, so the same menu drives both install and uninstall per scope.
function PluginRow({
  plugin,
  installedScopes,
  busy,
  projectId,
  onInstall,
  onUninstall,
}: {
  plugin: MarketplacePlugin;
  installedScopes: Set<string>;
  busy: boolean;
  projectId?: string;
  onInstall: (scope: 'user' | 'project') => void;
  onUninstall: (scope: 'user' | 'project') => void;
}) {
  // Global (no-project) modal can still install/uninstall at USER scope —
  // that's cwd-independent. Project scope needs a project to act on.
  const canProjectScope = !!projectId;
  const anyInstalled = installedScopes.size > 0;

  return (
    <div className={styles.mpPluginRow}>
      <OptionRow
        icon="⬡"
        title={
          <span className={styles.mpPluginTitle}>
            {plugin.name}
            {installedScopes.size > 0 ? (
              <span className={styles.scopeProject}>✓ installed ({[...installedScopes].join(', ')})</span>
            ) : null}
          </span>
        }
        desc={typeof plugin.description === 'string' ? plugin.description : ''}
      />
      <LabeledDropdown
        disabled={busy}
        label={busy ? 'Working…' : anyInstalled ? 'Manage' : 'Install'}
        menuClassName={styles.mpScopeMenu}
      >
        {(close) => (
          <>
            <MenuItem
              onClick={() => {
                close();
                if (installedScopes.has('user')) onUninstall('user');
                else onInstall('user');
              }}
            >
              {installedScopes.has('user') ? 'uninstall (user)' : 'user'}
            </MenuItem>
            {canProjectScope ? (
              <MenuItem
                onClick={() => {
                  close();
                  if (installedScopes.has('project')) onUninstall('project');
                  else onInstall('project');
                }}
              >
                {installedScopes.has('project') ? 'uninstall (project)' : 'project'}
              </MenuItem>
            ) : null}
          </>
        )}
      </LabeledDropdown>
    </div>
  );
}

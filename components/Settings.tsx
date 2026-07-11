'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useAppState } from '../lib/client/store';
import {
  getEnv,
  getHooksStatus,
  getUsage,
  installStatusHooks,
  putConfig,
  registerBridge,
  uninstallStatusHooks,
  type HooksInstallState,
} from '../lib/client/api';
import type { ProviderId } from '../lib/client/types';
import Card from './ui/Card';
import Toggle from './ui/Toggle';
import Select from './ui/Select';
import Segmented from './ui/Segmented';
import Button from './ui/Button';
import MeterBar from './ui/MeterBar';
import ProviderBadge from './ui/ProviderBadge';
import styles from './Settings.module.scss';

// Mirrors server/lib/detect.ts (hard rule 3: no ~/.claude or ~/.codex path
// literals in client code — everything comes from these API fields).
type AgentEnv = { found: boolean; path?: string; version?: string; store: { found: boolean; projects: number; bytes: number } };
type EnvResponse = {
  claude: AgentEnv;
  codex: AgentEnv;
  tmux: { found: boolean; version?: string };
  rg: { found: boolean };
  // Task 16.7: MCP bridge registration status (read-only; POST /api/bridge/register writes).
  bridge?: { claude: { registered: boolean }; codex: { registered: boolean } };
};
type UsageSummary = {
  sessions: number;
  totalTokens: number;
  cacheReads: number;
  estCostUsd: number;
  byProject: { name: string; pct: number }[];
  byProvider: { provider: ProviderId; pct: number }[];
};

function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

const HOP_BUDGETS = ['3 per task', '10 per task', '25 per task'];
const CACHE_SIZES = ['10 most recent', '25 most recent', '50 most recent'];
const SCROLLBACK = ['2,000 lines', '5,000 lines', '10,000 lines'];
const SESSION_WINDOW = ['1 week', '2 weeks', '1 month'];
const PERMISSION_MODES = ['default', 'plan', 'acceptEdits'];
const THEME_OPTS = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];
const ACCENT_OPTS = [
  { id: 'iris', label: 'Iris' },
  { id: 'teal', label: 'Signal Teal' },
];

// Card shell (border/radius/bg/overflow) + a Settings-owned section header.
// Card's own .title lives in another CSS module and can't take the design's
// 15/20 padding + bottom border from here, so we render the header ourselves.
function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <Card>
      <div className={styles.sectionHead}>
        <span>{title}</span>
        {note ? <span className={styles.sectionNote}>{note}</span> : null}
      </div>
      {children}
    </Card>
  );
}

// Environment row (design L222): name + mono sub on the left, mono status on
// the right. `subMono` defaults true — control rows pass false for a faint
// sans sub instead of a mono path.
function EnvRow({
  name,
  sub,
  subMono = true,
  children,
}: {
  name: string;
  sub?: string;
  subMono?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>
        <span className={styles.name}>{name}</span>
        {sub ? <span className={subMono ? styles.sub : styles.subPlain}>{sub}</span> : null}
      </span>
      {children}
    </div>
  );
}

// Detection status — ✓/✗ coloured live/hot (design L228).
function DetectStatus({ found, detail }: { found: boolean; detail?: string }) {
  return (
    <span className={`${styles.status} ${found ? styles.ok : styles.bad}`}>
      {found ? `✓ detected${detail ? ` · ${detail}` : ''}` : '✗ not found'}
    </span>
  );
}

// Count/size detail — neutral --text-dim, not a green check (design L105-107).
function StoreStatus({ found, detail }: { found: boolean; detail: string }) {
  return <span className={`${styles.status} ${found ? styles.neutral : styles.bad}`}>{found ? detail : '✗ not found'}</span>;
}

export default function Settings() {
  const { state, dispatch } = useAppState();
  const [env, setEnv] = useState<EnvResponse | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [hooks, setHooks] = useState<Record<string, HooksInstallState> | null>(null);
  const [hooksBusy, setHooksBusy] = useState(false);
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system');
  const [accent, setAccent] = useState<'teal' | 'iris'>('iris');

  const settings = state.config.settings as Record<string, unknown>;

  // Full-page overlay: Escape closes it (mirrors the ← Back button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'closeSettings' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dispatch]);

  function rescan() {
    setRescanning(true);
    (getEnv() as Promise<EnvResponse>)
      .then((e) => {
        setEnv(e);
        setRescanning(false);
      })
      .catch(() => setRescanning(false));
  }

  function handleRegister() {
    setRegistering(true);
    registerBridge()
      .then(() => rescan()) // refresh the registered status after writing agent config
      .finally(() => setRegistering(false));
  }

  function refreshHooks() {
    getHooksStatus().then(setHooks).catch(() => setHooks(null));
  }

  // Derive which provider(s) support status hooks from GET /api/hooks/status
  // itself (hard rule 3 — no hardcoded provider id here; if codex gains
  // statusHooks the toggle picks it up with zero client changes).
  const hookProviders = Object.entries(hooks ?? {})
    .filter(([, st]) => st.available)
    .map(([id]) => id as ProviderId);

  function handleHooksToggle(on: boolean) {
    setHooksBusy(true);
    Promise.all(hookProviders.map((id) => (on ? installStatusHooks(id) : uninstallStatusHooks(id))))
      .then(refreshHooks)
      .finally(() => setHooksBusy(false));
  }

  useEffect(() => {
    rescan();
    refreshHooks();
    (getUsage(30) as Promise<UsageSummary>).then(setUsage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setTheme(localStorage.getItem('seshmux-theme-locked') ? (state.config.theme as 'light' | 'dark') : 'system');
  }, [state.config.theme]);

  // Seed the accent control from localStorage (the pre-paint source of truth),
  // NOT from config — config may drop the field server-side, but localStorage
  // always reflects what's actually stamped on <html>. Mirrors the theme seed.
  useEffect(() => {
    import('../lib/client/theme').then(({ currentAccent }) => setAccent(currentAccent()));
  }, []);

  function persistSetting(key: string, value: unknown) {
    const config = { ...state.config, settings: { ...settings, [key]: value } };
    dispatch({ type: 'setConfig', config });
    putConfig(config);
  }

  function setThemeChoice(id: string) {
    // Dynamic import keeps theme.ts (window/localStorage-only module) out of
    // any server-rendered path — Settings is 'use client' already, this just
    // avoids a top-level import order surprise with SSR.
    import('../lib/client/theme').then(({ applyTheme, currentTheme }) => {
      if (id === 'system') {
        localStorage.removeItem('seshmux-theme-locked');
        const t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        applyTheme(t);
        setTheme('system');
        const config = { ...state.config, theme: t };
        dispatch({ type: 'setConfig', config });
        putConfig(config);
      } else {
        localStorage.setItem('seshmux-theme-locked', '1');
        applyTheme(id as 'light' | 'dark');
        setTheme(id as 'light' | 'dark');
        const config = { ...state.config, theme: currentTheme() };
        dispatch({ type: 'setConfig', config });
        putConfig(config);
      }
    });
  }

  function setAccentChoice(id: string) {
    const a = id === 'teal' ? 'teal' : 'iris';
    import('../lib/client/theme').then(({ applyAccent }) => {
      applyAccent(a);
      setAccent(a);
      const config = { ...state.config, accent: a };
      dispatch({ type: 'setConfig', config });
      putConfig(config);
    });
  }

  const byProviderPct = usage?.byProvider ?? [];
  const totalProviderPct = byProviderPct.reduce((s, p) => s + p.pct, 0) || 1;

  return (
    <div className={styles.settings}>
      <div className={styles.inner}>
        <div className={styles.backRow}>
          <Button onClick={() => dispatch({ type: 'closeSettings' })}>← Back</Button>
          <h1 className={styles.h1}>Settings</h1>
        </div>

        <Section title="Environment">
          {env ? (
            <>
              <EnvRow name="Claude Code" sub={env.claude.path ?? 'not found on PATH'}>
                <DetectStatus found={env.claude.found} detail={env.claude.version} />
              </EnvRow>
              <EnvRow
                name="Deep agent integration"
                sub="installs status hooks into Claude Code's own config — agent-authored status instead of screen heuristics"
                subMono={false}
              >
                <Toggle
                  on={hookProviders.some((id) => hooks?.[id]?.installed)}
                  disabled={hooksBusy || hookProviders.length === 0}
                  onChange={handleHooksToggle}
                />
              </EnvRow>
              <EnvRow name="tmux" sub="required for session persistence" subMono={false}>
                <DetectStatus found={env.tmux.found} detail={env.tmux.version} />
              </EnvRow>
              <EnvRow name="Session store" sub="Claude Code project store" subMono={false}>
                <StoreStatus
                  found={env.claude.store.found}
                  detail={`${env.claude.store.projects} projects · ${fmtBytes(env.claude.store.bytes)}`}
                />
              </EnvRow>
              <EnvRow name="Codex CLI" sub={env.codex.path ?? 'not found on PATH'}>
                <DetectStatus found={env.codex.found} detail={env.codex.version} />
              </EnvRow>
              <EnvRow name="Codex session store" sub="Codex rollout store" subMono={false}>
                <StoreStatus
                  found={env.codex.store.found}
                  detail={`${env.codex.store.projects} sessions · ${fmtBytes(env.codex.store.bytes)}`}
                />
              </EnvRow>
              <EnvRow name="rg" sub="fast search — optional" subMono={false}>
                <span className={`${styles.status} ${env.rg.found ? styles.ok : styles.neutral}`}>
                  {env.rg.found ? '✓ detected' : '✗ not found'}
                </span>
              </EnvRow>
            </>
          ) : null}
          <EnvRow name="Rescan" sub="re-detect environment" subMono={false}>
            <Button onClick={rescan} disabled={rescanning}>
              {rescanning ? 'Rescanning…' : 'Rescan now'}
            </Button>
          </EnvRow>
        </Section>

        <Card>
          <div className={styles.usageCard}>
            <div className={styles.usageHead}>
              <span className={styles.usageHeadTitle}>Usage — last 30 days</span>
              <span className={styles.usageHeadNote}>from session logs</span>
            </div>
            {usage ? (
              <>
                <div className={styles.stats}>
                  <div className={styles.stat}>
                    <div className={styles.statN}>{fmtCount(usage.sessions)}</div>
                    <div className={styles.statL}>sessions</div>
                  </div>
                  <div className={styles.stat}>
                    <div className={styles.statN}>{fmtCount(usage.totalTokens)}</div>
                    <div className={styles.statL}>total tokens</div>
                  </div>
                  <div className={styles.stat}>
                    <div className={styles.statN}>{fmtCount(usage.cacheReads)}</div>
                    <div className={styles.statL}>cache reads</div>
                  </div>
                  <div className={styles.stat}>
                    <div className={styles.statN}>~${Math.round(usage.estCostUsd)}</div>
                    <div className={styles.statL}>est. API cost</div>
                  </div>
                </div>
                {byProviderPct.length > 0 ? (
                  <div className={styles.barRow}>
                    <span className={styles.barName}>by agent</span>
                    <span className={styles.barTrack}>
                      <MeterBar tone="accent" pct={(byProviderPct[0].pct / totalProviderPct) * 100} />
                    </span>
                    <span className={styles.barPctProviders}>
                      {byProviderPct.map((p) => (
                        <span key={p.provider} className={styles.providerPct}>
                          <ProviderBadge provider={p.provider} /> {p.pct}%
                        </span>
                      ))}
                    </span>
                  </div>
                ) : null}
                {usage.byProject.map((p) => (
                  <div key={p.name} className={styles.barRow}>
                    <span className={styles.barName}>{p.name}</span>
                    <span className={styles.barTrack}>
                      <MeterBar tone="accent" pct={p.pct} />
                    </span>
                    <span className={styles.barPct}>{p.pct}%</span>
                  </div>
                ))}
              </>
            ) : null}
          </div>
        </Card>

        <Section title="Agent bridge" note="MCP — agents call each other as tools">
          <EnvRow name="Bridge registration" sub="writes seshmux-bridge into each agent’s MCP config" subMono={false}>
            <Button onClick={handleRegister} disabled={registering}>
              {registering ? 'Registering…' : 'Register'}
            </Button>
          </EnvRow>
          <EnvRow name="Registered in Claude Code" sub="exposes ask_codex" subMono={false}>
            {env?.bridge?.claude.registered ? (
              <span className={`${styles.status} ${styles.ok}`}>✓ registered</span>
            ) : (
              <span className={`${styles.status} ${styles.neutral}`}>not registered</span>
            )}
          </EnvRow>
          <EnvRow name="Registered in Codex" sub="exposes ask_claude" subMono={false}>
            {env?.bridge?.codex.registered ? (
              <span className={`${styles.status} ${styles.ok}`}>✓ registered</span>
            ) : (
              <span className={`${styles.status} ${styles.neutral}`}>not registered</span>
            )}
          </EnvRow>
          <EnvRow
            name="Approve each cross-agent call"
            sub="off = agents relay freely within hop budget"
            subMono={false}
          >
            <Toggle on={!!settings.bridgeApprove} onChange={(on) => persistSetting('bridgeApprove', on)} />
          </EnvRow>
          <EnvRow
            name="Hop budget"
            sub="max cross-agent calls per task — hard no-loop rule always on"
            subMono={false}
          >
            <Select
              options={HOP_BUDGETS}
              value={(settings.hopBudget as string) ?? '10 per task'}
              onChange={(v) => persistSetting('hopBudget', v)}
            />
          </EnvRow>
        </Section>

        <Section title="Appearance">
          <EnvRow name="Theme">
            <Segmented options={THEME_OPTS} value={theme} onChange={setThemeChoice} />
          </EnvRow>
          <EnvRow name="Accent" sub="signal color for highlights & controls" subMono={false}>
            <Segmented options={ACCENT_OPTS} value={accent} onChange={setAccentChoice} />
          </EnvRow>
        </Section>

        <Section title="Notifications">
          <EnvRow name="Needs-input alerts" sub="toast when a session waits on you" subMono={false}>
            <Toggle
              on={settings.needsInputAlerts !== false}
              onChange={(on) => persistSetting('needsInputAlerts', on)}
            />
          </EnvRow>
          <EnvRow
            name="macOS notifications"
            sub="system notification when seshmux is in background"
            subMono={false}
          >
            <Toggle on={settings.macNotifications !== false} onChange={(on) => persistSetting('macNotifications', on)} />
          </EnvRow>
          <EnvRow name="Notify when done" sub="notify when a session finishes, not just when it needs input" subMono={false}>
            <Toggle on={settings.notifyOnDone !== false} onChange={(on) => persistSetting('notifyOnDone', on)} />
          </EnvRow>
          <EnvRow name="Sound">
            <Toggle on={!!settings.sound} onChange={(on) => persistSetting('sound', on)} />
          </EnvRow>
        </Section>

        <Section title="Memory & storage">
          <EnvRow name="Transcript cache" sub="parsed transcripts kept in memory" subMono={false}>
            <Select
              options={CACHE_SIZES}
              value={(settings.transcriptCache as string) ?? '10 most recent'}
              onChange={(v) => persistSetting('transcriptCache', v)}
            />
          </EnvRow>
          <EnvRow name="Terminal scrollback" sub="tmux keeps full history" subMono={false}>
            <Select
              options={SCROLLBACK}
              value={(settings.scrollback as string) ?? '5,000 lines'}
              onChange={(v) => persistSetting('scrollback', v)}
            />
          </EnvRow>
          <EnvRow name="Session list window" sub="older sessions load on demand" subMono={false}>
            <Select
              options={SESSION_WINDOW}
              value={(settings.sessionWindow as string) ?? '1 week'}
              onChange={(v) => persistSetting('sessionWindow', v)}
            />
          </EnvRow>
        </Section>

        <Section title="Sessions">
          <EnvRow name="tmux session prefix">
            <span className={styles.mono}>seshmux-</span>
          </EnvRow>
          <EnvRow name="Default permission mode" sub="for new sessions" subMono={false}>
            <Select
              options={PERMISSION_MODES}
              value={(settings.permissionMode as string) ?? 'default'}
              onChange={(v) => persistSetting('permissionMode', v)}
            />
          </EnvRow>
        </Section>

        <Section title="Account & sync" note="coming soon">
          <EnvRow
            name="Firebase sync"
            sub="pins, names, notes across machines — local-first either way"
            subMono={false}
          >
            <Button disabled>Sign in</Button>
          </EnvRow>
        </Section>

        <div className={styles.footer}>
          seshmux is an independent project, not affiliated with or endorsed by Anthropic or OpenAI.
        </div>
      </div>
    </div>
  );
}

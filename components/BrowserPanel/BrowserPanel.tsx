'use client';

// Embedded browser for the right pane: point it at whatever this session is
// serving. Opened from the terminal statusbar's browser chip.
//
// The panel picks its own opening move from what it finds, which is the whole
// point of the chip being one click:
//   • exactly one port  -> load it, no questions
//   • several ports     -> the chooser (this pane IS the "which port?" rail)
//   • none              -> offer the repo's own dev script with a Run button
//
// Port discovery is server-side (server/lib/preview.ts) and reads this session's
// PTY scrollback, so it works on Windows where the lsof-based ports panel
// cannot. Polling rather than an events-hub subscription: ports appear when a
// dev server binds, which is not a PTY event we classify, and a 2.5s poll of a
// bounded scrollback scan is cheaper than a new event type.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  checkFrame,
  getDevScripts,
  getPreviewPorts,
  runDevScript,
  type DevScript,
  type PreviewPort,
  type ScriptGroup,
} from '../../lib/client/api';
import {
  back,
  canBack,
  canForward,
  current,
  displayUrl,
  emptyNav,
  forward,
  initialNav,
  navigate,
  normalizeUrl,
  type NavState,
} from '../../lib/client/browser-nav';
import Button from '../ui/Button/Button';
import IconButton from '../ui/IconButton/IconButton';
import Segmented from '../ui/Segmented/Segmented';
import Select from '../ui/Select/Select';
import TextInput from '../ui/TextInput/TextInput';
import styles from './BrowserPanel.module.scss';

// Widths, not device names: "390" tells you what you're testing, where "iPhone"
// only tells you what marketing called it the year the constant was written.
const DEVICES = [
  { id: 'full', label: 'Full', width: 0 },
  { id: 'tablet', label: '768', width: 768 },
  { id: 'mobile', label: '390', width: 390 },
];

// Everything a local dev app needs, minus allow-top-navigation: a previewed page
// must never be able to yank the whole seshmux window somewhere else. Note that
// allow-same-origin here means "keep your OWN origin" — the frame is already
// cross-origin to seshmux (different port), so this grants it nothing of ours,
// while omitting it would break every app that touches localStorage or cookies.
const SANDBOX =
  'allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock';

// No port loaded: poll fast, because the user is watching for a dev server to
// come up. Loaded: the list only feeds the switcher, so slow down.
const POLL_SEARCHING_MS = 2500;
const POLL_IDLE_MS = 10_000;

export interface BrowserPanelProps {
  projectId: string;
  /** The session's agent PTY — the scrollback that gets scraped, and the owner of any shell we start. */
  ptyId?: string | null;
  /** Called with the new scratch shell's ptyId after Run, so the strip can show it. */
  onShellStarted?: (scratchPtyId: string) => void;
  onClose: () => void;
}

type FrameCheck = { reachable: boolean; status: number; blocked: 'xfo' | 'csp' | null };

export default function BrowserPanel({ projectId, ptyId, onShellStarted, onClose }: BrowserPanelProps) {
  const [ports, setPorts] = useState<PreviewPort[] | null>(null);
  const [groups, setGroups] = useState<ScriptGroup[] | null>(null);
  const [nav, setNav] = useState<NavState>(emptyNav);
  const [draft, setDraft] = useState('');
  const [device, setDevice] = useState('full');
  const [reloadKey, setReloadKey] = useState(0);
  const [frame, setFrame] = useState<FrameCheck | null>(null);
  const [running, setRunning] = useState<{ command: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const url = current(nav);

  const go = useCallback((next: string) => {
    setNav((n) => navigate(n, next));
    setRunning(null);
  }, []);

  // ── discovery ────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await getPreviewPorts(projectId, ptyId);
        if (alive) setPorts(res.ports);
      } catch {
        /* best-effort; the next tick retries */
      }
    };
    void load();
    const timer = setInterval(load, url ? POLL_IDLE_MS : POLL_SEARCHING_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [projectId, ptyId, url]);

  // One port and nowhere to be: that's the answer, don't make them click it.
  // Guarded on `url` so this never yanks the view out from under a manual
  // navigation when a second port later disappears.
  useEffect(() => {
    if (!url && ports && ports.length === 1) {
      setNav(initialNav(ports[0].url));
      setRunning(null); // the thing we were waiting for came up
    }
  }, [ports, url]);

  // Scripts are only interesting in the empty state — fetched once we know
  // there is nothing listening, not on every mount.
  useEffect(() => {
    if (!ports || ports.length > 0 || groups !== null) return;
    let alive = true;
    getDevScripts(projectId, ptyId)
      .then((r) => alive && setGroups(r.groups))
      .catch(() => alive && setGroups([]));
    return () => {
      alive = false;
    };
  }, [ports, groups, projectId, ptyId]);

  // Keep the URL bar showing where we actually are, except while it's being
  // typed in (a poll-driven re-render must not eat a half-typed address).
  useEffect(() => {
    setDraft(url ? displayUrl(url) : '');
  }, [url]);

  // Is this page going to render, or silently refuse? See preview.ts frameBlock.
  useEffect(() => {
    if (!url) {
      setFrame(null);
      return;
    }
    let alive = true;
    setFrame(null);
    checkFrame(url)
      .then((r) => alive && setFrame(r))
      .catch(() => {
        /* the iframe is the real test; a failed check just means no warning */
      });
    return () => {
      alive = false;
    };
  }, [url, reloadKey]);

  // ── actions ──────────────────────────────────────────────────────────────
  const submitUrl = () => {
    const next = normalizeUrl(draft, url || null);
    if (next) go(next);
    else setDraft(url ? displayUrl(url) : ''); // unparseable — snap back rather than sit on a lie
  };

  const openExternal = () => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  async function run(group: ScriptGroup, script: DevScript) {
    if (!ptyId) return;
    setRunError(null);
    setRunning({ command: '' });
    try {
      const res = await runDevScript(ptyId, script.name, group.subdir);
      setRunning({ command: res.command });
      // The shell is a real terminal in this tab's strip — surface it so its
      // output and its ^C are reachable. page.tsx keeps THIS panel active.
      onShellStarted?.(res.ptyId);
    } catch (e) {
      setRunning(null);
      setRunError(e instanceof Error ? e.message : 'failed to start');
    }
  }

  // ── derived ──────────────────────────────────────────────────────────────
  const deviceWidth = DEVICES.find((d) => d.id === device)?.width ?? 0;

  // The switcher always contains where we are, even if that port has since
  // dropped off the list — otherwise Select would silently show a wrong value.
  const portOptions = useMemo(() => {
    const opts = (ports ?? []).map((p) => ({ value: p.url, label: `:${p.port}` }));
    if (url && !opts.some((o) => o.value === originOf(url))) {
      const port = portOf(url);
      opts.unshift({ value: originOf(url), label: port ? `:${port}` : displayUrl(url) });
    }
    return opts;
  }, [ports, url]);

  return (
    <div className={styles.panel}>
      <div className={styles.nav}>
        <IconButton label="Back" className={styles.navGlyph} disabled={!canBack(nav)} onClick={() => setNav(back)}>
          ‹
        </IconButton>
        <IconButton
          label="Forward"
          className={styles.navGlyph}
          disabled={!canForward(nav)}
          onClick={() => setNav(forward)}
        >
          ›
        </IconButton>
        <IconButton
          label="Reload"
          className={styles.navGlyph}
          disabled={!url}
          onClick={() => setReloadKey((k) => k + 1)}
        >
          ⟳
        </IconButton>
        <TextInput
          className={styles.url}
          value={draft}
          onChange={setDraft}
          placeholder="localhost:3000"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitUrl();
            if (e.key === 'Escape') setDraft(url ? displayUrl(url) : '');
          }}
        />
        <IconButton label="Open in browser" className={styles.navGlyph} disabled={!url} onClick={openExternal}>
          ↗
        </IconButton>
        <IconButton label="Close browser panel" className={styles.navGlyph} onClick={onClose}>
          ✕
        </IconButton>
      </div>

      {url ? (
        <div className={styles.meta}>
          {portOptions.length > 1 ? (
            <Select options={portOptions} value={originOf(url)} onChange={go} />
          ) : (
            <span className={styles.metaNote}>{portOptions[0]?.label ?? ''}</span>
          )}
          <Segmented options={DEVICES.map((d) => ({ id: d.id, label: d.label }))} value={device} onChange={setDevice} />
        </div>
      ) : null}

      <div className={styles.body}>{renderBody()}</div>
    </div>
  );

  function renderBody() {
    if (url && frame?.blocked) {
      return (
        <div className={styles.notice}>
          <div className={styles.noticeTitle}>this app refuses to be embedded</div>
          <p className={styles.noticeText}>
            {frame.blocked === 'xfo'
              ? 'It sends X-Frame-Options, so the browser will not render it inside seshmux.'
              : "Its Content-Security-Policy sets frame-ancestors 'none'."}{' '}
            Open it in a real browser window instead.
          </p>
          <Button variant="chip" onClick={openExternal}>
            ↗ open {displayUrl(url)}
          </Button>
        </div>
      );
    }

    if (url) {
      return (
        <div className={styles.stage}>
          <div
            className={deviceWidth ? `${styles.frameWrap} ${styles.narrow}` : styles.frameWrap}
            style={deviceWidth ? { width: deviceWidth } : undefined}
          >
            {/* key on url+reloadKey: an iframe's own history is unreachable
                cross-origin, so remounting IS reload and IS navigation. */}
            <iframe
              key={`${url}#${reloadKey}`}
              className={styles.frame}
              src={url}
              title="Preview"
              sandbox={SANDBOX}
            />
          </div>
        </div>
      );
    }

    if (ports === null) return <div className={styles.empty}>looking for a server…</div>;

    if (ports.length > 1) {
      return (
        <div className={styles.list}>
          <div className={styles.listHead}>{ports.length} ports listening — pick one</div>
          {ports.map((p) => (
            <button type="button" key={p.url} className={styles.portRow} onClick={() => go(p.url)}>
              <span className={styles.port}>:{p.port}</span>
              <span className={styles.portDir}>{p.dir || (p.origin === 'output' ? 'from output' : './')}</span>
              <span className={styles.portCmd}>{p.command ?? ''}</span>
            </button>
          ))}
        </div>
      );
    }

    return renderEmptyState();
  }

  function renderEmptyState() {
    if (running) {
      return (
        <div className={styles.notice}>
          <div className={styles.noticeTitle}>starting…</div>
          <p className={styles.noticeText}>
            {running.command ? (
              <code className={styles.code}>{running.command}</code>
            ) : (
              'spawning a terminal'
            )}{' '}
            is running in a terminal in this pane. The page loads here as soon as it binds a port.
          </p>
        </div>
      );
    }

    if (groups === null) return <div className={styles.empty}>nothing listening — looking for a dev script…</div>;

    if (groups.length === 0) {
      return (
        <div className={styles.notice}>
          <div className={styles.noticeTitle}>nothing listening</div>
          <p className={styles.noticeText}>
            No dev script found in this repo. Start your server, or type an address above.
          </p>
        </div>
      );
    }

    return (
      <div className={styles.list}>
        <div className={styles.listHead}>nothing listening</div>
        {runError ? <div className={styles.error}>{runError}</div> : null}
        {groups.map((g) => {
          const shown = showAll ? g.scripts : g.scripts.slice(0, 1);
          return (
            <div key={g.subdir || '.'} className={styles.group}>
              <div className={styles.groupName}>{g.subdir || './'}</div>
              {shown.map((s) => (
                <div key={s.name} className={styles.scriptRow}>
                  <div className={styles.scriptText}>
                    <div className={styles.scriptName}>
                      {g.manager === 'npm' || g.manager === 'bun'
                        ? `${g.manager} run ${s.name}`
                        : `${g.manager} ${s.name}`}
                    </div>
                    <div className={styles.scriptCmd}>{s.command}</div>
                  </div>
                  <Button
                    variant="chip"
                    className={styles.runBtn}
                    disabled={!ptyId}
                    title={ptyId ? 'Run in a new terminal in this pane' : 'No live terminal in this session'}
                    onClick={() => void run(g, s)}
                  >
                    run
                  </Button>
                </div>
              ))}
            </div>
          );
        })}
        {groups.some((g) => g.scripts.length > 1) ? (
          <button type="button" className={styles.more} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'fewer' : 'other…'}
          </button>
        ) : null}
      </div>
    );
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function portOf(url: string): string {
  try {
    return new URL(url).port;
  } catch {
    return '';
  }
}

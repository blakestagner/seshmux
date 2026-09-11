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
  ensurePreviewProxy,
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
import Spinner from '../ui/Spinner/Spinner';
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

// How long a started dev server gets to bind a port before the panel admits it
// may not be coming. Generous: a cold Next/webpack build genuinely takes this long.
const START_GRACE_MS = 30_000;

export interface BrowserPanelProps {
  projectId: string;
  /** The session's agent PTY — the scrollback that gets scraped, and the owner of any shell we start. */
  ptyId?: string | null;
  /** Called with the new scratch shell's ptyId after Run, so the strip can show it. */
  onShellStarted?: (scratchPtyId: string) => void;
  /**
   * False while another right-pane tab is showing. The panel is keepMounted (an
   * iframe must survive a strip switch with its scroll and form state), so
   * without this it would keep polling — and each poll pulls PTY scrollback
   * through the daemon, which on the holder tier means the whole ring buffer per
   * PTY. Mirrors ScratchTerminal's `visible`.
   */
  visible?: boolean;
  onClose: () => void;
}

type FrameCheck = { reachable: boolean; status: number; blocked: 'xfo' | 'csp' | null };

export default function BrowserPanel({
  projectId,
  ptyId,
  visible = true,
  onShellStarted,
  onClose,
}: BrowserPanelProps) {
  const [ports, setPorts] = useState<PreviewPort[] | null>(null);
  const [groups, setGroups] = useState<ScriptGroup[] | null>(null);
  const [nav, setNav] = useState<NavState>(emptyNav);
  const [draft, setDraft] = useState('');
  const [device, setDevice] = useState('full');
  const [reloadKey, setReloadKey] = useState(0);
  const [frame, setFrame] = useState<FrameCheck | null>(null);
  const [running, setRunning] = useState<{ command: string; at: number } | null>(null);
  // Ticks only while we are waiting on a Run, to re-render the starting notice
  // once it has been too long to still claim things are fine.
  const [waitedLong, setWaitedLong] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // targetPort -> proxied origin, for apps that refuse to be framed. Keyed by
  // port so switching back and forth reuses one proxy.
  const [proxied, setProxied] = useState<Record<number, string>>({});
  const [proxyError, setProxyError] = useState<string | null>(null);

  const url = current(nav);

  const go = useCallback((next: string) => {
    setNav((n) => navigate(n, next));
    setRunning(null);
  }, []);

  // ── discovery ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible) return; // off-screen: poll nothing, see the `visible` prop doc
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
  }, [projectId, ptyId, url, visible]);

  // One port and nowhere to be: that's the answer, don't make them click it.
  // Guarded on `url` so this never yanks the view out from under a manual
  // navigation when a second port later disappears.
  useEffect(() => {
    if (!url && ports && ports.length === 1) {
      setNav(initialNav(ports[0].url));
      setRunning(null); // the thing we were waiting for came up
    }
  }, [ports, url]);

  // A dev script that dies on startup (EADDRINUSE, missing node_modules, wrong
  // workspace) binds no port, so nothing would ever clear the "starting…"
  // notice. After this the notice stops promising and offers the way back.
  useEffect(() => {
    setWaitedLong(false);
    if (!running) return;
    const timer = setTimeout(() => setWaitedLong(true), START_GRACE_MS);
    return () => clearTimeout(timer);
  }, [running]);

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
        // Could not check — let the iframe be the test rather than blocking on
        // a verdict that will never arrive. `null` means "still checking", so
        // this MUST resolve to something or the panel waits forever.
        if (alive) setFrame({ reachable: true, status: 0, blocked: null });
      });
    return () => {
      alive = false;
    };
  }, [url, reloadKey]);

  // An app that blocks framing cannot be shown as-is — the header is enforced
  // by the browser against bytes we did not serve. Standing up a proxy is the
  // only fix, so do it rather than making the user read an explanation and go
  // edit their next.config. Automatic because the alternative is a dead end.
  useEffect(() => {
    if (!url || !frame?.blocked) return;
    const port = Number(portOf(url));
    if (!port || proxied[port]) return;
    let alive = true;
    setProxyError(null);
    ensurePreviewProxy(port)
      .then((r) => alive && setProxied((m) => ({ ...m, [port]: `http://localhost:${r.proxyPort}` })))
      .catch((e) => alive && setProxyError(e instanceof Error ? e.message : 'could not start proxy'));
    return () => {
      alive = false;
    };
  }, [url, frame, proxied]);

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
    setRunning({ command: '', at: Date.now() });
    try {
      const res = await runDevScript(ptyId, script.name, group.subdir);
      setRunning({ command: res.command, at: Date.now() });
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

  // What the iframe actually loads. For a blocked app that is the proxy origin,
  // with the original path preserved — the URL BAR keeps showing the real
  // address, because the proxy is an implementation detail and a user who reads
  // `localhost:53412` learns nothing true about their app.
  const framedUrl = (() => {
    if (!url || !frame?.blocked) return url;
    const origin = proxied[Number(portOf(url))];
    if (!origin) return '';
    try {
      const u = new URL(url);
      return origin + u.pathname + u.search + u.hash;
    } catch {
      return origin;
    }
  })();

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
          {/* Never substitute silently: what is on screen is being served
              through seshmux, which can matter when debugging headers, cookies
              or anything else the proxy sits in the middle of. */}
          {frame?.blocked && framedUrl ? (
            <span className={styles.metaNote} title="This app sends X-Frame-Options, so seshmux is serving it through a local proxy to make it embeddable">
              proxied
            </span>
          ) : null}
          <Segmented options={DEVICES.map((d) => ({ id: d.id, label: d.label }))} value={device} onChange={setDevice} />
        </div>
      ) : null}

      <div className={styles.body}>{renderBody()}</div>
    </div>
  );

  function renderBody() {
    // Wait for the verdict before painting anything. Rendering the iframe first
    // is what made a blocked app (X-Frame-Options: DENY — common in real Next
    // configs) show as a dead white rectangle: the browser silently refuses,
    // and the explanation only lands a moment later, if the user is still there.
    if (url && frame === null) {
      return (
        <div className={styles.empty}>
          <Spinner /> checking {displayUrl(url)}…
        </div>
      );
    }

    // Blocked, and the proxy has not answered yet (or could not start).
    if (url && frame?.blocked && !framedUrl) {
      if (!proxyError) {
        return (
          <div className={styles.empty}>
            <Spinner /> {displayUrl(url)} blocks embedding — routing it through seshmux…
          </div>
        );
      }
      return (
        <div className={styles.notice}>
          <div className={styles.noticeTitle}>could not preview this app</div>
          <p className={styles.noticeText}>
            {displayUrl(url)} sends{' '}
            <code className={styles.code}>
              {frame.blocked === 'xfo' ? 'X-Frame-Options' : "frame-ancestors 'none'"}
            </code>
            , so it can only be framed through seshmux&apos;s proxy — and the proxy did not start:{' '}
            {proxyError}
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
              key={`${framedUrl}#${reloadKey}`}
              className={styles.frame}
              src={framedUrl}
              title="Preview"
              sandbox={SANDBOX}
            />
          </div>
        </div>
      );
    }

    if (ports === null)
      return (
        <div className={styles.empty}>
          <Spinner /> looking for a server…
        </div>
      );

    if (ports.length > 1) {
      return (
        <div className={styles.list}>
          <div className={styles.listHead}>{ports.length} ports listening — pick one</div>
          {ports.map((p) => (
            <button type="button" key={p.url} className={styles.portRow} onClick={() => go(p.url)}>
              <span className={styles.port}>:{p.port}</span>
              <span className={styles.portDir}>
                {p.origin === 'process'
                  ? p.dir || './'
                  : p.origin === 'output'
                    ? 'this session'
                    : 'this machine'}
              </span>
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
          <div className={styles.noticeTitle}>
            {waitedLong ? null : <Spinner size={12} label="Starting dev server" />}{' '}
            {waitedLong ? 'still nothing on a port' : 'starting…'}
          </div>
          <p className={styles.noticeText}>
            {running.command ? <code className={styles.code}>{running.command}</code> : 'spawning a terminal'}{' '}
            {waitedLong
              ? 'has not bound a port yet. Check its terminal in this pane — it may have failed to start.'
              : 'is running in a terminal in this pane. The page loads here as soon as it binds a port.'}
          </p>
          {/* Without this the panel is a dead end: the script list is unmounted,
              so a command that started and died leaves no way back but closing
              and reopening the panel, which nobody would guess. */}
          <Button variant="chip" onClick={() => setRunning(null)}>
            back to scripts
          </Button>
        </div>
      );
    }

    if (groups === null)
      return (
        <div className={styles.empty}>
          <Spinner /> nothing listening — looking for a dev script…
        </div>
      );

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

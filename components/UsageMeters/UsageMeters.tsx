'use client';

// Plan rate limits in the top bar: the rolling short window and the all-models weekly
// limit, per provider — Claude first, Codex to its right. Renders nothing at all when
// there is nothing current to show; this is decoration, and a missing credential or an
// uninstalled agent must not put an error in the chrome.

import { useEffect, useState } from 'react';
import MeterBar from '../ui/MeterBar/MeterBar';
import ProviderBadge, { PROV } from '../ui/ProviderBadge/ProviderBadge';
import { getUsageLimits, type ProviderLimits, type UsageMeter } from '../../lib/client/api';
import styles from './UsageMeters.module.scss';

// Claude's reading is memoised server-side for 60s; poll a touch slower so we aren't
// calling for bytes we know are cached.
const POLL_MS = 90_000;

const WEEK_MINUTES = 10_080;

/** "5h" / "wk" / "2d" — derived from the window so a vendor changing 300→360 can't lie. */
export function windowLabel(m: UsageMeter): string {
  const base =
    m.windowMinutes === WEEK_MINUTES
      ? 'wk'
      : m.windowMinutes < 60
        ? `${m.windowMinutes}m`
        : m.windowMinutes < 1440
          ? `${+(m.windowMinutes / 60).toFixed(1)}h`
          : `${+(m.windowMinutes / 1440).toFixed(1)}d`;
  // Opus is metered separately from the all-models weekly bar on some plans; without this
  // the two weekly bars would both read "wk".
  return m.scope === 'opus' ? `${base} opus` : base;
}

/**
 * Tooltip text. Exported for tests — it branches on how far out the reset is and on
 * whether the numbers are a live reading or a snapshot.
 */
export function meterHint(
  providerName: string,
  m: UsageMeter,
  capturedAt?: string,
  now = Date.now(),
): string {
  const window = m.windowMinutes === WEEK_MINUTES ? 'weekly' : `${windowLabel(m)} window`;
  let s = `${providerName} ${window}: ${Math.round(m.pct)}% used`;

  const reset = m.resetsAt ? new Date(m.resetsAt) : null;
  if (reset && !Number.isNaN(reset.getTime())) {
    // Inside a day -> a clock time is what you want ("resets 4:20 PM"); a weekly window is
    // days out, so name the day instead.
    const soon = reset.getTime() - now < 24 * 60 * 60 * 1000;
    s += ` · resets ${
      soon
        ? reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : reset.toLocaleDateString([], { weekday: 'short', hour: 'numeric' })
    }`;
  }

  // Codex only writes these numbers while it runs, so its reading can be hours old and
  // only ever undercounts. Say so rather than passing a stale number off as live.
  const captured = capturedAt ? new Date(capturedAt) : null;
  if (captured && !Number.isNaN(captured.getTime())) {
    const mins = Math.floor((now - captured.getTime()) / 60_000);
    if (mins >= 5) s += ` · as of ${mins < 90 ? `${mins}m` : `${Math.round(mins / 60)}h`} ago`;
  }
  return s;
}

export default function UsageMeters() {
  const [providers, setProviders] = useState<ProviderLimits[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getUsageLimits()
        .then((r) => {
          if (alive) setProviders(r.providers ?? []);
        })
        .catch(() => {
          /* offline / server restarting — keep the last good numbers */
        });
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // PROV is keyed by the ProviderId union, but `providers` is parsed JSON: a server that
  // learns a third agent before this bundle does would otherwise throw on the name lookup
  // and take the whole top bar down with it. Skip what we can't label.
  const known = providers.filter((p) => PROV[p.provider]);
  if (known.length === 0) return null;

  return (
    <div className={styles.wrap}>
      {known.map((p) => (
        <div key={p.provider} className={styles.group}>
          {/* Self-hides on a single-agent machine — every badge would read the same. */}
          <ProviderBadge provider={p.provider} />
          {p.meters.map((m) => (
            <span
              key={`${m.windowMinutes}-${m.scope ?? ''}`}
              className={styles.meter}
              title={meterHint(PROV[p.provider].name, m, p.capturedAt)}
            >
              <span className={styles.label}>{windowLabel(m)}</span>
              <span className={styles.bar}>
                {/* ctx tone = the shared 5px track, warm >=60 / hot >=80 for free */}
                <MeterBar pct={m.pct} tone="ctx" />
              </span>
              <span className={styles.pct}>{Math.round(m.pct)}%</span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

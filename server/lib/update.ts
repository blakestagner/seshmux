// Self-update check + apply (Task 18, server-lib half). Every seam is injectable so tests
// never hit the network / fs / npm. checkUpdate is OFFLINE-SAFE: any failure (404, timeout,
// network) resolves to updateAvailable:false and NEVER throws.
//
// NOTE (scope): this module only decides + runs `npm i -g`. The server-restart choreography
// (exit 75, events-ws 'server-restarting' broadcast, bin/seshmux.js relaunch loop, crash-loop
// guard) belongs to the daemon/bin layer — see TODO(wire) on applyUpdate's return.

import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';

export type InstallMethod = 'global' | 'npx' | 'local';

export interface UpdateStatus {
  current: string;
  latest: string;
  updateAvailable: boolean;
  installMethod: InstallMethod;
}

const REGISTRY_URL = 'https://registry.npmjs.org/seshmux/latest';
const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

type ExecLike = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>;

// Numeric-segment compare (NOT lexical — "0.10.0" > "0.9.0"). Returns <0, 0, >0.
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Install method from an already-resolved argv path + npm global prefix. npx MUST be right
// (it gates applyUpdate's reject); anchor on the stable `_npx` cache segment, not a hash.
export function detectInstallMethod(opts: {
  argvRealPath: string;
  globalPrefix: string;
}): InstallMethod {
  const p = opts.argvRealPath;
  if (p.includes('/_npx/') || p.includes('\\_npx\\')) return 'npx';
  // Both sides must be realpath'd or neither. argvRealPath is resolved; `npm prefix -g` is
  // NOT, so a symlinked prefix (macOS /tmp -> /private/tmp, homebrew /usr/local, some nvm
  // layouts) made startsWith fail and reported a global install as 'local' — which hides the
  // update button entirely, since we refuse to run `npm i -g` for a non-global install.
  const prefix = realpath(opts.globalPrefix);
  if (prefix && realpath(p).startsWith(prefix)) return 'global';
  return 'local';
}

// realpathSync throws on a path that doesn't exist — fall back to the raw string.
function realpath(p: string): string {
  if (!p) return '';
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// Default resolution of the current process's real argv path (realpath resolves npm's bin
// symlink into lib/node_modules). Guarded — realpath throws if the path doesn't exist.
function resolveArgvRealPath(): string {
  const raw = process.argv[1] ?? '';
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init) as ReturnType<FetchLike>;

function defaultExec(cmd: string, args: string[]): Promise<{ stdout: string; stderr?: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

// Default npm global prefix via `npm prefix -g` (the execPath-derived guess is wrong on
// homebrew/Cellar layouts). Best-effort — empty string on failure (detection falls to local).
async function defaultGlobalPrefix(exec: ExecLike): Promise<string> {
  try {
    const { stdout } = await exec('npm', ['prefix', '-g']);
    return stdout.trim();
  } catch {
    return '';
  }
}

let cache: { ts: number; latest: string } | null = null;

export interface CheckUpdateDeps {
  current?: string;
  fetchFn?: FetchLike;
  exec?: ExecLike;
  argvRealPath?: string;
  globalPrefix?: string;
}

export async function checkUpdate(deps: CheckUpdateDeps = {}): Promise<UpdateStatus> {
  // SESHMUX_VERSION is stamped by bin/seshmux.js (which can always read its own package.json).
  // npm_package_version only exists under `npm run …` — it is undefined for `npx seshmux` and
  // for the global bin, so it must not be the primary source (see the note in bin/seshmux.js).
  const current = deps.current ?? process.env.SESHMUX_VERSION ?? process.env.npm_package_version ?? '0.0.0';
  const fetchFn = deps.fetchFn ?? defaultFetch;
  const exec = deps.exec ?? defaultExec;
  const argvRealPath = deps.argvRealPath ?? resolveArgvRealPath();
  const globalPrefix = deps.globalPrefix ?? (await defaultGlobalPrefix(exec));
  const installMethod = detectInstallMethod({ argvRealPath, globalPrefix });

  // Serve from 6h cache when warm (seshmux isn't published yet, so this is usually a 404).
  let latest = current;
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    latest = cache.latest;
  } else {
    latest = await fetchLatest(fetchFn, current);
    cache = { ts: Date.now(), latest };
  }

  return {
    current,
    latest,
    updateAvailable: compareVersions(latest, current) > 0,
    installMethod,
  };
}

// Fetch the registry `latest` version. OFFLINE-SAFE: 404 / non-ok / network / timeout all
// resolve to `current` (so the compare yields updateAvailable:false and nothing throws).
async function fetchLatest(fetchFn: FetchLike, current: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) return current; // 404 (unpublished) etc.
    const body = (await res.json()) as { version?: string };
    return typeof body.version === 'string' ? body.version : current;
  } catch {
    return current; // network / abort / parse error
  } finally {
    clearTimeout(timer);
  }
}

// Test hook: clear the memoized registry result.
export function _resetUpdateCache(): void {
  cache = null;
}

export interface ApplyUpdateDeps {
  installMethod: InstallMethod;
  current: string; // captured BEFORE install so rollback text names the previous version
  // The exact version checkUpdate resolved. Installing THIS instead of re-resolving `@latest`
  // is what makes apply agree with check — see the note on applyUpdate.
  target?: string;
  exec?: ExecLike;
}

export interface ApplyUpdateResult {
  ok: boolean;
  log: string;
  previous: string; // the version to roll back to: `npm i -g seshmux@<previous>`
}

// Installs the version checkUpdate resolved. Rejects for npx installs (cache is per-invocation,
// no self-update possible). Never touches the running server — the caller decides restart.
//
// Why not `seshmux@latest`: checkUpdate fetches the registry directly, but `npm i` resolves
// through npm's CACHED packument. Anyone whose cache predates the release — i.e. every existing
// user, the only people who can click this — gets `latest -> 0.1.1` from the network and then
// "ETARGET: No matching version found for seshmux@0.1.1" from the cache. The button announced an
// update and then reliably failed to install it. Verified: `npm i -g seshmux@latest` fails while
// `--prefer-online` and an exact pin both succeed, same machine, same moment.
//
// So: pin the exact target, and force fresh metadata. Falls back to `@latest` only if the caller
// somehow has no resolved version.
export async function applyUpdate(deps: ApplyUpdateDeps): Promise<ApplyUpdateResult> {
  if (deps.installMethod === 'npx') {
    throw new Error('cannot self-update an npx invocation — run `npx seshmux@latest` next time');
  }
  const exec = deps.exec ?? defaultExec;
  const previous = deps.current; // capture BEFORE install
  // target came off a registry HTTP response. defaultExec is execFile with an argv array (no
  // shell), so this can't be command injection, but an unvalidated string still reaches npm's
  // arg parser — a value like "--registry=…" or "../evil" has no business being there. Only a
  // plain semver may be pinned; anything else falls back to the tag.
  const version = /^\d+\.\d+\.\d+[A-Za-z0-9.\-+]*$/.test(deps.target ?? '') ? deps.target : null;
  const spec = `seshmux@${version ?? 'latest'}`;

  try {
    const { stdout, stderr } = await exec('npm', ['i', '-g', spec, '--prefer-online']);
    // TODO(wire): after ok, the server must broadcast {event:'server-restarting'} on the
    // events ws and exit 75 so bin/seshmux.js's relaunch loop starts the new version. That
    // choreography lives in the server/bin layer, not here — this fn only ran the install.
    return { ok: true, log: [stdout, stderr].filter(Boolean).join('\n'), previous };
  } catch (e) {
    const err = e as { message?: string; stdout?: string; stderr?: string };
    const log = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
    return { ok: false, log, previous };
  }
}

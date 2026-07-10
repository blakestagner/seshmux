// Session-store tailer (Task 16): chokidar watches both provider stores; on a
// debounced file change, re-read ctx and emit lifecycle events through an INJECTED
// emit callback. HARD RULE 3: no `~/.claude`/`~/.codex` path OR store-layout
// knowledge here — watch roots + per-provider depth/idsFromPath come from
// provider-exported config (claudeStoreRoot/claudeWatchConfig,
// codexStoreRoot/codexWatchConfig), or are supplied by the caller via
// deps.watchTargets. Adding a third provider means editing only its own module +
// this file's defaultWatchTargets() list — never this file's watch logic.
//
// chokidar v4+ dropped glob support (README "v4: remove glob support"), so each
// provider's "glob depth" is expressed as chokidar's `depth` option (subdirectory
// levels below the watched root), not a glob string.

import chokidar from 'chokidar';
import { claudeStoreRoot, claudeWatchConfig } from '../providers/claude';
import { codexStoreRoot, codexWatchConfig } from '../providers/codex';
import { getProviders } from '../providers/types';
import type { Ctx } from '../providers/types';
import type { ProviderId } from './scan';

// Per-provider watch shape, mirroring each provider's own exported *WatchConfig.
export interface ProviderWatchConfig {
  depth: number;
  idsFromPath(filePath: string): { sessionId: string; projectId: string };
}

export interface WatchTarget {
  root: string;
  provider: ProviderId;
  // Optional: tests pass a bare {root, provider} and rely on the provider's own
  // exported watch config (looked up by id below) — only a caller point at a
  // THIRD, not-yet-registered provider needs to supply this explicitly.
  config?: ProviderWatchConfig;
}

export type WatchEvent =
  | { event: 'session-new'; provider: ProviderId; sessionId: string; projectId: string }
  | { event: 'session-touch'; provider: ProviderId; sessionId: string; projectId: string }
  | { event: 'ctx'; provider: ProviderId; sessionId: string; projectId: string; ctx: Ctx | null };

export interface Watcher {
  close(): Promise<void>;
}

// Minimal shape we need from a chokidar FSWatcher — lets tests inject a plain
// EventEmitter instead of touching the real filesystem.
export interface ChokidarLike {
  on(event: 'add' | 'change', cb: (path: string) => void): unknown;
  close(): Promise<void>;
}

export type ChokidarFactory = (root: string, opts: Record<string, unknown>) => ChokidarLike;

export type ReadCtxFn = (filePath: string, provider: ProviderId) => Promise<Ctx | null>;

export interface WatchDeps {
  watchTargets?: WatchTarget[];
  emit: (event: WatchEvent) => void;
  readCtx?: ReadCtxFn;
  chokidarFactory?: ChokidarFactory;
}

const DEBOUNCE_MS = 300;

// Provider-exported root + watch-config helpers only (hard rule 3) — no store-layout
// literal duplicated here. Adding a third provider = export its own *StoreRoot +
// *WatchConfig and add one entry below; this file's logic never changes.
function defaultWatchTargets(): WatchTarget[] {
  return [
    { root: claudeStoreRoot(), provider: 'claude', config: claudeWatchConfig },
    { root: codexStoreRoot(), provider: 'codex', config: codexWatchConfig },
  ];
}

const configByProvider = new Map(defaultWatchTargets().map((t) => [t.provider, t.config]));

// Resolve readCtx for a provider via getProviders() — the registry of providers, each
// of which owns its own store root internally (hard rule 3: no path literal here).
async function defaultReadCtx(filePath: string, provider: ProviderId): Promise<Ctx | null> {
  const providers = await getProviders();
  const match = providers.find((p) => p.id === provider);
  if (!match) return null;
  const config = configByProvider.get(provider);
  if (!config) return null;
  const { sessionId, projectId } = config.idsFromPath(filePath);
  return match.readCtx(projectId, sessionId);
}

function defaultChokidarFactory(root: string, opts: Record<string, unknown>): ChokidarLike {
  return chokidar.watch(root, opts as any);
}

export function startWatching(deps: WatchDeps): Watcher {
  const targets = deps.watchTargets ?? defaultWatchTargets();
  const factory = deps.chokidarFactory ?? defaultChokidarFactory;
  const readCtx = deps.readCtx ?? defaultReadCtx;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  async function handle(filePath: string, provider: ProviderId, config: ProviderWatchConfig, kind: 'add' | 'change') {
    const { sessionId, projectId } = config.idsFromPath(filePath);
    // TODO(wire): connect `deps.emit` to the events websocket broadcast (later
    // lead-daemon/UI task) — this module only produces the events, it doesn't
    // know about any transport.
    deps.emit({
      event: kind === 'add' ? 'session-new' : 'session-touch',
      provider,
      sessionId,
      projectId,
    });
    const ctx = await readCtx(filePath, provider);
    deps.emit({ event: 'ctx', provider, sessionId, projectId, ctx });
  }

  function schedule(filePath: string, provider: ProviderId, config: ProviderWatchConfig, kind: 'add' | 'change') {
    const key = `${provider}:${filePath}`;
    const existing = pending.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(key);
      void handle(filePath, provider, config, kind);
    }, DEBOUNCE_MS);
    pending.set(key, timer);
  }

  const watchers: ChokidarLike[] = targets.map(({ root, provider, config: explicitConfig }) => {
    const config = explicitConfig ?? configByProvider.get(provider);
    if (!config) throw new Error(`no watch config for provider "${provider}" — pass one via watchTargets`);
    const w = factory(root, {
      depth: config.depth,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250 },
      ignored: (p: string, stats?: { isFile(): boolean }) =>
        !!stats?.isFile() && !p.endsWith('.jsonl'),
    });
    w.on('add', (path) => schedule(path, provider, config, 'add'));
    w.on('change', (path) => schedule(path, provider, config, 'change'));
    return w;
  });

  return {
    async close() {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      await Promise.all(watchers.map((w) => w.close()));
    },
  };
}

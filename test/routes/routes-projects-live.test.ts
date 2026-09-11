// GET /api/projects — the live-ledger gap-filler.
//
// A project is a cwd an agent has run in, and the stores are how that is normally known.
// They lag: Claude Code writes its transcript on the first MESSAGE, not at spawn, so
// "+ New project" left a live terminal running with nothing in the rail, which reads as
// the create having failed. The ledger answers that window.
//
// What these pin down is that it stays a GAP-filler: never a duplicate, never a temp dir,
// and never outranking the real scanned project.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let ledger: { ptyId: string; provider: string; cwd: string; label?: string; startedAt: number }[] = [];
let scanned: Record<string, unknown>[] = [];

vi.mock('../../server/lib/live-ledger', () => ({
  readEntries: async () => ledger,
}));

vi.mock('../../server/lib/providers/types', () => ({
  getProviders: async () => [{ id: 'claude', scanProjects: async () => scanned }],
}));

// The worktree fold, stubbed: the real one shells out to git. What matters here is that
// the route ASKS, because scan.ts rewrites a worktree project's path to its parent and
// so a worktree cwd appears in no Project.path to match against.
let worktreeParents: Record<string, string> = {};
vi.mock('../../server/lib/store/scan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/lib/store/scan')>()),
  derivedWorkspaceParent: (cwd: string) => worktreeParents[cwd] ?? null,
  worktreeParent: async (cwd: string) => worktreeParents[cwd] ?? null,
}));

const projectsRoutes = (await import('../../server/routes/projects')).default;

// An existing, non-temp directory: isTmpProject filters tmpdir, so a fixture under it
// would be dropped for the wrong reason and the test would pass while proving nothing.
const REAL_DIR = process.cwd();

const list = async () => {
  const f = Fastify();
  await f.register(projectsRoutes);
  const res = await f.inject({ method: 'GET', url: '/api/projects' });
  await f.close();
  return res.json() as {
    id: string;
    name: string;
    path: string;
    sessionCount: number;
    missing: boolean;
    live?: boolean;
  }[];
};

const entry = (cwd: string, over: Record<string, unknown> = {}) => ({
  ptyId: 'pty-1',
  provider: 'claude',
  cwd,
  startedAt: 1_700_000_000_000,
  ...over,
});

beforeEach(() => {
  ledger = [];
  scanned = [];
  worktreeParents = {};
});

describe('GET /api/projects — live sessions with no transcript yet', () => {
  it('lists a cwd an agent is running in before any session is recorded', async () => {
    ledger = [entry(REAL_DIR)];
    const out = await list();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path: REAL_DIR, sessionCount: 0, missing: false });
  });

  it('reports zero sessions rather than inventing one', async () => {
    // The rail shows liveness from the tab; a count of 1 would disagree with the
    // session list the moment the project is opened.
    ledger = [entry(REAL_DIR)];
    expect((await list())[0].sessionCount).toBe(0);
  });

  it('does not duplicate a project the store already knows', async () => {
    // Matched on cwd, not id: a store dirent's id need not agree with
    // encodeProjectId() on case (this machine has `c--Users-…-pokemon`), so an
    // id comparison listed the project twice as soon as an agent was live in it.
    scanned = [
      {
        id: 'C--dirent-CASED-differently',
        provider: 'claude',
        name: 'seshmux',
        path: REAL_DIR,
        sessionCount: 5,
        createdAt: 1,
        updatedAt: 2,
        missing: false,
      },
    ];
    ledger = [entry(REAL_DIR)];
    const out = await list();
    expect(out).toHaveLength(1);
    // and the SCANNED one wins — its real session count survives
    expect(out[0].sessionCount).toBe(5);
  });

  it('collapses two live sessions in one cwd into one project', async () => {
    ledger = [entry(REAL_DIR, { ptyId: 'pty-1' }), entry(REAL_DIR, { ptyId: 'pty-2' })];
    expect(await list()).toHaveLength(1);
  });

  it('matches a known project whose path is written with the other separator', async () => {
    // git hands back `C:/Users/…` while node's realpath gives `C:\Users\…`; both name
    // the same directory and must not become two rail rows.
    scanned = [
      {
        id: 'known',
        provider: 'claude',
        name: 'seshmux',
        path: REAL_DIR.replace(/\\/g, '/'),
        sessionCount: 5,
        createdAt: 1,
        updatedAt: 2,
        missing: false,
      },
    ];
    ledger = [entry(REAL_DIR)];
    expect(await list()).toHaveLength(1);
  });

  it('keeps temp-dir sessions out of the rail, same as scanned ones', async () => {
    ledger = [entry(join(tmpdir(), 'smx-probe-run'))];
    expect(await list()).toHaveLength(0);
  });

  it('marks a ledger cwd that is no longer on disk as missing', async () => {
    // A ledger entry can outlive its cwd (a removed worktree); the rail hides
    // missing projects, so the flag has to be honest rather than assumed false.
    ledger = [entry(join(REAL_DIR, 'no-such-dir-4f2a'))];
    const out = await list();
    expect(out).toHaveLength(1);
    expect(out[0].missing).toBe(true);
  });

  it('names the project after its folder', async () => {
    ledger = [entry(REAL_DIR)];
    expect((await list())[0].name).toBe('seshmux');
  });

  it('marks a live-only project so consumers can tell it from an empty one', async () => {
    // Every recorded count is 0, so the rail's provider filter and its "anything here
    // yet" empty state both need a flag to test — a count-only test drops the project
    // out of exactly the view this listing exists to populate.
    ledger = [entry(REAL_DIR)];
    expect((await list())[0].live).toBe(true);
  });

  it('does not mark a scanned project live', async () => {
    scanned = [
      {
        id: 'known',
        provider: 'claude',
        name: 'seshmux',
        path: REAL_DIR,
        sessionCount: 5,
        createdAt: 1,
        updatedAt: 2,
        missing: false,
      },
    ];
    expect((await list())[0].live).toBeUndefined();
  });
});

describe('GET /api/projects — worktree sessions', () => {
  const WORKTREE = join(REAL_DIR, '.claude', 'worktrees', 'feat-x');

  it('folds a live worktree session into its parent repo instead of sprouting a row', async () => {
    // scan.ts rewrites a worktree project's path to the PARENT ("no rail sprout of one
    // project group per workspace"), so the worktree cwd is in no Project.path and a
    // raw comparison could never match it — every live workspace grew a duplicate
    // top-level row named after its branch folder.
    scanned = [
      {
        id: 'known',
        provider: 'claude',
        name: 'seshmux',
        path: REAL_DIR,
        sessionCount: 5,
        createdAt: 1,
        updatedAt: 2,
        missing: false,
      },
    ];
    worktreeParents = { [WORKTREE]: REAL_DIR };
    ledger = [entry(WORKTREE)];
    const out = await list();
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe(REAL_DIR);
  });

  it('lists the PARENT when a worktree session is the only thing running there', async () => {
    worktreeParents = { [WORKTREE]: REAL_DIR };
    ledger = [entry(WORKTREE, { label: 'feat-x' })];
    const out = await list();
    expect(out).toHaveLength(1);
    // Named after the repo, not the branch folder the ledger's label carries.
    expect(out[0]).toMatchObject({ path: REAL_DIR, name: 'seshmux' });
  });
});

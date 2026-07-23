// Listening TCP ports owned by processes running INSIDE a project dir.
//
// Two lsof passes: one for LISTEN sockets (pid, command, addr), one for each
// pid's cwd. A process is "in the project" when its cwd is the project dir or
// below it — which is exactly what makes a monorepo work: `npm run dev` in
// apps/web has cwd apps/web, so the panel can label the port with the subdir
// that owns it without knowing anything about workspaces.
//
// ponytail: lsof-only (macOS/Linux). win32 returns [] — netstat gives no cwd,
// so there'd be nothing to attribute a port to. Add a win32 path (netstat -ano
// + a cwd probe) if anyone asks.

import { execFile } from 'node:child_process';
import path from 'node:path';

export interface PortEntry {
  port: number;
  pid: number;
  command: string;
  dir: string; // project-relative cwd ('' = project root)
}

function lsof(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('lsof', args, { timeout: 4000, maxBuffer: 4 << 20 }, (err, stdout) =>
      // lsof exits 1 when nothing matched — stdout is still the truth.
      resolve(err && !stdout ? '' : stdout),
    );
  });
}

// -F output is one field per line, tag char first, grouped by process:
//   p<pid> \n c<command> \n n<addr> [\n n<addr> …]
export function parseFields(out: string): { pid: number; command: string; names: string[] }[] {
  const rows: { pid: number; command: string; names: string[] }[] = [];
  let cur: { pid: number; command: string; names: string[] } | null = null;
  for (const line of out.split('\n')) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      cur = { pid: Number(val), command: '', names: [] };
      rows.push(cur);
    } else if (tag === 'c' && cur) cur.command = val;
    else if (tag === 'n' && cur) cur.names.push(val);
  }
  return rows;
}

// `*:3000`, `127.0.0.1:3000`, `[::1]:3000` → 3000
function portOf(name: string): number | null {
  const idx = name.lastIndexOf(':');
  if (idx === -1) return null;
  const n = Number(name.slice(idx + 1));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Kill the process listening on `port` inside `dir`.
 *
 * The client sends a pid, and this deliberately does NOT trust it: the pid is
 * only killed if listeningPorts() STILL reports that exact pid+port under this
 * project. Otherwise a stale panel row (or a crafted request) could signal any
 * process on the machine. SIGTERM only — a dev server gets to clean up, and
 * nothing here escalates to SIGKILL.
 */
export async function killPort(dir: string, port: number, pid: number): Promise<'ok' | 'not-found' | 'failed'> {
  const match = (await listeningPorts(dir)).some((p) => p.pid === pid && p.port === port);
  if (!match) return 'not-found';
  try {
    process.kill(pid, 'SIGTERM');
    return 'ok';
  } catch {
    return 'failed';
  }
}

export async function listeningPorts(dir: string): Promise<PortEntry[]> {
  if (process.platform === 'win32') return [];
  const listeners = parseFields(await lsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']));
  const pids = [...new Set(listeners.map((l) => l.pid))].filter(Boolean);
  if (pids.length === 0) return [];

  const cwdByPid = new Map<number, string>();
  for (const r of parseFields(await lsof(['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'])))
    if (r.names[0]) cwdByPid.set(r.pid, r.names[0]);

  const root = path.resolve(dir);
  const seen = new Set<string>();
  const out: PortEntry[] = [];
  for (const l of listeners) {
    const cwd = cwdByPid.get(l.pid);
    if (!cwd || (cwd !== root && !cwd.startsWith(root + path.sep))) continue;
    for (const name of l.names) {
      const port = portOf(name);
      if (port == null) continue;
      const key = `${port}:${l.pid}`; // IPv4+IPv6 of one server = one row
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ port, pid: l.pid, command: l.command, dir: path.relative(root, cwd) });
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir) || a.port - b.port);
}

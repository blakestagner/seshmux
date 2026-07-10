// POST /api/notify { title, body } → macOS `display notification` via osascript.
// osascript can't run in the browser, so the client posts here when a session
// needs input while the tab is hidden. Darwin-only (no-op elsewhere) and gated
// on the `macNotifications` config toggle.
//
// SECURITY: title/body are user/agent-derived. We build the AppleScript with the
// values as osascript `-e` VARIABLE bindings, never interpolated into the script
// string — so quotes/backslashes/newlines in a session title can't break out of
// the string or inject AppleScript. execFile (arg array, no shell) throughout.

import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

function configPath(): string {
  const dir = process.env.SESHMUX_CONFIG_DIR || path.join(os.homedir(), '.config', 'seshmux');
  return path.join(dir, 'config.json');
}

async function macNotificationsEnabled(): Promise<boolean> {
  try {
    const raw = await readFile(configPath(), 'utf8');
    const cfg = JSON.parse(raw);
    // default ON unless explicitly disabled (mirrors Settings.tsx).
    return cfg?.settings?.macNotifications !== false;
  } catch {
    return true; // no config yet → default on
  }
}

export default async function notifyRoutes(f: FastifyInstance) {
  f.post('/api/notify', async (req, reply) => {
    const body = (req.body ?? {}) as { title?: unknown; body?: unknown };
    const title = typeof body.title === 'string' ? body.title : '';
    const text = typeof body.body === 'string' ? body.body : '';
    if (!title && !text) return reply.code(400).send({ error: 'title or body required' });

    if (process.platform !== 'darwin') return { ok: true, delivered: false, reason: 'not-darwin' };
    if (!(await macNotificationsEnabled())) {
      return { ok: true, delivered: false, reason: 'disabled' };
    }

    // Bind title/body as AppleScript variables via -e, so the values are DATA,
    // never part of the script grammar. `system attribute` reads the env vars we
    // pass — keeping the values entirely out of the argv-parsed script text.
    await new Promise<void>((resolve) => {
      const child = execFile(
        'osascript',
        [
          '-e',
          'display notification (system attribute "SESHMUX_NOTIFY_BODY") with title (system attribute "SESHMUX_NOTIFY_TITLE")',
        ],
        {
          timeout: 3000,
          env: { ...process.env, SESHMUX_NOTIFY_TITLE: title || 'seshmux', SESHMUX_NOTIFY_BODY: text },
        },
        () => resolve(), // best-effort; a failed notification is non-fatal
      );
      child.on('error', () => resolve());
    });

    return { ok: true, delivered: true };
  });
}

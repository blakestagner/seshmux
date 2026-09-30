// AgentProvider.allSessionIds — the provider-layer check archive pruning relies on.
// It must be project-independent (a session that re-grouped still exists) and fail
// CLOSED: a throw whenever any part of the store can't be read, never a short set.
import { describe, it, expect, afterEach } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeProvider } from '../../server/lib/providers/claude';
import { CodexProvider } from '../../server/lib/providers/codex';

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ClaudeProvider.allSessionIds', () => {
  it('collects sessions from EVERY project dirent', async () => {
    const root = tmp('smx-cl-ids-');
    mkdirSync(join(root, 'proj-a'));
    mkdirSync(join(root, 'proj-w'));
    writeFileSync(join(root, 'proj-a', 'sess-a.jsonl'), '{}\n');
    writeFileSync(join(root, 'proj-w', 'sess-1.jsonl'), '{}\n');
    writeFileSync(join(root, 'proj-w', 'notes.txt'), 'x');
    const ids = await new ClaudeProvider({ root }).allSessionIds();
    expect(ids).toEqual(new Set(['sess-a', 'sess-1']));
  });

  it('throws (never a short set) when the store root cannot be read', async () => {
    const p = new ClaudeProvider({ root: join(tmp('smx-cl-missing-'), 'nope') });
    await expect(p.allSessionIds()).rejects.toThrow();
  });
});

describe('CodexProvider.allSessionIds', () => {
  const fixture = fileURLToPath(new URL('../fixtures/codex-sessions', import.meta.url));
  const ID = '019aebe9-51ba-7810-959a-6b8c07979e39';

  it('holds a rollout by its session id; not once it is gone', async () => {
    const root = tmp('smx-cx-ids-');
    cpSync(fixture, root, { recursive: true });
    const p = new CodexProvider(root);
    expect((await p.allSessionIds()).has(ID)).toBe(true);
    rmSync(join(root, '2026'), { recursive: true, force: true });
    expect((await p.allSessionIds()).has(ID)).toBe(false);
  });

  it('includes the session_meta payload.id even when the filename id differs', async () => {
    const root = tmp('smx-cx-payload-');
    mkdirSync(join(root, '2026', '07', '02'), { recursive: true });
    writeFileSync(
      join(root, '2026', '07', '02', 'rollout-2026-07-02T00-00-00-legacy.jsonl'),
      JSON.stringify({ timestamp: '2026-07-02T00:00:00Z', type: 'session_meta', payload: { id: 'payload-id-1', cwd: '/r' } }) + '\n',
    );
    expect((await new CodexProvider(root).allSessionIds()).has('payload-id-1')).toBe(true);
  });

  it('throws when the store root cannot be read', async () => {
    const p = new CodexProvider(join(tmp('smx-cx-missing-'), 'nope'));
    await expect(p.allSessionIds()).rejects.toThrow();
  });
});

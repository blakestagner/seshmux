import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseTranscript, readCtx } from '../../server/lib/store/transcript';

// fileURLToPath, not .pathname — see test/store/scan.test.ts for why the raw pathname
// doubles the drive letter on Windows.
const root = fileURLToPath(new URL('../fixtures', import.meta.url));
const projId = '-Users-demo-github-myrepo';
const WINDOW = 200_000; // caller (provider) supplies the window; tests stand in for claude.ts

describe('parseTranscript', () => {
  it('parses ordered messages and pairs tool_use with tool_result', async () => {
    const { msgs } = await parseTranscript(projId, 'aaaa-1111', root, WINDOW);
    // user, assistant(text), assistant(tool_use paired), assistant(text) — tool_result rows fold in.
    const roles = msgs.map((m) => m.role);
    expect(roles[0]).toBe('user');
    expect(msgs[0].text).toBe('fix the nav z-index bug');

    // Find the message carrying the Read tool call.
    const withTool = msgs.find((m) => m.tools.length > 0)!;
    expect(withTool.tools[0].name).toBe('Read');
    expect(withTool.tools[0].input).toContain('nav.css');
    expect(withTool.tools[0].output).toContain('z-index: 1');
  });

  it('computes ctx from last assistant usage', async () => {
    const { ctx } = await parseTranscript(projId, 'aaaa-1111', root, WINDOW);
    expect(ctx).not.toBeNull();
    expect(ctx!.tokens).toBe(188235);
    expect(ctx!.window).toBe(200000);
    expect(ctx!.pct).toBe(94);
    expect(ctx!.model).toBe('claude-opus-4-8');
  });
});

describe('readCtx', () => {
  it('tail-reads last assistant usage', async () => {
    const filePath = join(root, projId, 'aaaa-1111.jsonl');
    const ctx = await readCtx(filePath, WINDOW);
    expect(ctx).toMatchObject({ tokens: 188235, pct: 94, model: 'claude-opus-4-8' });
  });

  it('returns null when no assistant usage present', async () => {
    const filePath = join(root, '-Users-demo-github-other', 'no-usage.jsonl');
    const ctx = await readCtx(filePath, WINDOW);
    expect(ctx).toBeNull();
  });
});

describe('parseTranscript byte cap (BUG-C2)', () => {
  const tmpRoots: string[] = [];
  afterAll(() => {
    for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it('tail-caps a giant session: drops oldest history, keeps recent + correct ctx, flags truncated', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'seshmux-transcript-cap-'));
    tmpRoots.push(tmpRoot);
    const dir = join(tmpRoot, projId);
    mkdirSync(dir, { recursive: true });

    const lines: string[] = [];
    // First message carries a marker that must be DROPPED (it's in the oldest ~2MB).
    lines.push(JSON.stringify({
      type: 'user', message: { role: 'user', content: 'FIRST_MARKER_oldest' }, timestamp: '2026-07-05T10:00:00.000Z',
    }));
    // ~10MB of filler so the total exceeds the 8MB tail cap.
    const filler = 'x'.repeat(10_000);
    for (let i = 0; i < 1000; i++) {
      lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `filler ${i} ${filler}` }, timestamp: '2026-07-05T10:00:00.000Z' }));
    }
    // Recent message + the ctx-bearing assistant usage line, both near EOF (kept).
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: 'LAST_MARKER_recent' }, timestamp: '2026-07-05T11:00:00.000Z' }));
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 1234 }, content: [{ type: 'text', text: 'done' }] },
      timestamp: '2026-07-05T11:00:01.000Z',
    }));
    writeFileSync(join(dir, 'huge-1111.jsonl'), lines.join('\n') + '\n');

    const { msgs, ctx, truncated } = await parseTranscript(projId, 'huge-1111', tmpRoot, WINDOW);
    expect(truncated).toBe(true);
    const texts = msgs.map((m) => m.text);
    expect(texts.some((t) => t.includes('LAST_MARKER_recent'))).toBe(true); // newest kept
    expect(texts.some((t) => t.includes('FIRST_MARKER_oldest'))).toBe(false); // oldest dropped
    // ctx (last assistant usage, near EOF) survives the cap — not corrupted.
    expect(ctx?.tokens).toBe(1234);
  });

  it('does NOT flag truncated for a normal small session (whole file read)', async () => {
    const { truncated } = await parseTranscript(projId, 'aaaa-1111', root, WINDOW);
    expect(truncated).toBe(false);
  });
});

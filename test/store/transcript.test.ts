import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { parseTranscript, readCtx } from '../../server/lib/store/transcript';

const root = new URL('../fixtures', import.meta.url).pathname;
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

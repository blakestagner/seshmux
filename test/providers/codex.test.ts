import { describe, it, expect } from 'vitest';
import { CodexProvider } from '../../server/lib/providers/codex';

const root = new URL('../fixtures/codex-sessions', import.meta.url).pathname;

// A project id is the dash-encoded cwd, matching the claude scheme so the same repo
// path merges across providers in Task 7.
const PROJ_ID = '-Users-demo-github-myrepo';

describe('CodexProvider.scanProjects', () => {
  it('groups sessions by cwd into a decoded project', async () => {
    const cx = new CodexProvider(root);
    const ps = await cx.scanProjects();
    const p = ps.find((x) => x.id === PROJ_ID)!;
    expect(p).toBeDefined();
    expect(p).toMatchObject({ name: 'myrepo', path: '/Users/demo/github/myrepo', provider: 'codex' });
    expect(p.sessionCount).toBe(1);
  });
});

describe('CodexProvider.listSessions', () => {
  it('extracts title from first event_msg user_message and branch from git', async () => {
    const cx = new CodexProvider(root);
    const ss = await cx.listSessions(PROJ_ID);
    expect(ss).toHaveLength(1);
    const s = ss[0];
    expect(s.id).toBe('bbbb-2222');
    expect(s.title).toBe('add a codex feature');
    expect(s.branch).toBe('feat/codex');
    expect(s.provider).toBe('codex');
  });
});

describe('CodexProvider.parseTranscript', () => {
  it('parses messages and pairs function_call with output', async () => {
    const cx = new CodexProvider(root);
    const { msgs, ctx } = await cx.parseTranscript(PROJ_ID, 'bbbb-2222');
    expect(msgs[0]).toMatchObject({ role: 'user', text: 'add a codex feature' });
    const withTool = msgs.find((m) => m.tools.length > 0)!;
    expect(withTool.tools[0].name).toBe('exec_command');
    expect(withTool.tools[0].input).toContain('ls src');
    expect(withTool.tools[0].output).toContain('feature.ts');
    expect(ctx).not.toBeNull();
    expect(ctx!.tokens).toBe(129200);
    expect(ctx!.window).toBe(258400);
    expect(ctx!.pct).toBe(50);
    expect(ctx!.model).toBe('gpt-5.4-mini');
  });
});

describe('CodexProvider.readCtx / commands', () => {
  it('reads ctx and exposes resume commands without a plan mode', async () => {
    const cx = new CodexProvider(root);
    const ctx = await cx.readCtx(PROJ_ID, 'bbbb-2222');
    expect(ctx).toMatchObject({ tokens: 129200, window: 258400, model: 'gpt-5.4-mini' });

    expect(cx.commands.fresh('/tmp/x')).toEqual(['codex']);
    expect(cx.commands.continue('/tmp/x')).toEqual(['codex', 'resume', '--last']);
    expect(cx.commands.resume('/tmp/x', 'bbbb-2222')).toEqual(['codex', 'resume', '--', 'bbbb-2222']);
    expect(cx.commands.plan).toBeUndefined();

    // Flag-proof: a hostile id starting with `-` sits AFTER the `--` separator, so it can
    // never parse as a flag (defense-in-depth atop route-layer validation).
    const evil = cx.commands.resume('/tmp/x', '--dangerously-bypass-approvals-and-sandbox');
    expect(evil[evil.length - 2]).toBe('--');
    expect(evil[evil.length - 1]).toBe('--dangerously-bypass-approvals-and-sandbox');
  });
});

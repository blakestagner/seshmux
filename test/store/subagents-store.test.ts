import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { listSubagentNodes, parseSubagentDetail } from '../../server/lib/store/subagents';
import { ClaudeProvider } from '../../server/lib/providers/claude';
import { CodexProvider } from '../../server/lib/providers/codex';
import type { AgentProvider } from '../../server/lib/providers/types';

const FIX = join(__dirname, '../fixtures/subagents');

describe('listSubagentNodes', () => {
  it('reads plain-task meta into a node (label=description, agentType, status done)', async () => {
    const nodes = await listSubagentNodes(join(FIX, 'plain-general/session'));
    const n = nodes.find((x) => x.agentType === 'general-purpose')!;
    expect(n).toBeTruthy();
    expect(n.label).toBe('Compare .claude dir organization');
    expect(n.status).toBe('done');
    expect(n.parentId).toBeNull();
  });

  it('marks stoppedByUser agents as error', async () => {
    const nodes = await listSubagentNodes(join(FIX, 'plain-explore-interrupted/session'));
    expect(nodes[0].status).toBe('error');
  });

  it('nests fork agents via parentAgentId', async () => {
    const nodes = await listSubagentNodes(join(FIX, 'fork-nested/session'));
    expect(nodes.find((x) => x.agentType === 'fork')!.parentId).toBe('a9ad6b105b407a1e8');
  });

  it('enriches workflow agents from workflowProgress (label, phaseTitle→group, tokens, model)', async () => {
    const nodes = await listSubagentNodes(join(FIX, 'workflow/session'));
    const n = nodes.find((x) => x.id === 'a15a679e3d250c5d6')!;
    expect(n.label).toBe('impl:t1:r1');
    expect(n.group).toBe('Task 1: Codex discovery');
    expect(n.tokens).toBe(77400);
    expect(n.model).toBe('claude-sonnet-5');
  });

  it('never throws on a missing subagents dir (returns [])', async () => {
    expect(await listSubagentNodes(join(FIX, 'does-not-exist'))).toEqual([]);
  });
});

describe('parseSubagentDetail', () => {
  it('extracts prompt (first-line string), activity (tool_use), outcome (last assistant text)', async () => {
    const nodes = await listSubagentNodes(join(FIX, 'plain-general/session'));
    const node = nodes.find((x) => x.agentType === 'general-purpose')!;
    const d = await parseSubagentDetail(node.jsonlPath ?? '', node);
    expect(d.prompt.length).toBeGreaterThan(0);
    expect(d.activity[0]).toHaveProperty('tool');
    expect(d.activity[0]).toHaveProperty('summary');
    expect(['json', 'text']).toContain(d.outcome.kind);
    expect(typeof d.outcome.raw).toBe('string');
  });

  it('tolerates a truncated trailing line without throwing', async () => {
    const nodes = await listSubagentNodes(join(FIX, 'truncated/session'));
    const node = nodes[0];
    await expect(parseSubagentDetail(node.jsonlPath ?? '', node)).resolves.toBeTruthy();
  });
});

describe('provider subagents capability', () => {
  // Fixture layout is <root>/<projectId>/<sessionId>/subagents/... — point the provider
  // root at the fixtures dir so <root>/plain-general/session/subagents resolves.
  it('ClaudeProvider.subagents.list returns nodes for a fixture session', async () => {
    const claude = new ClaudeProvider({ root: FIX });
    const nodes = await claude.subagents!.list('plain-general', 'session');
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.find((n) => n.agentType === 'general-purpose')).toBeTruthy();
  });

  it('ClaudeProvider.subagents.detail resolves a node by id (and 404s unknown as null)', async () => {
    const claude = new ClaudeProvider({ root: FIX });
    const nodes = await claude.subagents!.list('plain-general', 'session');
    const id = nodes[0].id;
    const d = await claude.subagents!.detail('plain-general', 'session', id);
    expect(d).toBeTruthy();
    expect(d!.node.id).toBe(id);
    expect(await claude.subagents!.detail('plain-general', 'session', 'nope')).toBeNull();
  });

  it('CodexProvider omits the subagents capability (chip never shows)', () => {
    const codex: AgentProvider = new CodexProvider();
    expect(codex.subagents).toBeUndefined();
  });

  // SEC-3: projectId is gated against the scanned project list and sessionId is
  // separator-checked before the absolute ~/.claude join — a traversal or unknown
  // project reads nothing.
  it('refuses a traversal / unknown projectId and a traversal sessionId (SEC-3)', async () => {
    const claude = new ClaudeProvider({ root: FIX });
    expect(await claude.subagents!.list('../plain-general', 'session')).toEqual([]);
    expect(await claude.subagents!.list('not-a-real-project', 'session')).toEqual([]);
    expect(await claude.subagents!.list('plain-general', '../session')).toEqual([]);
    expect(await claude.subagents!.detail('../plain-general', 'session', 'x')).toBeNull();
    expect(await claude.subagents!.detail('plain-general', '../session', 'x')).toBeNull();
  });
});

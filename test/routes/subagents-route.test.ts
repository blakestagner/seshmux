import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import subagentRoutes from '../../server/routes/subagents';
import type { SubagentDetail, SubagentNode, SubagentSupport } from '../../server/lib/providers/types';

// A fake SubagentSupport so the route is tested in isolation (no ~/.claude, no real provider).
// One node carries jsonlPath to prove the route strips it before responding.
const NODES: SubagentNode[] = [
  {
    id: 'a1',
    parentId: null,
    label: 'root agent',
    agentType: 'general-purpose',
    group: null,
    model: 'claude-sonnet-5',
    status: 'done',
    tokens: 100,
    toolCalls: 3,
    startedAt: 1,
    endedAt: 2,
    jsonlPath: '/Users/secret/.claude/projects/p/s/subagents/agent-a1.jsonl',
  },
  {
    id: 'a2',
    parentId: 'a1',
    label: 'child',
    agentType: 'fork',
    group: null,
    model: null,
    status: 'running',
    tokens: null,
    toolCalls: null,
    startedAt: null,
    endedAt: null,
    jsonlPath: '/Users/secret/.claude/projects/p/s/subagents/agent-a2.jsonl',
  },
];

const DETAIL: SubagentDetail = {
  node: NODES[0],
  prompt: 'do the thing',
  activity: [{ tool: 'Bash', summary: 'ls' }],
  outcome: { raw: '{"summary":"ok"}', kind: 'json' },
};

const fakeSupport: SubagentSupport = {
  list: async () => NODES,
  detail: async (_p, _s, agent) => (agent === 'a1' ? DETAIL : null),
};

function makeApp(support: SubagentSupport | null, onOpen?: (p: string, s: string) => void) {
  const f = Fastify();
  f.register(subagentRoutes, { support: async () => support, onOpen });
  return f;
}

describe('GET /api/subagents', () => {
  it('returns the node list from the injected support', async () => {
    const f = makeApp(fakeSupport);
    const res = await f.inject({ method: 'GET', url: '/api/subagents?project=p&session=s' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodes).toHaveLength(2);
    expect(body.nodes[0].id).toBe('a1');
    expect(body.nodes[1].parentId).toBe('a1');
  });

  it('NEVER leaks jsonlPath (absolute ~/.claude path) to the client', async () => {
    const f = makeApp(fakeSupport);
    const res = await f.inject({ method: 'GET', url: '/api/subagents?project=p&session=s' });
    for (const n of res.json().nodes) {
      expect(n.jsonlPath).toBeUndefined();
    }
    expect(res.payload).not.toContain('.claude');
  });

  it('fires onOpen on first tree-open (lazy watch start)', async () => {
    let opened: [string, string] | null = null;
    const f = makeApp(fakeSupport, (p, s) => {
      opened = [p, s];
    });
    await f.inject({ method: 'GET', url: '/api/subagents?project=p&session=s' });
    expect(opened).toEqual(['p', 's']);
  });

  it('returns nodes:[] when the provider lacks a subagents capability', async () => {
    const f = makeApp(null);
    const res = await f.inject({ method: 'GET', url: '/api/subagents?project=p&session=s' });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes).toEqual([]);
  });
});

describe('GET /api/subagents/detail', () => {
  it('returns the detail for a known agent (with jsonlPath stripped from node)', async () => {
    const f = makeApp(fakeSupport);
    const res = await f.inject({
      method: 'GET',
      url: '/api/subagents/detail?project=p&session=s&agent=a1',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.prompt).toBe('do the thing');
    expect(body.activity[0].tool).toBe('Bash');
    expect(body.node.jsonlPath).toBeUndefined();
    expect(res.payload).not.toContain('secret');
  });

  it('404s for an unknown agent id', async () => {
    const f = makeApp(fakeSupport);
    const res = await f.inject({
      method: 'GET',
      url: '/api/subagents/detail?project=p&session=s&agent=nope',
    });
    expect(res.statusCode).toBe(404);
  });
});

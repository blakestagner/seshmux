import { describe, it, expect } from 'vitest';
import { composeBrief, composeDiffReview } from '../../server/lib/bridge/brief';

// A fake provider stands in for the real registry — composeBrief must be provider-agnostic
// and take its transcript from whatever provider owns the session. We feed a known
// transcript so assertions are deterministic (mirrors the claude aaaa-1111 fixture shape).
const fakeTranscript = {
  msgs: [
    { role: 'user' as const, text: 'fix the nav z-index bug', tools: [], ts: 1 },
    {
      role: 'assistant' as const,
      text: "I'll inspect the CSS.",
      tools: [{ name: 'Read', input: '{"file_path":"nav.css"}', output: '.nav { z-index: 1; }' }],
      ts: 2,
    },
    {
      role: 'assistant' as const,
      text: 'Raising z-index to 1000 fixes it. Still need to test mobile.',
      tools: [{ name: 'Edit', input: '{"file_path":"assets/nav.css"}', output: 'ok' }],
      ts: 3,
    },
  ],
  ctx: { tokens: 100, window: 200000, pct: 0, model: 'claude-opus-4-8' },
  meta: {
    id: 'aaaa-1111',
    provider: 'claude' as const,
    projectId: '-Users-demo-github-myrepo',
    title: 'fix the nav z-index bug',
    branch: 'fix/nav-zindex',
    mtime: 3,
    startedAt: 1,
    durationMs: 2,
    live: false,
  },
};

const loadTranscript = async () => fakeTranscript;

describe('composeBrief', () => {
  it('produces a markdown brief with task, files touched, remaining work; under 4KB', async () => {
    const brief = await composeBrief('-Users-demo-github-myrepo', 'aaaa-1111', { loadTranscript });

    expect(brief).toContain('fix the nav z-index bug'); // task = session title
    // files touched come from tool_use file_path inputs
    expect(brief).toContain('nav.css');
    expect(brief).toContain('assets/nav.css');
    // tool calls collapsed to one line each (name shows up, not full raw JSON blobs)
    expect(brief).toMatch(/Read|Edit/);
    // remaining-work heuristic = last assistant message
    expect(brief.toLowerCase()).toContain('test mobile');
    // size guard
    expect(Buffer.byteLength(brief, 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('caps at the last ~15 messages', async () => {
    const many = {
      ...fakeTranscript,
      msgs: Array.from({ length: 40 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        text: `message number ${i}`,
        tools: [],
        ts: i,
      })),
    };
    const brief = await composeBrief('p', 's', { loadTranscript: async () => many });
    expect(brief).toContain('message number 39'); // newest kept
    expect(brief).not.toContain('message number 5'); // old dropped
    expect(Buffer.byteLength(brief, 'utf8')).toBeLessThanOrEqual(4096);
  });
});

describe('composeDiffReview', () => {
  it('embeds the git diff and adversarial review instructions', async () => {
    const fakeDiff = async () => 'diff --git a/nav.css b/nav.css\n+.nav { z-index: 1000; }';
    const review = await composeDiffReview('-Users-demo-github-myrepo', 'aaaa-1111', {
      loadTranscript,
      gitDiff: fakeDiff,
    });
    expect(review).toContain('z-index: 1000'); // the diff
    expect(review.toLowerCase()).toMatch(/review|adversarial|critique/); // instructions
    expect(review).toContain('fix/nav-zindex'); // branch context
  });

  it('handles an empty diff without crashing', async () => {
    const review = await composeDiffReview('p', 's', {
      loadTranscript,
      gitDiff: async () => '',
    });
    expect(review.toLowerCase()).toContain('no'); // "no changes" / "no diff"
  });
});

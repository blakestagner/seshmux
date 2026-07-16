import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parseTranscriptFile, type Msg } from '../../server/lib/store/transcript';
import { extractPrs } from '../../server/lib/store/prs';

// fileURLToPath, NOT new URL(...).pathname: on Windows the latter yields
// `/C:/Users/...`, which path.join turns into a broken `C:\C:\...` and the
// fixture can't be read (returns [] — a silent Windows-only failure).
const fixture = fileURLToPath(new URL('../fixtures/prs/cccc-3333.jsonl', import.meta.url));

function msg(partial: Partial<Msg>): Msg {
  return { role: 'assistant', text: '', tools: [], ts: 0, ...partial };
}

describe('extractPrs', () => {
  it('extracts the created PR (with --title) from a real-shaped claude transcript', async () => {
    const { msgs } = await parseTranscriptFile(fixture, 200_000);
    const prs = extractPrs(msgs);
    // pull/99 (gh pr view) and pull/7 (plain mention) are NOT created here.
    expect(prs).toEqual([
      {
        url: 'https://github.com/acme/webapp/pull/12',
        owner: 'acme',
        repo: 'webapp',
        number: 12,
        title: 'fix: nav z-index',
      },
    ]);
  });

  it('handles codex-style stringified shell function calls', () => {
    const prs = extractPrs([
      msg({
        tools: [
          {
            name: 'shell',
            input: '{"command":["bash","-lc","gh pr create --title \\"feat: dark mode\\" --fill"]}',
            output: 'https://github.com/acme/webapp/pull/34\n',
          },
        ],
      }),
    ]);
    expect(prs).toEqual([
      {
        url: 'https://github.com/acme/webapp/pull/34',
        owner: 'acme',
        repo: 'webapp',
        number: 34,
        title: 'feat: dark mode',
      },
    ]);
  });

  it('catches PRs created via an agent/subagent tool and dedupes with assistant text', () => {
    const prs = extractPrs([
      msg({
        tools: [
          {
            name: 'Agent',
            input: '{"description":"create PR","prompt":"Create a pull request for this branch"}',
            output: 'Opened https://github.com/acme/tools/pull/5 with the branch diff.',
          },
        ],
      }),
      msg({ text: 'Created https://github.com/acme/tools/pull/5.' }),
    ]);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ owner: 'acme', repo: 'tools', number: 5 });
  });

  it('catches a PR opened via the create-pr subagent ("Open a GitHub PR" prompt)', () => {
    const prs = extractPrs([
      msg({
        tools: [
          {
            name: 'Agent',
            input:
              '{"description":"Open PR for branch","prompt":"Open a GitHub PR for branch feat/x, base main. Push the branch first, then open the PR with gh."}',
            output: 'PR created: https://github.com/acme/webapp/pull/56',
          },
        ],
      }),
    ]);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ owner: 'acme', repo: 'webapp', number: 56 });
  });

  it('canonicalizes URL variants (trailing paths/fragments) into one entry', () => {
    const prs = extractPrs([
      msg({ text: 'Created https://github.com/acme/webapp/pull/8/files just now.' }),
      msg({ text: 'Opened https://github.com/acme/webapp/pull/8#issuecomment-1 too.' }),
    ]);
    expect(prs).toEqual([
      { url: 'https://github.com/acme/webapp/pull/8', owner: 'acme', repo: 'webapp', number: 8 },
    ]);
  });

  it('ignores PRs that were only mentioned, viewed, or reviewed', () => {
    const prs = extractPrs([
      msg({ role: 'user', text: 'please review https://github.com/acme/webapp/pull/40' }),
      msg({ text: 'Looking at https://github.com/acme/webapp/pull/40 now.' }),
      msg({
        tools: [
          {
            name: 'Bash',
            input: '{"command":"gh pr view 40 --json title"}',
            output: 'https://github.com/acme/webapp/pull/40',
          },
        ],
      }),
    ]);
    expect(prs).toEqual([]);
  });

  it('returns multiple distinct created PRs in first-seen order', () => {
    const prs = extractPrs([
      msg({
        tools: [
          { name: 'Bash', input: 'gh pr create --fill', output: 'https://github.com/acme/a/pull/1' },
          { name: 'Bash', input: 'gh pr create --fill', output: 'https://github.com/acme/b/pull/2' },
        ],
      }),
    ]);
    expect(prs.map((p) => p.url)).toEqual([
      'https://github.com/acme/a/pull/1',
      'https://github.com/acme/b/pull/2',
    ]);
  });
});

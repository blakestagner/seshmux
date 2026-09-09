// readForward + AgentProvider.harvestFrom: the resumable FORWARD read the memory harvester
// walks a session with. The property under test throughout is that slicing a file into N
// reads yields exactly what one whole read yields — no duplicated line, no dropped line, no
// character split across a slice boundary.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readForward } from '../../server/lib/store/transcript';
import { ClaudeProvider } from '../../server/lib/providers/claude';

// fileURLToPath, never new URL(...).pathname — the latter doubles the drive letter on win32.
const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smx-fwd-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Drain a file through readForward in `chunk`-byte slices, returning every line seen. */
async function drain(file: string, chunk: number): Promise<{ lines: string[]; reads: number }> {
  const lines: string[] = [];
  let offset = 0;
  let reads = 0;
  for (;;) {
    const slice = await readForward(file, offset, chunk);
    reads++;
    lines.push(...slice.lines);
    if (slice.done) break;
    if (slice.nextOffset === offset && slice.lines.length === 0) break; // stalled: no progress
    offset = slice.nextOffset;
    if (reads > 500) throw new Error('readForward failed to terminate');
  }
  return { lines, reads };
}

describe('readForward', () => {
  it('returns nothing for a file that does not exist', async () => {
    const s = await readForward(join(dir, 'nope.jsonl'), 0, 1024);
    expect(s).toEqual({ lines: [], nextOffset: 0, done: true });
  });

  it('reads a whole small file in one slice', async () => {
    const f = join(dir, 'a.jsonl');
    writeFileSync(f, 'one\ntwo\nthree\n');
    const s = await readForward(f, 0, 1024);
    expect(s.lines).toEqual(['one', 'two', 'three']);
    expect(s.done).toBe(true);
  });

  it('never returns a partial trailing line', async () => {
    // "three" has no terminator yet — it is still being written.
    const f = join(dir, 'a.jsonl');
    writeFileSync(f, 'one\ntwo\nthree');
    const s = await readForward(f, 0, 1024);
    expect(s.lines).toEqual(['one', 'two']);
    // nextOffset sits at the start of the incomplete line, so the next read picks it up whole.
    expect(s.nextOffset).toBe('one\ntwo\n'.length);
  });

  it('resumes exactly where it left off when the file grows', async () => {
    const f = join(dir, 'a.jsonl');
    writeFileSync(f, 'one\ntwo\n');
    const first = await readForward(f, 0, 1024);
    expect(first.lines).toEqual(['one', 'two']);

    appendFileSync(f, 'three\nfour\n');
    const second = await readForward(f, first.nextOffset, 1024);
    expect(second.lines).toEqual(['three', 'four']); // no re-delivery of one/two
  });

  it('slicing yields the same lines as one whole read', async () => {
    const f = join(dir, 'a.jsonl');
    const source = Array.from({ length: 200 }, (_, i) => `line-${i}`);
    writeFileSync(f, source.join('\n') + '\n');
    const whole = await drain(f, 1 << 20);
    const sliced = await drain(f, 40); // forces many boundary cuts
    expect(sliced.reads).toBeGreaterThan(5);
    expect(sliced.lines).toEqual(whole.lines);
    expect(sliced.lines).toEqual(source);
  });

  it('never splits a multi-byte character across a slice boundary', async () => {
    // The cut is placed at a newline BYTE, so a 3-byte character straddling the nominal
    // maxBytes edge is still decoded whole.
    const f = join(dir, 'a.jsonl');
    const source = Array.from({ length: 60 }, (_, i) => `行${i}—é`);
    writeFileSync(f, source.join('\n') + '\n');
    const { lines } = await drain(f, 17); // deliberately not aligned to any char width
    expect(lines).toEqual(source);
    expect(lines.join('')).not.toContain('�'); // no replacement chars
  });

  it('restarts from the top when the file shrank under it', async () => {
    // A rotated/rewritten file must not be read from a now-meaningless offset.
    const f = join(dir, 'a.jsonl');
    writeFileSync(f, 'a\nb\nc\nd\ne\n');
    writeFileSync(f, 'x\n');
    const s = await readForward(f, 8, 1024);
    expect(s.lines).toEqual(['x']);
  });

  it('waits rather than skipping when one long line is still being written', async () => {
    const f = join(dir, 'a.jsonl');
    writeFileSync(f, 'x'.repeat(50)); // no newline, shorter than the ask
    const s = await readForward(f, 0, 1024);
    expect(s.lines).toEqual([]);
    expect(s.nextOffset).toBe(0); // stayed put — the line may still be completed
    expect(s.done).toBe(true);
  });

  it('grows the window to deliver a line longer than maxBytes rather than dropping it', async () => {
    // A single 300KB tool-result line is ordinary in a real transcript. It must survive the
    // slicing intact, not be skipped as "oversized".
    const f = join(dir, 'a.jsonl');
    const long = 'x'.repeat(5000);
    writeFileSync(f, `before\n${long}\nafter\n`);
    const { lines } = await drain(f, 100);
    expect(lines).toEqual(['before', long, 'after']);
  });
});

describe('ClaudeProvider.harvestFrom', () => {
  const provider = new ClaudeProvider({ root: FIXTURES });

  it('yields the same messages as parseTranscript for a whole-file read', async () => {
    const whole = await provider.parseTranscript('-Users-demo-github-myrepo', 'aaaa-1111');
    const harvested = await provider.harvestFrom('-Users-demo-github-myrepo', 'aaaa-1111', 0, 1 << 20);
    expect(harvested.msgs).toEqual(whole.msgs);
    expect(harvested.done).toBe(true);
  });

  it('accumulates the same messages across many small slices', async () => {
    // The harvester's real mode: bounded slices, offset carried between calls.
    const whole = await provider.parseTranscript('-Users-demo-github-myrepo', 'aaaa-1111');
    const msgs = [];
    let offset = 0;
    for (let i = 0; i < 200; i++) {
      const slice = await provider.harvestFrom('-Users-demo-github-myrepo', 'aaaa-1111', offset, 256);
      msgs.push(...slice.msgs);
      if (slice.done) break;
      if (slice.nextOffset === offset) break;
      offset = slice.nextOffset;
    }
    // Slicing splits tool_use from its later tool_result, so outputs may be unpaired; the
    // message spine itself must still match exactly.
    expect(msgs.map((m) => [m.role, m.text])).toEqual(whole.msgs.map((m) => [m.role, m.text]));
  });

  it('returns an empty done slice for an unknown session', async () => {
    const s = await provider.harvestFrom('-Users-demo-github-myrepo', 'no-such-session', 0, 1024);
    expect(s).toEqual({ msgs: [], nextOffset: 0, done: true });
  });

  it('refuses a traversal id without reading anything', async () => {
    const s = await provider.harvestFrom('..', '../../etc/passwd', 0, 1024);
    expect(s.msgs).toEqual([]);
    expect(s.done).toBe(true);
  });
});

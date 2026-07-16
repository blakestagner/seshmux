import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  classify,
  classifyExplain,
  initState,
  readHookStatus,
  readHookStatusDetail,
  stripAnsi,
  type NIState,
} from '../../server/lib/needs-input';
import { ClaudeProvider } from '../../server/lib/providers/claude';
import { CodexProvider } from '../../server/lib/providers/codex';

// fileURLToPath, not .pathname — see test/store/scan.test.ts for why the raw pathname
// doubles the drive letter on Windows.
const fx = (name: string) => readFileSync(join(fileURLToPath(new URL('../fixtures/tui', import.meta.url)), name), 'utf8');

// RAW fixtures (ANSI intact) — classify must strip ANSI itself, so matching raw bytes proves
// the real daemon pipeline (raw PTY bytes) works, not a pre-stripped stand-in.
const claudePermission = fx('claude-permission.raw');
const claudeWorking = fx('claude-working.raw');
const codexTrust = fx('codex-trust-and-boot.raw');
// Captured live from a real daemon PTY (pty-26, 2026-07-15): the --resume
// "Resume from summary / Enter to confirm · Esc to cancel" prompt. Claude's
// renderer draws the SPACES as cursor-forward escapes (`Esc<ESC>[Cto<ESC>[Ccancel`),
// so stripAnsi must translate CSI-C to a space or "Esc to cancel" never matches.
const claudeResumePrompt = fx('claude-resume-prompt.raw');

const claudeWaiting = new ClaudeProvider().needsInputPatterns;
const codexWaiting = new CodexProvider().needsInputPatterns;

describe('classify — working detection wins (live output)', () => {
  it('classifies a claude working spinner frame as working', () => {
    const s = initState(0);
    const status = classify(claudeWorking, s, claudeWaiting);
    expect(status).toBe('working'); // "esc to interrupt" / ticking spinner present
  });

  it('refreshes lastActivityTs on any output (so silence is measured from last frame)', () => {
    const s = initState(0);
    s.now = () => 1000;
    classify('some output', s, claudeWaiting);
    expect(s.lastActivityTs).toBe(1000);
  });
});

describe('classify — waiting detection (permission / question prompts)', () => {
  it('classifies a claude permission prompt as waiting', () => {
    const s = initState(0);
    // A permission prompt is drawn once then output stops — feed it as the latest frame.
    const status = classify(claudePermission, s, claudeWaiting);
    expect(status).toBe('waiting');
  });

  it('classifies the claude resume-from-summary prompt as waiting (cursor-forward spaces)', () => {
    const s = initState(0);
    const status = classify(claudeResumePrompt, s, claudeWaiting);
    expect(status).toBe('waiting');
    // and a repaint-less silence tick keeps it waiting, never working/idle
    s.now = () => 60_000;
    expect(classify('', s, claudeWaiting)).toBe('waiting');
  });

  it('classifies the codex trust prompt as waiting', () => {
    const s = initState(0);
    const status = classify(codexTrust, s, codexWaiting);
    // codexTrust holds the trust prompt ("Do you trust…" / "1. Yes, continue") then a live
    // boot spinner; if the working footer is present it may read working — accept either
    // input-needed OR working, but NEVER idle for this active frame.
    expect(status === 'waiting' || status === 'working').toBe(true);
  });
});

describe('classify — >20s silence → idle', () => {
  it('goes idle when no output has arrived for >20s after a non-prompt frame', () => {
    const s: NIState = initState(0);
    let t = 0;
    s.now = () => t;
    classify('just some plain assistant text with no prompt and no spinner', s, claudeWaiting);
    t = 21_000; // 21s later, a bare tick (empty chunk) with no new output
    const status = classify('', s, claudeWaiting);
    expect(status).toBe('idle');
  });

  it('stays waiting (not idle) if the last frame held a prompt, even after silence', () => {
    const s: NIState = initState(0);
    let t = 0;
    s.now = () => t;
    classify(claudePermission, s, claudeWaiting);
    t = 30_000;
    const status = classify('', s, claudeWaiting);
    expect(status).toBe('waiting'); // a blocked prompt is still waiting, not idle
  });
});

describe('classify — sticky waiting (spinner redrawn over an open prompt)', () => {
  // Repro (from lead-daemon live e2e): claude opens a permission prompt (→waiting), then ~6s
  // later redraws its background spinner ("Cooking… (16s) · esc to interrupt") OVER the still-
  // open "❯ 1. Yes / 2. / 3. No" prompt. The spinner lands later in the buffer, so a naive
  // "working wins by position" flips waiting→working while the user is still being asked.
  const promptFrame = 'Do you want to create NEWFILE.txt? ❯ 1. Yes 2. Yes, allow all 3. No  Esc to cancel · Tab to amend';
  const spinnerOverPrompt =
    'Do you want to create NEWFILE.txt? ❯ 1. Yes 2. Yes, allow all 3. No  Esc to cancel · Tab to amend  Cooking… (16s · thinking) esc to interrupt';
  const spinnerOnly = 'Cooking… (18s · thinking with high effort) esc to interrupt';

  it('stays waiting when a spinner is redrawn over a still-open prompt', () => {
    const s = initState(0);
    expect(classify(promptFrame, s, claudeWaiting)).toBe('waiting');
    // spinner now trails the prompt in the buffer — must NOT flip to working.
    expect(classify(spinnerOverPrompt, s, claudeWaiting)).toBe('waiting');
    expect(classify(spinnerOverPrompt, s, claudeWaiting)).toBe('waiting'); // still sticky
  });

  it('leaves waiting once the prompt chrome is gone (user answered → pure spinner)', () => {
    const s = initState(0);
    classify(promptFrame, s, claudeWaiting);
    classify(spinnerOverPrompt, s, claudeWaiting); // still waiting
    // prompt dismissed → only the spinner remains → back to working.
    expect(classify(spinnerOnly, s, claudeWaiting)).toBe('working');
  });
});

describe('classify — idle repaint (click-a-done-agent flip) does not re-arm', () => {
  it('a repaint of a finished screen stays idle and does not reset the silence clock', () => {
    const s = initState(0);
    let t = 0;
    s.now = () => t;
    classify('assistant text, turn finished', s, claudeWaiting); // working, arms at 0
    t = 25_000;
    expect(classify('', s, claudeWaiting)).toBe('idle'); // silence → idle
    // user clicks the tab → attach/resize repaints the FINISHED screen (no footer/prompt):
    expect(classify('assistant text, turn finished', s, claudeWaiting)).toBe('idle');
    expect(s.lastActivityTs).toBe(0); // repaint did NOT re-arm
  });

  it('a genuine resumption (working footer redrawn) DOES resurrect to working', () => {
    const s = initState(0);
    let t = 0;
    s.now = () => t;
    classify('assistant text, turn finished', s, claudeWaiting);
    t = 25_000;
    expect(classify('', s, claudeWaiting)).toBe('idle');
    // agent resumes: redraws its live footer
    expect(classify('Cooking… (2s · thinking) esc to interrupt', s, claudeWaiting)).toBe('working');
    expect(s.lastActivityTs).toBe(25_000); // resumption re-armed
  });
});

describe('classify — resurrection guard resets lastFrameWaiting (BUG-6)', () => {
  it('does not pin status to waiting forever after a sticky-waiting prompt vanishes and the guard fires idle', () => {
    const s: NIState = initState(0);
    let t = 0;
    s.now = () => t;
    // Get into lastFrameWaiting=true via a real waiting prompt.
    expect(classify(claudePermission, s, claudeWaiting)).toBe('waiting');
    expect(s.lastFrameWaiting).toBe(true);
    // Advance past SILENCE_MS, then feed a chunk where the prompt is GONE and
    // there's no working signal — sticky-waiting block falls through, wasIdle
    // is true, workAt < 0 → resurrection guard returns 'idle'.
    t = 25_000;
    const status = classify('plain assistant text, no prompt, no spinner', s, claudeWaiting);
    expect(status).toBe('idle');
    expect(s.lastFrameWaiting).toBe(false); // must be reset, not left stuck true
    // Next empty tick must stay idle, NOT resurrect to 'waiting' via the stale flag.
    expect(classify('', s, claudeWaiting)).toBe('idle');
  });
});

describe('classify — line structure prevents cross-row false positives (S4-5)', () => {
  // The agent DISPLAYS prompt-like text across two rows: "1." ends one line, "Yes" begins
  // the next. Before S4-5 stripAnsi collapsed the newline and `1\.\s*Yes` bridged the rows,
  // spuriously flipping to waiting. Line structure now confines the pattern to one row.
  it('does not flip to waiting on quoted prompt text split across rows', () => {
    const chunk = 'The tool listed its options. The first was labeled 1.\nYes was that first choice, so I picked it.\n';
    const s = initState(0);
    expect(classify(chunk, s, claudeWaiting)).not.toBe('waiting');
  });

  // Working footer on top, then trailing text ("… item 1." / "Yes …") the agent is still
  // emitting. The old collapse put the bridged "1. Yes" match AFTER "esc to interrupt", so it
  // WON the position tie and reported waiting mid-turn. Per-line matching kills the bridge, so
  // the live footer stays authoritative.
  it('stays working when text after a live footer would only span-match a prompt', () => {
    const chunk = 'Cooking… (5s · thinking) esc to interrupt\nProcessing item 1.\nYes, continuing now.\n';
    const s = initState(0);
    expect(classify(chunk, s, claudeWaiting)).toBe('working');
  });

  // Guard the real prompt still matches when its chrome sits on ONE row (regression anchor).
  it('still detects a real single-row option prompt as waiting', () => {
    const chunk = 'Do you want to create NEWFILE.txt?\n❯ 1. Yes\n2. Yes, allow all\n3. No\nEsc to cancel\n';
    const s = initState(0);
    expect(classify(chunk, s, claudeWaiting)).toBe('waiting');
  });
});

describe('provider needsInputPatterns', () => {
  it('both providers expose non-empty waiting patterns', () => {
    expect(claudeWaiting.length).toBeGreaterThan(0);
    expect(codexWaiting.length).toBeGreaterThan(0);
  });

  it('claude waiting patterns fire on the real permission fixture, not the working one', async () => {
    const perm = classify(claudePermission, initState(0), claudeWaiting);
    expect(perm).toBe('waiting');
  });

  it('claude resume command is flag-proof (glued --resume=<id>)', () => {
    const cp = new ClaudeProvider();
    expect(cp.commands.resume('/tmp/x', 'sess-123')).toEqual(['claude', '--resume=sess-123']);
    // A hostile id is glued to the flag with `=`, so it can never parse as a separate flag.
    const evil = cp.commands.resume('/tmp/x', '--dangerously-skip-permissions');
    expect(evil).toEqual(['claude', '--resume=--dangerously-skip-permissions']);
    expect(evil).not.toContain('--dangerously-skip-permissions'); // never a standalone argv item
  });

  it('claude freshPrompt shields the prompt after `--` as a single argv element', () => {
    const cp = new ClaudeProvider();
    expect(cp.commands.freshPrompt?.('/tmp/x', 'build the team')).toEqual([
      'claude',
      '--',
      'build the team',
    ]);
    // Hostile prompt starting with `-` still lands as a positional, never a flag.
    const evil = cp.commands.freshPrompt?.('/tmp/x', '--dangerously-skip-permissions') ?? [];
    expect(evil[evil.length - 2]).toBe('--');
    expect(evil[evil.length - 1]).toBe('--dangerously-skip-permissions');
    // Multi-line prompt survives intact as one argv element.
    const multi = 'line one\nline two';
    expect(cp.commands.freshPrompt?.('/tmp/x', multi)).toEqual(['claude', '--', multi]);
  });

  it('codex has no freshPrompt — no evidence of a documented initial-prompt argv (hard rule 6)', () => {
    expect(new CodexProvider().commands.freshPrompt).toBeUndefined();
  });

  it('claude headlessPlan argv is read-only (--permission-mode plan) and shields the task', () => {
    const argv = new ClaudeProvider().commands.headlessPlan('/tmp/x', 'do the thing');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('plan');
    // task sits after `--` so it can never parse as a flag.
    expect(argv[argv.indexOf('--') + 1]).toBe('do the thing');
    expect(argv.indexOf('--')).toBeGreaterThan(argv.indexOf('plan'));
  });

  it('codex headlessPlan + headlessAsk argv are sandboxed read-only', () => {
    const cx = new CodexProvider();
    for (const argv of [cx.commands.headlessPlan('/tmp/x', 't'), cx.commands.headlessAsk('/tmp/x', 'q')]) {
      expect(argv).toContain('-s');
      expect(argv[argv.indexOf('-s') + 1]).toBe('read-only'); // sandbox never dropped
      expect(argv).toContain('--'); // task/prompt shielded
    }
  });
});

describe('readHookStatus (config-dir seam)', () => {
  it('reads a valid hook status file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ni-'));
    writeFileSync(join(dir, 'pty1.json'), JSON.stringify({ status: 'waiting' }));
    expect(await readHookStatus(dir, 'pty1')).toBe('waiting');
  });
  it('returns null for missing or malformed files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ni-'));
    expect(await readHookStatus(dir, 'nope')).toBeNull();
    writeFileSync(join(dir, 'bad.json'), 'not json');
    expect(await readHookStatus(dir, 'bad')).toBeNull();
  });

  // Spec 2 precedence: a fresh hook file (age < 30s) wins over heuristics; a
  // stale one (agent exited / hook stopped firing) must NOT pin status forever.
  it('treats a fresh hook file (ts within 30s) as valid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ni-'));
    const now = 1_000_000;
    writeFileSync(join(dir, 'pty2.json'), JSON.stringify({ status: 'waiting', ts: now - 5_000, source: 'hook' }));
    expect(await readHookStatus(dir, 'pty2', () => now)).toBe('waiting');
  });

  it('returns null for a stale hook file (ts older than 30s)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ni-'));
    const now = 1_000_000;
    writeFileSync(join(dir, 'pty3.json'), JSON.stringify({ status: 'waiting', ts: now - 31_000, source: 'hook' }));
    expect(await readHookStatus(dir, 'pty3', () => now)).toBeNull();
  });

  it('treats a file with no ts field as fresh (fixture/back-compat form)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ni-'));
    writeFileSync(join(dir, 'pty4.json'), JSON.stringify({ status: 'idle' }));
    expect(await readHookStatus(dir, 'pty4', () => 999_999_999)).toBe('idle');
  });
});

describe('readHookStatusDetail (Spec 6 — status-explain evidence)', () => {
  it('reports status + age for a fresh file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ni-'));
    const now = 1_000_000;
    writeFileSync(join(dir, 'pty5.json'), JSON.stringify({ status: 'waiting', ts: now - 5_000 }));
    const detail = await readHookStatusDetail(dir, 'pty5', () => now);
    expect(detail).toMatchObject({ status: 'waiting', ageMs: 5_000, fresh: true });
    expect(detail.path).toContain('pty5.json');
  });

  it('reports fresh:false (not null) for a stale file — unlike readHookStatus, the raw status survives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ni-'));
    const now = 1_000_000;
    writeFileSync(join(dir, 'pty6.json'), JSON.stringify({ status: 'waiting', ts: now - 31_000 }));
    const detail = await readHookStatusDetail(dir, 'pty6', () => now);
    expect(detail).toMatchObject({ status: 'waiting', ageMs: 31_000, fresh: false });
  });

  it('reports status:null for a missing/malformed file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ni-'));
    const detail = await readHookStatusDetail(dir, 'nope');
    expect(detail.status).toBeNull();
    expect(detail.fresh).toBe(false);
  });
});

describe('classifyExplain (Spec 6 — status-explain evidence, classify() untouched)', () => {
  it('names the matching manifest pattern for a claude permission prompt', () => {
    const s = initState(0);
    const result = classifyExplain(claudePermission, s, claudeWaiting);
    expect(result.status).toBe('waiting');
    expect(result.branch).toBe('prompt-frame');
    expect(result.matchedPattern).not.toBeNull();
    // Evidence must name a REAL manifest pattern source, not a made-up label.
    expect(claudeWaiting.some((re) => re.source === result.matchedPattern)).toBe(true);
  });

  it('names the matching working pattern for a claude working frame', () => {
    const s = initState(0);
    const result = classifyExplain(claudeWorking, s, claudeWaiting);
    expect(result.status).toBe('working');
    expect(result.branch).toBe('working-activity');
    expect(result.matchedPattern).not.toBeNull();
  });

  it('produces byte-identical status to classify() over the same fixtures (no drift)', () => {
    for (const [chunk, patterns] of [
      [claudePermission, claudeWaiting],
      [claudeWorking, claudeWaiting],
      [codexTrust, codexWaiting],
    ] as const) {
      const plain = classify(chunk, initState(0), patterns);
      const explained = classifyExplain(chunk, initState(0), patterns);
      expect(explained.status).toBe(plain);
    }
  });

  it('marks branch sticky-waiting when a prompt persists across chunks (spinner redrawn over open prompt)', () => {
    const s = initState(0);
    classifyExplain(claudePermission, s, claudeWaiting); // seeds lastFrameWaiting=true
    const result = classifyExplain(claudePermission, s, claudeWaiting); // prompt still on screen
    expect(result.status).toBe('waiting');
    expect(result.branch).toBe('sticky-waiting');
    expect(result.lastFrameWaiting).toBe(true); // reflects state BEFORE this call
  });

  it('marks branch silence-idle on an empty tick past SILENCE_MS with no pending prompt', () => {
    const s: NIState = initState(0);
    let t = 0;
    s.now = () => t;
    classifyExplain('just plain assistant text, no prompt, no spinner', s, claudeWaiting);
    t = 21_000;
    const result = classifyExplain('', s, claudeWaiting);
    expect(result.status).toBe('idle');
    expect(result.branch).toBe('silence-idle');
    expect(result.matchedPattern).toBeNull();
  });

  it('marks branch silence-working on an empty tick before SILENCE_MS elapses', () => {
    const s: NIState = initState(0);
    let t = 0;
    s.now = () => t;
    classifyExplain('just plain assistant text, no prompt, no spinner', s, claudeWaiting);
    t = 1_000;
    const result = classifyExplain('', s, claudeWaiting);
    expect(result.status).toBe('working');
    expect(result.branch).toBe('silence-working');
  });

  it('reports msSinceLastOutput', () => {
    const s: NIState = initState(0);
    let t = 0;
    s.now = () => t;
    classifyExplain('some output', s, claudeWaiting);
    t = 4_200;
    const result = classifyExplain('', s, claudeWaiting);
    expect(result.msSinceLastOutput).toBe(4_200);
  });
});

describe('needs-input — real TUI row structure (R5-3)', () => {
  it('splits a real claude frame into rows even though it emits zero newlines', () => {
    // Claude positions rows with CR / cursor-move escapes, never LF. If stripAnsi flattens
    // those away, the whole frame is one "row" and per-row matching is inert (R5-3).
    const raw = fx('claude-permission.raw');
    expect(raw.includes('\n')).toBe(false); // the premise: no LF in real output
    expect(stripAnsi(raw).split('\n').length).toBeGreaterThan(1);
  });

  it('does not read prompt-like text displayed across CR-positioned rows as waiting', () => {
    const frame = 'Here is the plan. Step 1.\rYes, we will refactor.\r(12s · esc to interrupt · 1.2k tokens)';
    const st = initState(0);
    st.now = () => 1000;
    st.lastActivityTs = 900;
    expect(classify(frame, st, [/\b1\.\s*Yes\b/i])).toBe('working');
  });
});

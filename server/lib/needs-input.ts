// Needs-input detection (Task 15): classify a stream of PTY output into working / waiting /
// idle, so the UI can surface "needs input" dots, toasts, and grid-tile pulses.
//
// DESIGN (validated against real captured TUI fixtures for both providers):
//   Precedence — working WINS, because a live agent redraws continuously while a blocked
//   one draws its prompt once then goes silent. "Is output still arriving" is the strongest
//   discriminator:
//     1. working footer / live spinner / ticking token counter → working (refresh activity)
//     2. else an option-list/question prompt in the LATEST frame → waiting
//     3. else >SILENCE_MS since last output → idle (UNLESS the last frame held a prompt,
//        in which case it stays waiting — a blocked prompt is still waiting, not idle)
//
// RAW input: PTY output is raw bytes with ANSI/cursor codes that FRAGMENT words across
// escapes ("BBoBooBoot…", "esc to interrupt" split by cursor moves). We strip ANSI here and
// match the stripped-and-despaced text, so fixtures are stored RAW and this stripping is
// exercised by the tests (matching pre-stripped text would pass while the real daemon fails).
//
// AskUserQuestion note: it renders as the same `❯ 1.`-option-list chrome as a permission
// prompt, so the permission fixture/patterns cover it — no separate fixture fabricated.
//
// Hooks upgrade path: an optional Claude Code Notification hook can write
// <config>/status/<ptyId>.json; readHookStatus() (config-dir seam injected) reads it as a
// higher-confidence signal than output heuristics. Documented in README (later task).

export type NIStatus = 'working' | 'waiting' | 'idle';

export interface NIState {
  lastActivityTs: number;
  lastFrameWaiting: boolean; // did the most recent non-empty frame hold a prompt?
  now: () => number; // injectable clock (tests avoid Date.now)
}

const SILENCE_MS = 20_000;

export function initState(startTs = 0): NIState {
  return { lastActivityTs: startTs, lastFrameWaiting: false, now: () => startTs };
}

// Strip ANSI CSI/OSC/charset escapes + control bytes, collapse HORIZONTAL whitespace but
// KEEP row boundaries as newlines (S4-5). Preserving row structure stops a `\s`-bearing
// pattern (e.g. `1\.\s*Yes`) from bridging content that sits on two separate screen rows —
// an agent that prints "step 1." at a row end and "Yes" at the next row start must not read
// as the "1. Yes" option-list chrome. Matching is done per row (see lastMatchIndex).
//
// A TUI does not emit LF to move down: Claude's renderer emits ZERO newlines, positioning
// every row with CR / cursor-down (`ESC[1B`) / absolute-position (`ESC[H`, `ESC[30;1H`)
// escapes (R5-3 — the first cut of this stripped those to nothing, flattening the frame to
// one row and making per-row matching inert on the exact agent it mattered for). So convert
// every row-advancing control into a newline BEFORE dropping the rest.
export function stripAnsi(raw: string): string {
  return raw
    // Two straight passes, NOT one pass with a replacement callback: classify() runs on every
    // PTY chunk of every live session, and a callback fires per escape (hundreds of SGR codes
    // per repaint), which measured net-slower than the whole-frame matching it replaced (R6-4).
    // Cursor-down (B), next/prev-line (E/F), absolute position (H/f) and vertical-position (d)
    // land the cursor on a different row — a row break. Every other CSI is chrome.
    .replace(/\x1b\[[0-9;?]*[ -/]*[BEFHfd]/g, '\n')
    // Cursor-forward (C) is how Claude's renderer draws the SPACES between words
    // ("Esc<ESC>[Cto<ESC>[Ccancel") — deleting it glues words together and no
    // space-bearing waiting pattern ("Esc to cancel") can ever match (real
    // fixture: claude-resume-prompt.raw). Translate to one space, not nothing.
    .replace(/\x1b\[[0-9;?]*[ -/]*C/g, ' ')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b[()][0-9A-B]/g, '') // charset select
    .replace(/[\r\x0b\x0c]/g, '\n') // CR / VT / FF also start a new row
    .replace(/[^\x20-\x7e\n\t]/g, '') // control bytes + non-ascii (box-drawing, spinners) — KEEP \n, \t
    .replace(/[ \t]+/g, ' ') // collapse horizontal whitespace only
    .replace(/ ?\n[\s]*/g, '\n'); // trim space around a row break and collapse a repositioning burst
}

// Working signals — a live agent turn. Matched on the stripped LATEST frame.
const WORKING_PATTERNS: RegExp[] = [
  /esc to interrupt/i, // both claude + codex working footer
  /\(\s*\d+s\b/, // "(4s · thinking …)" / "(0s · esc to interrupt)"
  /thinking with/i, // claude spinner subtitle
  /\btokens\b/i, // live token counter ticking during a turn
];

// Only the tail of the stream matters — scrollback holds stale prompts. Look at the last
// ~4KB of stripped text as "the latest frame".
const FRAME_TAIL = 4096;

// Index of the LAST occurrence of any pattern in text, or -1. Position matters: within a
// frame, the signal drawn last is what's currently on screen — a permission prompt drawn
// after the spinner stops sits later in the buffer than the stale spinner text. Matching is
// PER LINE (S4-5): a pattern can only match within a single screen row, so a `\s`-bearing
// pattern can't span a newline; the returned index is the position in the full frame so the
// waiting-vs-working ordering comparison stays meaningful across lines.
// Compile once per call, not once per (pattern × row): classify() runs on every PTY chunk of
// every live session, and recompiling inside the row loop cost 177x on a real frame (R5-4).
function globalize(patterns: RegExp[]): RegExp[] {
  return patterns.map((re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
}

// classify one chunk (may be '' for a bare silence tick). Mutates + reads `state`.
// Thin wrapper over classifyExplain — the authoritative logic lives THERE so the
// hot path (events-hub monitor, which needs the evidence anyway) pays for one
// strip + one match pass, not two. Kept exported for callers that only want the
// status; delegating (rather than duplicating) means the two can never drift.
export function classify(chunk: string, state: NIState, waitingPatterns: RegExp[]): NIStatus {
  return classifyExplain(chunk, state, waitingPatterns).status;
}

// ── Spec 6: explainability ─────────────────────────────────────────────────────
// The authoritative classifier. Returns the status decision PLUS the evidence
// (branch/pattern) the status-explain endpoint needs — computed from the same
// single match pass that decided the status. (This used to be a wrapper that
// re-ran stripAnsi + the match loop on top of classify(), doubling the cost of
// the busiest server code path for evidence only a debug endpoint reads.)
export type NIBranch =
  | 'sticky-waiting' // lastFrameWaiting was true and the prompt is still on screen
  | 'prompt-frame' // a waiting pattern matched (and won position vs a working pattern)
  | 'working-activity' // a working pattern matched, or non-prompt output is still arriving
  | 'silence-idle' // empty tick, silence exceeded SILENCE_MS, no pending prompt
  | 'silence-working' // empty tick, silence not yet exceeded
  | 'repaint-idle'; // non-empty chunk, but a repaint of an already-idle screen (no working
  //                    signal, no prompt) — resurrection guard kept it idle, no re-arm

export interface NIEvidence {
  status: NIStatus;
  branch: NIBranch;
  matchedPattern: string | null; // manifest RegExp source (post-Spec-4) that decided it, if any
  msSinceLastOutput: number;
  lastFrameWaiting: boolean; // value BEFORE this classify() call (what the branch reasoned from)
}

export function classifyExplain(
  chunk: string,
  state: NIState,
  waitingPatterns: RegExp[],
): NIEvidence {
  const now = state.now();
  const prevLastFrameWaiting = state.lastFrameWaiting;
  const msSinceLastOutput = now - state.lastActivityTs;

  if (chunk.length > 0) {
    // Computed BEFORE any re-arm below, so the resurrection guard can tell "silence had
    // already elapsed when this chunk arrived" apart from "this chunk is what kept us busy".
    const wasIdle = msSinceLastOutput > SILENCE_MS;
    const frame = stripAnsi(chunk).slice(-FRAME_TAIL);

    // Whichever signal appears LAST in the frame reflects the current screen. A waiting
    // prompt drawn after the spinner stopped wins over the (now stale) working text above it.
    const wait = lastMatchDetail(frame, waitingPatterns);
    const work = lastMatchDetail(frame, WORKING_PATTERNS);

    // STICKY WAITING: once we're waiting on a prompt, a later working signal must NOT demote
    // us back to working while the prompt chrome is STILL on screen. Claude redraws its
    // spinner ("Cooking… (16s) · esc to interrupt") OVER a still-open "❯ 1. Yes / 2. / 3. No"
    // permission prompt; the spinner text lands later in the buffer than the prompt (work.index >
    // wait.index), which would otherwise flicker the dot waiting→working while the user is still
    // being asked. Only leave waiting when the prompt chrome is ABSENT from the latest frame.
    // (prompt gone → resume normal classification below.)
    if (prevLastFrameWaiting && wait.index >= 0) {
      state.lastActivityTs = now;
      return {
        status: 'waiting',
        branch: 'sticky-waiting',
        matchedPattern: wait.source,
        msSinceLastOutput,
        lastFrameWaiting: prevLastFrameWaiting,
      };
    }

    if (wait.index >= 0 && wait.index >= work.index) {
      state.lastActivityTs = now;
      state.lastFrameWaiting = true;
      return {
        status: 'waiting',
        branch: 'prompt-frame',
        matchedPattern: wait.source,
        msSinceLastOutput,
        lastFrameWaiting: prevLastFrameWaiting,
      };
    }

    // RESURRECTION GUARD: a repaint of an already-idle, finished screen (no working signal,
    // no prompt) must stay idle and must NOT re-arm the silence clock — otherwise the next
    // empty tick sees <20s silence and reports 'working' again (the "clicking a done agent
    // flips it to working" bug: TerminalPane's jiggle-resize triggers a SIGWINCH repaint of a
    // finished screen). A genuine resumption always redraws the working footer, so work.index >= 0
    // correctly falls through to re-arm and resurrect below.
    if (wasIdle && work.index < 0) {
      state.lastFrameWaiting = false;
      return {
        status: 'idle',
        branch: 'repaint-idle',
        matchedPattern: null,
        msSinceLastOutput,
        lastFrameWaiting: prevLastFrameWaiting,
      };
    }

    // Working signal present, or non-prompt output still arriving.
    state.lastActivityTs = now;
    state.lastFrameWaiting = false;
    return {
      status: 'working',
      branch: 'working-activity',
      matchedPattern: work.index >= 0 ? work.source : null,
      msSinceLastOutput,
      lastFrameWaiting: prevLastFrameWaiting,
    };
  }

  // Empty tick: no new output. Decide by silence + whether a prompt is pending.
  const status: NIStatus = prevLastFrameWaiting
    ? 'waiting'
    : msSinceLastOutput > SILENCE_MS
      ? 'idle'
      : 'working';
  return {
    status,
    branch: prevLastFrameWaiting
      ? 'sticky-waiting'
      : status === 'idle'
        ? 'silence-idle'
        : 'silence-working',
    matchedPattern: null,
    msSinceLastOutput,
    lastFrameWaiting: prevLastFrameWaiting,
  };
}

// Position of the LAST occurrence of any pattern in text (-1 if none), plus WHICH
// pattern's source produced it — the "evidence" the explain endpoint names. See the
// per-line matching doc above globalize() for why matching never spans rows.
function lastMatchDetail(text: string, patterns: RegExp[]): { index: number; source: string | null } {
  let best = -1;
  let bestSource: string | null = null;
  let offset = 0;
  const globals = globalize(patterns);
  for (const line of text.split('\n')) {
    for (let i = 0; i < globals.length; i++) {
      const g = globals[i];
      g.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = g.exec(line)) !== null) {
        if (offset + m.index > best) {
          best = offset + m.index;
          bestSource = patterns[i].source;
        }
        if (m.index === g.lastIndex) g.lastIndex++;
      }
    }
    offset += line.length + 1;
  }
  return { index: best, source: bestSource };
}

// Hooks upgrade path (Spec 2): an installed Claude Code hook (status-hooks.ts) writes a
// JSON file per PTY at <statusDir>/<ptyId>.json — {"status":"waiting","ts":<ms>,"source":
// "hook"}. This is a higher-confidence signal than output heuristics WHILE FRESH: a hook
// only fires on a lifecycle transition, so a stale file (agent exited, hook stopped firing,
// clock skew) must not pin status forever. statusDir is injected (config-dir seam) so no
// ~/.config path literal is baked in here. Returns null when no/invalid/stale hook file.
const HOOK_STATUS_MAX_AGE_MS = 30_000;

export async function readHookStatus(
  statusDir: string,
  ptyId: string,
  now: () => number = Date.now,
): Promise<NIStatus | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const raw = await readFile(join(statusDir, `${ptyId}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    const s = parsed?.status;
    if (s !== 'working' && s !== 'waiting' && s !== 'idle') return null;
    // Files with no `ts` (hand-written fixtures / pre-Spec-2 stubs) are treated
    // as fresh — every hook this module actually installs always stamps `ts`.
    if (typeof parsed?.ts === 'number' && now() - parsed.ts > HOOK_STATUS_MAX_AGE_MS) {
      return null; // stale — fall back to output heuristics
    }
    return s;
  } catch {
    return null; // no hook installed / malformed — fall back to output heuristics
  }
}

// Spec 6: same read as readHookStatus but reports the raw status + age even when
// STALE (the explain endpoint wants to say "hook said waiting but it's 45s old,
// heuristics were used instead" — readHookStatus collapses that to null). Never
// used on the hot path — additive, status-explain only.
export interface HookStatusDetail {
  path: string;
  status: NIStatus | null; // null if file missing/malformed
  ageMs: number | null; // null if no numeric ts
  fresh: boolean; // status !== null && ageMs !== null && ageMs <= HOOK_STATUS_MAX_AGE_MS
}

export async function readHookStatusDetail(
  statusDir: string,
  ptyId: string,
  now: () => number = Date.now,
): Promise<HookStatusDetail> {
  const { join } = await import('node:path');
  const filePath = join(statusDir, `${ptyId}.json`);
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const s = parsed?.status;
    const status: NIStatus | null = s === 'working' || s === 'waiting' || s === 'idle' ? s : null;
    const ageMs = typeof parsed?.ts === 'number' ? now() - parsed.ts : null;
    const fresh = status !== null && (ageMs === null || ageMs <= HOOK_STATUS_MAX_AGE_MS);
    return { path: filePath, status, ageMs, fresh };
  } catch {
    return { path: filePath, status: null, ageMs: null, fresh: false };
  }
}

// Cheap existence probe (no read/parse) — events-hub uses this on its 4s tick to
// gate whether a PTY's hot data-path pays the readHookStatus() cost at all. A PTY
// with no hook file (hooks never installed, or this session predates install) stays
// on the old fully-synchronous classify() path — byte-identical to pre-Spec-2.
export async function hookFileExists(statusDir: string, ptyId: string): Promise<boolean> {
  try {
    const { access } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await access(join(statusDir, `${ptyId}.json`));
    return true;
  } catch {
    return false;
  }
}

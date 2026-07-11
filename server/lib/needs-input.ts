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

// Strip ANSI CSI/OSC/charset escapes + control bytes, collapse whitespace. After this the
// working footer / prompt chrome are contiguous and matchable.
export function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b[()][0-9A-B]/g, '') // charset select
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') // stray control bytes
    .replace(/[^\x20-\x7e]/g, '') // non-ascii (box-drawing, spinner glyphs)
    .replace(/\s+/g, ' ');
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
// after the spinner stops sits later in the buffer than the stale spinner text.
function lastMatchIndex(text: string, patterns: RegExp[]): number {
  let best = -1;
  for (const re of patterns) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text)) !== null) {
      if (m.index > best) best = m.index;
      if (m.index === g.lastIndex) g.lastIndex++; // avoid zero-width loop
    }
  }
  return best;
}

// classify one chunk (may be '' for a bare silence tick). Mutates + reads `state`.
export function classify(chunk: string, state: NIState, waitingPatterns: RegExp[]): NIStatus {
  const now = state.now();

  if (chunk.length > 0) {
    // Computed BEFORE any re-arm below, so the resurrection guard can tell "silence had
    // already elapsed when this chunk arrived" apart from "this chunk is what kept us busy".
    const wasIdle = now - state.lastActivityTs > SILENCE_MS;
    const frame = stripAnsi(chunk).slice(-FRAME_TAIL);

    // Whichever signal appears LAST in the frame reflects the current screen. A waiting
    // prompt drawn after the spinner stopped wins over the (now stale) working text above it.
    const waitAt = lastMatchIndex(frame, waitingPatterns);
    const workAt = lastMatchIndex(frame, WORKING_PATTERNS);

    // STICKY WAITING: once we're waiting on a prompt, a later working signal must NOT demote
    // us back to working while the prompt chrome is STILL on screen. Claude redraws its
    // spinner ("Cooking… (16s) · esc to interrupt") OVER a still-open "❯ 1. Yes / 2. / 3. No"
    // permission prompt; the spinner text lands later in the buffer than the prompt (workAt >
    // waitAt), which would otherwise flicker the dot waiting→working while the user is still
    // being asked. Only leave waiting when the prompt chrome is ABSENT from the latest frame.
    if (state.lastFrameWaiting) {
      if (waitAt >= 0) {
        state.lastActivityTs = now;
        return 'waiting'; // prompt still present → stay waiting (ignore spinner)
      }
      // prompt gone (user answered / it dismissed) → resume normal classification.
    }

    if (waitAt >= 0 && waitAt >= workAt) {
      state.lastActivityTs = now;
      state.lastFrameWaiting = true;
      return 'waiting';
    }

    // RESURRECTION GUARD: a repaint of an already-idle, finished screen (no working signal,
    // no prompt) must stay idle and must NOT re-arm the silence clock — otherwise the next
    // empty tick sees <20s silence and reports 'working' again (the "clicking a done agent
    // flips it to working" bug: TerminalPane's jiggle-resize triggers a SIGWINCH repaint of a
    // finished screen). A genuine resumption always redraws the working footer, so workAt >= 0
    // correctly falls through to re-arm and resurrect below.
    if (wasIdle && workAt < 0) {
      state.lastFrameWaiting = false;
      return 'idle';
    }

    // Working signal present, or non-prompt output still arriving.
    state.lastActivityTs = now;
    state.lastFrameWaiting = false;
    return 'working';
  }

  // Empty tick: no new output. Decide by silence + whether a prompt is pending.
  if (state.lastFrameWaiting) return 'waiting'; // blocked prompt persists
  if (now - state.lastActivityTs > SILENCE_MS) return 'idle';
  return 'working';
}

// ── Spec 6: explainability wrapper ────────────────────────────────────────────
// classify() stays untouched (hot path, called per chunk). classifyExplain() is a
// thin wrapper for the debug/status-explain endpoint only: it captures the
// pre-mutation state, delegates the ACTUAL status decision to classify() (so the
// two can never drift), then reconstructs which branch/pattern produced that
// status by re-running the same read-only match logic classify() just used.
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
    const frame = stripAnsi(chunk).slice(-FRAME_TAIL);
    const waitDetail = lastMatchDetail(frame, waitingPatterns);
    const workDetail = lastMatchDetail(frame, WORKING_PATTERNS);

    const status = classify(chunk, state, waitingPatterns); // authoritative, mutates state

    if (prevLastFrameWaiting && waitDetail.index >= 0) {
      return {
        status,
        branch: 'sticky-waiting',
        matchedPattern: waitDetail.source,
        msSinceLastOutput,
        lastFrameWaiting: prevLastFrameWaiting,
      };
    }
    if (waitDetail.index >= 0 && waitDetail.index >= workDetail.index) {
      return {
        status,
        branch: 'prompt-frame',
        matchedPattern: waitDetail.source,
        msSinceLastOutput,
        lastFrameWaiting: prevLastFrameWaiting,
      };
    }
    // status is authoritative from classify(): 'idle' here means the resurrection guard
    // fired (repaint of an already-idle screen, no working signal) — label it distinctly
    // rather than misreport it as 'working-activity'.
    return {
      status,
      branch: status === 'idle' ? 'repaint-idle' : 'working-activity',
      matchedPattern: workDetail.index >= 0 ? workDetail.source : null,
      msSinceLastOutput,
      lastFrameWaiting: prevLastFrameWaiting,
    };
  }

  const status = classify(chunk, state, waitingPatterns);
  return {
    status,
    branch: prevLastFrameWaiting
      ? 'sticky-waiting'
      : msSinceLastOutput > SILENCE_MS
        ? 'silence-idle'
        : 'silence-working',
    matchedPattern: null,
    msSinceLastOutput,
    lastFrameWaiting: prevLastFrameWaiting,
  };
}

// Like lastMatchIndex, but also reports WHICH pattern's source produced the
// winning (last) match — the "evidence" the explain endpoint needs to name.
function lastMatchDetail(text: string, patterns: RegExp[]): { index: number; source: string | null } {
  let best = -1;
  let bestSource: string | null = null;
  for (const re of patterns) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text)) !== null) {
      if (m.index > best) {
        best = m.index;
        bestSource = re.source;
      }
      if (m.index === g.lastIndex) g.lastIndex++;
    }
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

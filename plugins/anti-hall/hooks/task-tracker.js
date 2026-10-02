#!/usr/bin/env node
// anti-hall :: task-list discipline injector (UserPromptSubmit, THROTTLED)
//
// Fires on every UserPromptSubmit, but does NOT inject the full task directive
// every turn (that multiplied the per-turn context footprint — the exact bloat
// this plugin warns against). Instead:
//   - FIRST turn of a session (or after the window expires): inject the FULL
//     directive (high-salience primer).
//   - Subsequent turns within the window: inject a SHORT one-line reminder.
// The discipline is never weakened — the full text is delivered at session start
// (and again every window) so capture/priority/drain rules stay present.
//
// FULL is re-injected on whichever of TWO triggers fires FIRST:
//   - WINDOW_MS wall-clock elapses since the last FULL injection, OR
//   - the transcript has GROWN by GROWTH_BYTES since the last FULL injection.
// The wall-clock-only gate under-injects for a heavy autonomous session (this
// plugin's own ralph/ultrawork use case): per KB-claude-codex.md §6.2 (adherence
// re-injection cadence), instruction adherence decays every 40-80K new tokens —
// and a busy session can blow past that in well under an hour, long before
// WINDOW_MS elapses. GROWTH_BYTES reuses the same readTail()/stat mechanism
// already in this file for freshnessNote(); no new dependency.
//
// Per-session state lives under ~/.anti-hall/ (F-07: never written into the
// user's project tree). Keyed by session_id (fallback: hash of cwd). Conservative
// and FAIL-OPEN: on ANY state error we inject the FULL directive (never less).
//
// Contract (Claude Code UserPromptSubmit hook):
//   stdin  : JSON { session_id, prompt, cwd, transcript_path, ... }
//   stdout : JSON { hookSpecificOutput.additionalContext } added to the turn
//   exit 0 : always - allow prompt, inject context
//
// No external deps; pure Node built-ins. JSON via JSON.stringify.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const DD = require('./lib/dispatch-demand.js');
const { reconstructTasks, classifyOpen } = require('./lib/task-state.js');

const FULL =
  'TASK-LIST DISCIPLINE: capture EVERY user request as a task (TaskCreate) ' +
  'before starting work, so no request is lost. Assign each task a priority ' +
  '(metadata.priority: P0/P1/P2) and maintain the list sorted ' +
  'highest-priority-first so the most important work is always on top; work ' +
  'tasks in that order. Keep statuses current: in_progress when starting, ' +
  'completed when done, deferred if explicitly deprioritized. Keep the MAIN ' +
  'thread non-blocking - delegate heavy/long work to background subagents and ' +
  'continue. Report progress to the user. Do not finish a turn with ' +
  'silently-dropped requests.';

const SHORT =
  'TASK-LIST: capture every request as a priority-sorted task; keep statuses ' +
  'current; delegate heavy work; drop nothing.';

// DevSwarm PRIMARY ONLY. FULL/SHORT above — and the ACTIONABLE-NOW dispatch line in
// freshnessNote() — say "delegate to a background subagent", which is the WRONG
// primitive for a Primary holding a workspace-scale task. Appended to whatever this
// hook already injects, and ONLY when the session is a DevSwarm Primary
// (DEVSWARM_REPO_ID set AND DEVSWARM_SOURCE_BRANCH empty). Outside DevSwarm, and in
// a CHILD workspace, the injected text is byte-for-byte unchanged. Mirrors rule W in
// verify-first-full.js.
const DEVSWARM_PRIMARY =
  'DEVSWARM PRIMARY — DISPATCH TIER: for each task, CLASSIFY before you dispatch. A ' +
  'workspace-scale MATTER (a feature/fix/deploy — multi-step, own branch, own review) is ' +
  'spun as its own CHILD WORKSPACE: `node scripts/devswarm.js spawn <branch> -p "<brief>"`. ' +
  'Only finer-grained work (a lookup, a single command, a scoped investigation, a review ' +
  'pass) goes to a background subagent. A workspace-scale task handed to a subagent is the ' +
  'same failure as leaving it idle.';

// isDevswarmPrimary(env) — DevSwarm active AND root/Primary (not a child workspace).
// Fail-open to FALSE => the baseline directive only.
function isDevswarmPrimary(env) {
  try {
    const { isDevswarmActive } = require('./lib/devswarm-detect.js');
    const { isChildWorkspace } = require('./lib/devswarm-role.js');
    return isDevswarmActive(env) && !isChildWorkspace(env);
  } catch (_) {
    return false;
  }
}

// Re-inject the FULL directive at most once per this window (ms). Within the
// window, subsequent turns get only the SHORT one-liner. 6h keeps the full
// primer fresh across a long session without repeating it every turn.
const WINDOW_MS = 6 * 60 * 60 * 1000;

// Re-inject FULL early — before WINDOW_MS elapses — once the transcript has
// grown by this many bytes since the last FULL injection. KB-claude-codex.md
// §6.2 puts the adherence-decay re-injection cadence at 40-80K NEW tokens; at
// a common ~4 bytes/token estimate that is ~160-320KB, so 240KB (the midpoint)
// is used as a single threshold rather than tracking a token count directly
// (this file has no tokenizer; byte size is what readTail()/stat give for free).
const GROWTH_BYTES = 240 * 1024;

// Tolerance for a stored timestamp slightly ahead of `now` (benign clock skew
// between writes/reads). Anything beyond this in the future is treated as
// corrupt and self-healed. See the future/garbage-timestamp guard below.
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// transcriptSize(payload) -> byte size of payload.transcript_path via a cheap
// stat (pickMessage only needs the SIZE, not the content — no need to pay for
// readTail()'s read here). Returns -1 when unavailable (no path, ENOENT, any
// stat error) so callers can tell "unknown" apart from a genuine 0-byte file.
function transcriptSize(payload) {
  const tp = payload && payload.transcript_path;
  if (!tp || typeof tp !== 'string') return -1;
  try {
    return fs.statSync(tp).size;
  } catch (_) {
    return -1;
  }
}

// Decide which message to inject. Returns FULL on the first turn of a session,
// when the window has expired, OR when the transcript has grown by
// GROWTH_BYTES since the last FULL injection (whichever trigger fires first);
// SHORT otherwise. FAIL-OPEN to FULL on any error so task discipline is never
// weakened by a state-file problem.
function pickMessage(payload) {
  try {
    const sessionId = (payload && payload.session_id && String(payload.session_id)) ||
      crypto.createHash('sha1').update(String((payload && payload.cwd) || process.cwd()))
        .digest('hex').slice(0, 16);
    const safeSession = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
    const stateDir = path.join(os.homedir(), '.anti-hall');
    const stateFile = path.join(stateDir, 'task-tracker-' + safeSession + '.json');

    const now = Date.now();
    const curSize = transcriptSize(payload);
    let lastFull = 0;
    // -1 = unknown baseline (never recorded, or recorded when the transcript
    // path/size was unavailable). Kept distinct from a real 0-byte transcript
    // so the growth check below never compares against a false zero baseline.
    let lastFullSize = -1;
    try {
      const raw = fs.readFileSync(stateFile, 'utf8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        // FUTURE/GARBAGE-TIMESTAMP GUARD: only trust a stored timestamp that is a
        // finite number AND not in the future (allowing a small clock-skew
        // tolerance). A future or non-finite value (clock skew, timezone error,
        // manual edit, corrupted state) would make `now - lastFull` negative, so
        // `now - lastFull < WINDOW_MS` stays true forever and the FULL directive
        // would NEVER re-show. We reject such values (leave lastFull = 0) so the
        // window is treated as EXPIRED below -> FULL directive + state rewritten
        // to `now`, self-healing the bad value rather than trusting it.
        if (parsed && Number.isFinite(parsed.lastFull) &&
            parsed.lastFull <= now + FUTURE_TOLERANCE_MS) {
          lastFull = parsed.lastFull;
        }
        // Same finite/non-negative sanity gate for the size baseline; anything
        // else (missing key, garbage, negative) is left as -1 = unknown.
        if (parsed && Number.isFinite(parsed.lastFullSize) && parsed.lastFullSize >= 0) {
          lastFullSize = parsed.lastFullSize;
        }
      }
    } catch (_) {
      // No prior state -> first turn -> FULL below.
    }

    const windowFresh = (now - lastFull) < WINDOW_MS;
    // Growth trigger only fires when BOTH sizes are known (never assume growth
    // from an unknown/zero baseline — that would spuriously fire FULL the very
    // next turn merely because the transcript existed but had no prior baseline).
    const grew = curSize >= 0 && lastFullSize >= 0 && (curSize - lastFullSize) >= GROWTH_BYTES;

    if (windowFresh && !grew) {
      // Within a valid past window AND no size-growth trigger: short reminder,
      // no state write needed.
      return SHORT;
    }

    // Window expired OR transcript grew past threshold since last FULL: inject
    // FULL, record the time and the new size baseline.
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ lastFull: now, lastFullSize: curSize }), 'utf8');
    } catch (_) {
      // Can't persist -> still inject FULL (fail-open: never under-inject).
    }
    // Opportunistic bounded self-prune of OTHER stale task-tracker-* files
    // (see lib/state-prune.js header for the proven root cause: one file per
    // session, never cleaned, ~47K accumulated). Cheap + throttled; never
    // touches this session's own file. Fail-open, never blocks injection.
    try {
      require('./lib/state-prune.js').pruneStale({
        stateDir, prefix: 'task-tracker', keepFile: stateFile,
      });
    } catch (_) {}
    return FULL;
  } catch (_) {
    return FULL; // any unexpected error -> never weaken discipline
  }
}

// freshnessNote(payload) — cheap, bounded transcript tail-scan that returns a
// per-turn note built from the reconstructed task state. Two layers:
//   (a) ACTIONABLE-NOW (every turn): when >=1 pending+unowned+unblocked task
//       exists that no in-flight agent of THIS session covers (and running <
//       cap — lib/dispatch-demand.js evaluate), emit "DISPATCH NOW in parallel:"
//       naming each task id + subject, one background agent per task.
//       This is the per-turn complement to the Stop-hook idle-neglect block — it
//       nudges BEFORE the turn instead of only at Stop.
//   (b) open-tasks freshness note: when there are open (pending/in_progress)
//       tasks, append the legacy "open tasks: N (oldest in_progress …)" line.
// Returns '' when there are no open tasks at all (baseline stays lean).
// Fail-open: any error → ''.
// metricsHome() — the metrics home, or null (never throws; the test-home guard
// refuses the real HOME under a test runner).
function metricsHome() {
  try { return require('../companion/lib/test-home-guard.js').resolveHome(); } catch (_) { return null; }
}

// Set by freshnessNote when the DISPATCH NOW line is included (metrics).
let demandShown = 0;
function freshnessNote(payload) {
  try {
    const tp = payload && payload.transcript_path;
    if (!tp || typeof tp !== 'string') return '';
    // ONE shared bounded read (lib/transcript-tail.js, 1.5MB) feeds both the
    // task reconstruction and the running-agent scan. The old private 256KB
    // window dropped tasks created only minutes earlier on a busy session
    // (field: #1/#2 sat 320-385KB back and were invisible to this line).
    const lines = require('./lib/transcript-tail.js').readTail(tp);
    if (!lines) return '';
    const state = reconstructTasks({ data: lines.join('\n'), truncated: false });
    // An open task whose TaskCreate lies before the 1.5MB window has no subject
    // here; one bounded extra pass recovers it (no-op when none is missing).
    // Mutates the shared task objects, so state.open sees the subject too.
    require('./lib/task-subject-backfill.js').backfillSubjects(state.taskMap, tp, state);
    // dispatchTier outcome labels (actual dispatch vs recommendation, one-lane /
    // fan-out) — metrics only, fail-open.
    try {
      const mh = metricsHome();
      if (mh) require('./lib/dispatch-tier.js').trackOutcomes({ home: mh, sessionId: payload.session_id, lines, taskMap: state.taskMap });
    } catch (_) {}
    const open = state.open;
    if (open.length === 0) return '';

    let out = '';

    // (a) ACTIONABLE-NOW per-turn DISPATCH NOW line. Coverage is PER TASK from THIS session's transcript (lib/dispatch-demand.js
    // header) — no longer the machine-global recent-spawn.json heartbeat, which
    // any spawn in any session refreshed for 20 min and which blanket-silenced
    // this line for every pending task.
    const actionable = classifyOpen(open, state.taskMap);
    if (actionable.length >= 1 && DD.enabled()) {
      let running = null;
      try { running = require('./lib/agent-scan.js').runningAgentsOrNull(tp, lines); } catch (_) { running = null; }
      const res = DD.evaluate({ actionable, knownIds: [...state.taskMap.keys()], inProgressIds: open.filter((t) => /in[-_]?progress/i.test(t.status || '')).map((t) => t.id), running });
      if (res.fire) {
        // Jev dispatchTier (advisory, default on): "→ <tier> (<conf>)" per task
        // from a CACHED verdict only (never a network wait here); off / shadow /
        // Jev error -> no annotation and the line is unchanged.
        let tier = null;
        try {
          const mh = metricsHome();
          if (mh) tier = require('./lib/dispatch-tier.js').annotator({ home: mh, cwd: payload.cwd, sessionId: payload.session_id, transcriptPath: tp });
        } catch (_) { tier = null; }
        out += DD.demandLine(res, { annotate: tier ? (t) => tier.annotate(t) : null });
        const foot = tier ? tier.footer() : '';
        if (foot) out += ' ' + foot;
        if (tier) { try { tier.commit(); } catch (_) {} }
        demandShown = res.dispatch.length;
      } else if (res.unknown) {
        out += 'Background-agent running-agent count unknown (transcript window too short to prove none are in flight): check before dispatching more. ';
      }
    }

    // (b) freshness note about open tasks (in_progress subject if any).
    const inProg = open.find((t) => /in[-_]?progress/i.test(t.status || ''));
    // FIX 7: control-char strip (oneLine) THEN JSON.stringify so the task-supplied
    // subject is rendered as an inert quoted string and can never inject
    // instruction-shaped content into the UserPromptSubmit additionalContext.
    // SUBJECT UNKNOWN (mirror task-guard.js renderList): a task whose subject
    // was never learned (its TaskCreate sits outside the scan window, or is
    // from a PRIOR epoch and only a bare TaskUpdate{taskId} was seen)
    // reconstructs with content === id. Printing that bare id as if it were
    // the subject (`oldest in_progress subject: "3"`) is exactly the phantom
    // this field report named — say "(subject unknown)" instead, never the id.
    const inProgHasSubject = inProg && inProg.content != null && String(inProg.content) !== String(inProg.id);
    const subj = inProg ? oneLine(inProgHasSubject ? inProg.content : '(subject unknown)', 50) : '';
    const tail2 = inProg && subj ? ' (oldest in_progress subject: ' + JSON.stringify(subj) + ')' : '';
    const freshLine = 'open tasks: ' + open.length + tail2 + ' — update or close them.';

    return out ? out + ' ' + freshLine : freshLine;
  } catch (_) {
    return '';
  }
}

function oneLine(s, max) {
  if (typeof s !== 'string') return '';
  let o = s.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (o.length > max) o = o.slice(0, max).trimEnd() + '…';
  return o;
}

try {
  // Settings switch context.taskTracker (0.108.4): off -> no-op. Fail-open.
  let trackerOn = true;
  try { trackerOn = require('./lib/settings.js').enabled('context', 'taskTracker'); } catch (_) { trackerOn = true; }
  if (!trackerOn) process.exit(0);

  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { payload = {}; }

  // Escape hatch: honor an explicit, user-consented skip (~/.anti-hall/skip.json).
  let skipped = false;
  try { skipped = require('./skip-guard.js').isSkipped('task-tracker'); } catch (_) { skipped = false; }

  // JEV SHADOW (newRequest, default mode "shadow"): fire-and-forget
  // classification of the prompt into {new-request, follow-up, correction,
  // question}. baseline = null/unknown — this NEVER affects the injected
  // text below, and MUST add zero latency to this critical-path hook, so it
  // is dispatched via askDetached (spawn detached + stdio ignore + unref) —
  // the label lands in jev-assist.ndjson only, for `jev report` to show
  // label distribution/agreement once a human has judged some outcomes.
  if (!skipped && typeof payload.prompt === 'string' && payload.prompt.trim()) {
    try {
      const jevAssist = require('./lib/jev-assist.js');
      jevAssist.askDetached({
        id: 'newRequest',
        question: {
          type: 'choice',
          instructions: 'Classify the user\'s message below.',
          criteria: {
            'new-request': 'a new, previously-unstated request or task',
            'follow-up': 'continuing or elaborating on work already in progress',
            correction: 'correcting or redirecting prior work',
            question: 'a question seeking information, not asking for new work',
          },
        },
        state: payload.prompt.slice(0, 4000),
        trust: 'advisory',
        baseline: null,
        sessionId: payload && payload.session_id ? String(payload.session_id) : undefined,
        turnRef: jevAssist.turnRefFromTranscript(payload && payload.transcript_path),
      });
    } catch (_) { /* best-effort — never affects the injected context */ }
  }

  let text;
  let primaryBlock = '';
  if (skipped) {
    text = '';
  } else {
    text = pickMessage(payload);
    // Append a SHORT freshness note ONLY when open/stale tasks exist (keeps the
    // per-turn baseline lean when there is nothing to nudge about).
    // Score the PREVIOUS turn's dispatch demand (followed by a spawn or not)
    // before emitting this turn's. Metrics only; fail-open.
    const mHome = metricsHome();
    if (mHome) DD.resolvePending({ home: mHome, sessionId: payload && payload.session_id, transcriptPath: payload && payload.transcript_path });
    const note = freshnessNote(payload);
    if (note) text = text + ' ' + note;
    // DevSwarm PRIMARY only: name the workspace tier at the dispatch point.
    // KEEPALIVE (0.111 item 1): DEVSWARM_PRIMARY is static and was previously
    // appended to `text` EVERY turn regardless of the FULL/SHORT window above
    // (freshnessNote varies turn to turn, so the combined-text dedupe below
    // never collapsed it) — its own key + keepaliveTurns throttles it to
    // once per session / once after compact-clear / once every N turns,
    // independent of the live freshness note. guards.injectionRepeatEvery=0
    // restores every-turn injection.
    if (isDevswarmPrimary(process.env)) {
      let emitPrimary = true;
      try {
        let repeatEvery = 10;
        try { repeatEvery = require('./lib/settings.js').get('guards', 'injectionRepeatEvery', 10); } catch (_) {}
        emitPrimary = require('./lib/emit-dedupe.js').shouldEmit({
          home: require('../companion/lib/test-home-guard.js').resolveHome(), sessionId: payload && payload.session_id,
          transcriptPath: payload && payload.transcript_path,
          key: 'task-tracker-primary', content: DEVSWARM_PRIMARY,
          keepaliveTurns: Number.isFinite(repeatEvery) && repeatEvery > 0 ? repeatEvery : 0,
        });
      } catch (_) { emitPrimary = true; }
      // Held OUT of `text`: the burst-collapse hash below must not depend on
      // whether the primary block was emitted this time, or a queued burst
      // emits TASK-LIST twice (first copy hashed with the block, next without).
      if (emitPrimary) primaryBlock = DEVSWARM_PRIMARY;
    }
  }

  // Queued-prompt burst collapse (lib/emit-dedupe.js rule a): one copy per
  // delivery instead of one per queued prompt. FULL subsumes SHORT for hashing, so
  // SHORT copies after a FULL in the same burst are suppressed; a FULL itself is
  // never suppressed (pickMessage already recorded it as delivered) — it is
  // recorded unconditionally instead. Fail-open: any error -> emit.
  let emit = true;
  if (text) {
    try {
      const dedupe = require('./lib/emit-dedupe.js');
      const opts = {
        home: os.homedir(), sessionId: payload && payload.session_id,
        transcriptPath: payload && payload.transcript_path, key: 'task-tracker',
        content: text, normalize: (t) => t.split(FULL).join(SHORT),
      };
      if (text.startsWith(FULL)) dedupe.record(opts);
      else emit = dedupe.shouldEmit(opts);
    } catch (_) { emit = true; }
  }

  // Official schema: `hookEventName` is NESTED in `hookSpecificOutput`, not a
  // top-level sibling. KB §1.4 specifies `hookSpecificOutput.additionalContext`
  // for UserPromptSubmit; nesting here is correct per the harness contract.
  const finalText = [emit ? text : '', primaryBlock].filter(Boolean).join('\n\n');
  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: finalText,
    },
  };
  emit = emit || !!primaryBlock;
  if (emit) process.stdout.write(JSON.stringify(out) + '\n');
  const mHome2 = emit && demandShown > 0 ? metricsHome() : null;
  if (mHome2) DD.recordDemand({ home: mHome2, sessionId: payload && payload.session_id, count: demandShown });
} catch (_) {
  // Fail-open.
}
process.exit(0);

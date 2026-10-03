'use strict';
// devswarm read-side liveness demotion (isDormantActivity / dormantThresholdMs /
// isDormantRow, companion/lib/liveness.js) + its consumer, devswarm-parent-
// inbox.js's displayStatus. THE BUG (measured live, 2026-08): a DevSwarm
// mesh/registry row OUTLIVES its workspace — closing a workspace in the app
// does not delete the row, the worktree, the workspaces/<id>.json descriptor,
// or the `hivecontrol workspace list` entry. Across four real workspaces (one
// live, three closed), every other candidate signal read IDENTICAL for live
// and dead (descriptor presence, archived/<id>.json presence, registry
// updated_at, the persisted liveness verdict — all four read `alive` — and
// isLiveSessionId). ONLY heartbeat/activity AGE separated them.
//
// FOLLOW-UP BUG (P1, this suite's second half): of 26 real workspace
// descriptors, only ~7 carry a sessionId and only ~5 resolve to an on-disk
// transcript — so for most rows the transcript term NEVER contributes, and the
// tight 30-min dormant window was silently degrading to heartbeat-only, which
// is written once per USER TURN. isDormantRow fixes this by picking the window
// from the evidence actually available: tight when the transcript resolves,
// wide (idleThresholdMs) when it doesn't.
//
// This suite proves: the `dormant` read-side demotion is driven by activity
// age, is fail-open on any uncertain input, never outranks
// escalated/stale/archive-ready, and isDormantRow selects the correct window
// per-row based on transcript resolvability.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const liveness = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js',
));
const {
  isDormantActivity, dormantThresholdMs, DEFAULT_DORMANT_MS,
  idleThresholdMs, DEFAULT_ROSTER_IDLE_MS,
  readActivityTs, isDormantRow, projectDirFor, heartbeatPathFor,
} = liveness;
const { displayStatus } = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'devswarm-parent-inbox.js',
));

// ---- env hermeticity (P2-c) -------------------------------------------------
// Both threshold env vars flip results if left ambient on the running
// machine. Every case that can reach either threshold reader (directly, via
// isDormantActivity/isDormantRow, or indirectly via displayStatus's own idle
// branch) is wrapped with this save/delete/restore helper.
const ENV_KEYS = ['ANTIHALL_DEVSWARM_DORMANT_MS', 'ANTIHALL_DEVSWARM_IDLE_MS'];
function withCleanEnv(fn) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ---- helpers for readActivityTs / isDormantRow fixture tests ---------------

function makeTempHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeHeartbeat(home, id, ts) {
  const p = heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ts }));
}

function writeTranscript(home, worktreePath, sessionId) {
  const dir = projectDirFor(worktreePath, home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionId + '.jsonl'), '{}\n');
}

// ---- readActivityTs: shape ({ ts, sawTranscript }) --------------------------

test('readActivityTs: returns { ts, sawTranscript } — TRANSCRIPT mtime wins when newer than the heartbeat, sawTranscript true', () => {
  const home = makeTempHome('anti-hall-liveness-transcript-');
  try {
    const id = 'ws-transcript-newer';
    const worktreePath = '/tmp/some/worktree/path-for-test';
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const now = Date.now();
    writeHeartbeat(home, id, now - 60 * 60 * 1000); // 1h old heartbeat
    writeTranscript(home, worktreePath, sessionId); // freshly written -> mtime ~now
    const got = readActivityTs({ id, worktreePath, sessionId }, home, {});
    const expected = fs.statSync(path.join(projectDirFor(worktreePath, home), sessionId + '.jsonl')).mtimeMs;
    assert.equal(got.ts, expected, 'readActivityTs must return the transcript mtime when it is the newest signal');
    assert.equal(got.sawTranscript, true, 'sawTranscript must be true when the transcript statSync resolved');
    assert.ok(got.ts > now - 5000, 'transcript mtime should read as freshly written, not the stale heartbeat');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readActivityTs: opts.heartbeatTs (P2-b) is used verbatim and skips the internal heartbeat file read', () => {
  const home = makeTempHome('anti-hall-liveness-hbopt-');
  try {
    const id = 'ws-hbopt';
    const now = Date.now();
    // Deliberately do NOT write a heartbeat file on disk — if readActivityTs
    // fell back to its internal read it would find nothing; passing
    // opts.heartbeatTs must still surface the value.
    const got = readActivityTs({ id }, home, { heartbeatTs: now - 1000 });
    assert.equal(got.ts, now - 1000);
    assert.equal(got.sawTranscript, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- THE ANTI-BLINDING CASE THAT MOTIVATED THIS CHANGE ---------------------

test('ANTI-BLINDING (live-mid-long-turn child): heartbeat 90 min old (past the 30-min dormant window) but transcript touched seconds ago -> isDormantActivity(readActivityTs(...).ts) is FALSE', () => {
  // devswarm-child-turn.js's heartbeat write is registered ONLY on
  // UserPromptSubmit — one write per USER TURN, not per tool call. DevSwarm
  // child doctrine explicitly tells children to keep working across many
  // rounds WITHIN the same turn, so a genuinely-live child deep in one long
  // autonomous turn can go well past the 30-min heartbeat-only window with zero
  // new heartbeats. The transcript term is what keeps it observably alive: a
  // live session appends to its transcript on every tool call, not once per
  // turn.
  const home = makeTempHome('anti-hall-liveness-midturn-');
  try {
    const id = 'ws-live-midturn';
    const worktreePath = '/tmp/some/other/worktree-for-test';
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const now = Date.now();
    writeHeartbeat(home, id, now - 90 * 60 * 1000); // 90 min old — past the 30-min window on its own
    writeTranscript(home, worktreePath, sessionId); // touched "now" — still-live session
    const activity = readActivityTs({ id, worktreePath, sessionId }, home, {});
    assert.equal(activity.sawTranscript, true);
    assert.equal(isDormantActivity(activity.ts, now), false,
      'a child mid-long-turn with a fresh transcript must never be classified dormant, even with a stale turn-scoped heartbeat');
    assert.equal(isDormantRow({ id, worktreePath, sessionId }, home, { now }), false,
      'isDormantRow must agree: fresh transcript activity is not dormant under the tight window either');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- readActivityTs: fail-open ----------------------------------------------

test('readActivityTs: fail-open on missing sessionId, missing worktreePath, unreadable/absent transcript, absent heartbeat -> ts null, sawTranscript false, never throws, never dormant', () => {
  const home = makeTempHome('anti-hall-liveness-failopen-');
  try {
    const now = Date.now();
    // No heartbeat file, no worktreePath/sessionId at all.
    let r = readActivityTs({ id: 'ws-none' }, home, {});
    assert.equal(r.ts, null); assert.equal(r.sawTranscript, false);
    // sessionId present but worktreePath missing.
    r = readActivityTs({ id: 'ws-none2', sessionId: '33333333-3333-4333-8333-333333333333' }, home, {});
    assert.equal(r.ts, null); assert.equal(r.sawTranscript, false);
    // worktreePath present but sessionId missing.
    r = readActivityTs({ id: 'ws-none3', worktreePath: '/tmp/nope-for-test' }, home, {});
    assert.equal(r.ts, null); assert.equal(r.sawTranscript, false);
    // worktreePath + sessionId both present but no transcript file on disk (unreadable/absent).
    r = readActivityTs({ id: 'ws-none4', worktreePath: '/tmp/does/not/exist-for-test', sessionId: '44444444-4444-4444-8444-444444444444' }, home, {});
    assert.equal(r.ts, null); assert.equal(r.sawTranscript, false);
    // No id at all.
    r = readActivityTs({}, home, {});
    assert.equal(r.ts, null); assert.equal(r.sawTranscript, false);
    // Never dormant when the composed signal is null.
    assert.equal(isDormantActivity(readActivityTs({ id: 'ws-none' }, home, {}).ts, now), false);
    assert.equal(isDormantRow({ id: 'ws-none' }, home, { now }), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- readActivityTs: closed workspace (measured case) -----------------------

test('readActivityTs: closed workspace, BOTH heartbeat and transcript ~60 min old -> dormant true (measured closed-workspace case)', () => {
  // Mirrors the real measured closed-workspace reading (heartbeat 66.4 min,
  // transcript 62.4 min) that motivated keeping the 30-min window tight enough
  // to demote a workspace that has actually stopped.
  const home = makeTempHome('anti-hall-liveness-closed-');
  try {
    const id = 'ws-closed';
    const worktreePath = '/tmp/closed/worktree-for-test';
    const sessionId = '55555555-5555-4555-8555-555555555555';
    const now = Date.now();
    const heartbeatTs = now - 66 * 60 * 1000;
    writeHeartbeat(home, id, heartbeatTs);
    writeTranscript(home, worktreePath, sessionId);
    // Force the transcript's mtime back to ~62 min old (it was just written "now").
    const transcriptPath = path.join(projectDirFor(worktreePath, home), sessionId + '.jsonl');
    const oldMs = now - 62 * 60 * 1000;
    fs.utimesSync(transcriptPath, oldMs / 1000, oldMs / 1000);
    const activity = readActivityTs({ id, worktreePath, sessionId }, home, {});
    assert.equal(activity.sawTranscript, true);
    assert.equal(isDormantActivity(activity.ts, now), true,
      'both signals stale past the 30-min window -> dormant');
    assert.equal(isDormantRow({ id, worktreePath, sessionId }, home, { now }), true,
      'isDormantRow must apply the TIGHT window here since the transcript resolved');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- isDormantRow: MUST-STILL-HOLD window-selection assertions -------------
// The six scenarios that must all still hold after making the tight window
// CONDITIONAL on the transcript term actually contributing.

test('isDormantRow MUST-HOLD 1: resolvable transcript, 62 min stale -> dormant (real closed workspace)', () => {
  const home = makeTempHome('anti-hall-liveness-musthold1-');
  try {
    const id = 'ws-mh1';
    const worktreePath = '/tmp/mh1-worktree-for-test';
    const sessionId = '66666666-6666-4666-8666-666666666666';
    const now = Date.now();
    writeHeartbeat(home, id, now - 62 * 60 * 1000);
    writeTranscript(home, worktreePath, sessionId);
    const transcriptPath = path.join(projectDirFor(worktreePath, home), sessionId + '.jsonl');
    const oldMs = now - 62 * 60 * 1000;
    fs.utimesSync(transcriptPath, oldMs / 1000, oldMs / 1000);
    assert.equal(isDormantRow({ id, worktreePath, sessionId }, home, { now }), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isDormantRow MUST-HOLD 2: resolvable transcript, 1240 min stale -> dormant', () => {
  const home = makeTempHome('anti-hall-liveness-musthold2-');
  try {
    const id = 'ws-mh2';
    const worktreePath = '/tmp/mh2-worktree-for-test';
    const sessionId = '77777777-7777-4777-8777-777777777777';
    const now = Date.now();
    writeHeartbeat(home, id, now - 1240 * 60 * 1000);
    writeTranscript(home, worktreePath, sessionId);
    const transcriptPath = path.join(projectDirFor(worktreePath, home), sessionId + '.jsonl');
    const oldMs = now - 1240 * 60 * 1000;
    fs.utimesSync(transcriptPath, oldMs / 1000, oldMs / 1000);
    assert.equal(isDormantRow({ id, worktreePath, sessionId }, home, { now }), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isDormantRow MUST-HOLD 3: transcript touched seconds ago -> NOT dormant', () => {
  const home = makeTempHome('anti-hall-liveness-musthold3-');
  try {
    const id = 'ws-mh3';
    const worktreePath = '/tmp/mh3-worktree-for-test';
    const sessionId = '88888888-8888-4888-8888-888888888888';
    const now = Date.now();
    writeTranscript(home, worktreePath, sessionId); // fresh
    assert.equal(isDormantRow({ id, worktreePath, sessionId }, home, { now }), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isDormantRow MUST-HOLD 4 (the blinding bug): NO resolvable transcript, heartbeat 45 min old -> NOT dormant', () => {
  const home = makeTempHome('anti-hall-liveness-musthold4-');
  try {
    const id = 'ws-mh4';
    const now = Date.now();
    writeHeartbeat(home, id, now - 45 * 60 * 1000);
    // No sessionId/worktreePath -> transcript can never resolve -> wide window applies.
    assert.equal(isDormantRow({ id }, home, { now }), false,
      '45 min is past the tight 30-min window but well inside the 6h wide window — must NOT be dormant');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isDormantRow MUST-HOLD 5: NO resolvable transcript, heartbeat 20 HOURS old -> dormant (still catches the long-dead case)', () => {
  const home = makeTempHome('anti-hall-liveness-musthold5-');
  try {
    const id = 'ws-mh5';
    const now = Date.now();
    writeHeartbeat(home, id, now - 20 * 60 * 60 * 1000);
    assert.equal(isDormantRow({ id }, home, { now }), true,
      '20h exceeds even the wide 6h idle window');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isDormantRow MUST-HOLD 6: no signal at all -> NOT dormant', () => {
  const home = makeTempHome('anti-hall-liveness-musthold6-');
  try {
    const now = Date.now();
    assert.equal(isDormantRow({ id: 'ws-mh6-none' }, home, { now }), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- legend / overflow (buildWorkspaceTable) --------------------------------
// buildWorkspaceTable is NOT exported from devswarm-parent-inbox.js (only
// displayStatus is), and the spec for this change explicitly says not to add a
// new export just to test it. Skipping direct assertion of the legend wording
// and the "+N more (ids...)" overflow line rendering — those are covered by
// manual/code inspection only in this suite.

// ---- 1/2: core age threshold ---------------------------------------------

test('isDormantActivity: RECENT activity (age 1 min) -> false (still active)', () => {
  const now = Date.now();
  assert.equal(isDormantActivity(now - 1 * 60 * 1000, now), false);
});

test('isDormantActivity: STALE activity (age 50 min, real measured closed-workspace value) -> true', () => {
  const now = Date.now();
  assert.equal(isDormantActivity(now - 50 * 60 * 1000, now), true);
});

// ---- 3/4/5: anti-blinding fail-open guarantees -----------------------------

test('ANTI-BLINDING: isDormantActivity(null, now) -> false — no signal is NOT evidence of death (fail-open guarantee)', () => {
  const now = Date.now();
  assert.equal(isDormantActivity(null, now), false,
    'a workspace with no known activity signal at all must never be classified dormant — absence of a signal is not evidence of death');
});

test('ANTI-BLINDING: isDormantActivity(0, now) and a future stamp -> false (zeroed stamp / clock skew are not evidence)', () => {
  const now = Date.now();
  assert.equal(isDormantActivity(0, now), false, 'a zeroed/garbage timestamp is not evidence of dormancy');
  assert.equal(isDormantActivity(now + 60000, now), false, 'a future timestamp (clock skew) is not evidence of dormancy');
});

test('ANTI-BLINDING: non-finite `now` -> false', () => {
  assert.equal(isDormantActivity(Date.now() - 60 * 60 * 1000, NaN), false);
  assert.equal(isDormantActivity(Date.now() - 60 * 60 * 1000, undefined), false);
});

// ---- 6: dormantThresholdMs / idleThresholdMs -------------------------------

test('dormantThresholdMs: defaults to 30 minutes; honours ANTIHALL_DEVSWARM_DORMANT_MS; rejects garbage', () => {
  assert.equal(DEFAULT_DORMANT_MS, 30 * 60 * 1000);
  assert.equal(dormantThresholdMs({}), 30 * 60 * 1000);
  assert.equal(dormantThresholdMs({ ANTIHALL_DEVSWARM_DORMANT_MS: '5000' }), 5000);
  // non-numeric / non-positive -> fall back to default, never crash or coerce to 0.
  assert.equal(dormantThresholdMs({ ANTIHALL_DEVSWARM_DORMANT_MS: 'not-a-number' }), DEFAULT_DORMANT_MS);
  assert.equal(dormantThresholdMs({ ANTIHALL_DEVSWARM_DORMANT_MS: '0' }), DEFAULT_DORMANT_MS);
  assert.equal(dormantThresholdMs({ ANTIHALL_DEVSWARM_DORMANT_MS: '-100' }), DEFAULT_DORMANT_MS);
});

test('idleThresholdMs: defaults to 6 hours; honours ANTIHALL_DEVSWARM_IDLE_MS; rejects garbage', () => {
  assert.equal(DEFAULT_ROSTER_IDLE_MS, 6 * 60 * 60 * 1000);
  assert.equal(idleThresholdMs({}), 6 * 60 * 60 * 1000);
  assert.equal(idleThresholdMs({ ANTIHALL_DEVSWARM_IDLE_MS: '5000' }), 5000);
  assert.equal(idleThresholdMs({ ANTIHALL_DEVSWARM_IDLE_MS: 'not-a-number' }), DEFAULT_ROSTER_IDLE_MS);
  assert.equal(idleThresholdMs({ ANTIHALL_DEVSWARM_IDLE_MS: '0' }), DEFAULT_ROSTER_IDLE_MS);
  assert.equal(idleThresholdMs({ ANTIHALL_DEVSWARM_IDLE_MS: '-100' }), DEFAULT_ROSTER_IDLE_MS);
});

// ---- P2-a: Number()-based parsing table (both threshold readers) ----------
// parseInt STOPS at the first non-digit instead of rejecting the whole
// string, so "30min" silently parsed as 30 (a 30-MILLISECOND threshold) and
// "1e6" (a legitimate exponential form) parsed as 1, not 1000000. Both
// readers must now use Number() over the WHOLE trimmed string instead.
for (const [name, reader, dflt] of [
  ['dormantThresholdMs', dormantThresholdMs, DEFAULT_DORMANT_MS],
  ['idleThresholdMs', idleThresholdMs, DEFAULT_ROSTER_IDLE_MS],
]) {
  const envKey = name === 'dormantThresholdMs' ? 'ANTIHALL_DEVSWARM_DORMANT_MS' : 'ANTIHALL_DEVSWARM_IDLE_MS';

  test(`${name}: Number() parsing table — " 900000 " -> 900000 (trimmed)`, () => {
    assert.equal(reader({ [envKey]: ' 900000 ' }), 900000);
  });
  test(`${name}: Number() parsing table — "0" -> default (rejected, not coerced to 0)`, () => {
    assert.equal(reader({ [envKey]: '0' }), dflt);
  });
  test(`${name}: Number() parsing table — "-1" -> default`, () => {
    assert.equal(reader({ [envKey]: '-1' }), dflt);
  });
  test(`${name}: Number() parsing table — "abc" -> default`, () => {
    assert.equal(reader({ [envKey]: 'abc' }), dflt);
  });
  test(`${name}: Number() parsing table — "" -> default`, () => {
    assert.equal(reader({ [envKey]: '' }), dflt);
  });
  test(`${name}: Number() parsing table — undefined -> default`, () => {
    assert.equal(reader({}), dflt);
  });
  test(`${name}: Number() parsing table — "30min" -> default (THE parseInt bug: parseInt would silently read this as 30)`, () => {
    assert.equal(reader({ [envKey]: '30min' }), dflt);
  });
  test(`${name}: Number() parsing table — "1e6" -> 1000000 (THE parseInt bug: parseInt would silently read this as 1)`, () => {
    assert.equal(reader({ [envKey]: '1e6' }), 1000000);
  });
}

// ---- isDormantActivity: opts.thresholdMs override --------------------------

test('isDormantActivity: opts.thresholdMs WINS over the env-derived default', () => {
  const now = Date.now();
  const age = 5000; // 5s — far below the 30-min default, so default reads NOT dormant
  assert.equal(isDormantActivity(now - age, now), false, 'sanity: 5s age is not dormant under the default 30-min window');
  assert.equal(isDormantActivity(now - age, now, {}, { thresholdMs: 1000 }), true,
    'an explicit 1s threshold must win, making the 5s-old activity read as dormant');
});

test('isDormantActivity: opts.thresholdMs wins over an env override too (not just the default)', () => {
  const now = Date.now();
  const age = 50 * 60 * 1000; // 50 min
  // A huge env threshold alone would say "not dormant" (as VACUOUS-RED GUARD below proves).
  assert.equal(isDormantActivity(now - age, now, { ANTIHALL_DEVSWARM_DORMANT_MS: String(age * 100) }), false);
  // But an explicit small thresholdMs must override that env value entirely.
  assert.equal(isDormantActivity(now - age, now, { ANTIHALL_DEVSWARM_DORMANT_MS: String(age * 100) }, { thresholdMs: 1000 }), true);
});

test('isDormantActivity: opts.thresholdMs non-finite/non-positive -> falls back to env/default (does not break existing behaviour)', () => {
  const now = Date.now();
  const age = 50 * 60 * 1000;
  assert.equal(isDormantActivity(now - age, now, {}, { thresholdMs: 0 }), true, 'thresholdMs 0 is not > 0, falls back to default -> still dormant at 50min');
  assert.equal(isDormantActivity(now - age, now, {}, { thresholdMs: -1 }), true);
  assert.equal(isDormantActivity(now - age, now, {}, { thresholdMs: NaN }), true);
  assert.equal(isDormantActivity(now - age, now, {}), true, 'opts omitted entirely -> unchanged behaviour');
});

// ---- 7: displayStatus -------------------------------------------------------
// displayStatus no longer derives dormancy from activityTs itself — it takes a
// caller-supplied `dormant` boolean (P1 fix: the caller decides the window via
// isDormantRow). These cases are wrapped in withCleanEnv (P2-c) because the
// `idle` branch still reads idleThresholdMs(process.env) directly.

test('displayStatus: fresh activity (1 min) -> label active', () => {
  withCleanEnv(() => {
    const now = Date.now();
    const r = displayStatus(false, null, now - 1 * 60 * 1000, now, false);
    assert.equal(r.label, 'active');
  });
});

test('displayStatus: dormant=true -> label dormant, rank 5, regardless of activityTs age', () => {
  withCleanEnv(() => {
    const now = Date.now();
    const r = displayStatus(false, null, now - 50 * 60 * 1000, now, true);
    assert.equal(r.label, 'dormant');
    assert.equal(r.rank, 5);
  });
});

test('displayStatus: dormant=true with 26h-old activity -> label dormant (NOT idle) — the closed-workspace case the owner reported as wrongly showing "idle"', () => {
  withCleanEnv(() => {
    const now = Date.now();
    const r = displayStatus(false, null, now - 26 * 60 * 60 * 1000, now, true);
    assert.equal(r.label, 'dormant');
  });
});

test('displayStatus: dormant=false with old activityTs still falls through to idle/active label (unaffected by the dormant param)', () => {
  withCleanEnv(() => {
    const now = Date.now();
    const r = displayStatus(false, null, now - 26 * 60 * 60 * 1000, now, false);
    assert.equal(r.label, 'idle', '26h old with dormant=false still crosses the idle threshold on its own');
  });
});

test('ANTI-BLINDING: displayStatus with activityTs null, dormant false/omitted -> label active (never dormant)', () => {
  withCleanEnv(() => {
    const now = Date.now();
    const r = displayStatus(false, null, null, now);
    assert.equal(r.label, 'active');
  });
});

test('PRECEDENCE: status escalated with dormant=true -> stays escalated (a wedged child is never demoted to dormant)', () => {
  withCleanEnv(() => {
    const now = Date.now();
    const r = displayStatus(false, 'escalated', now - 26 * 60 * 60 * 1000, now, true);
    assert.equal(r.label, 'escalated');
  });
});

test('PRECEDENCE: archiveReady true with dormant=true -> stays archive-ready', () => {
  withCleanEnv(() => {
    const now = Date.now();
    const r = displayStatus(true, null, now - 26 * 60 * 60 * 1000, now, true);
    assert.equal(r.label, 'archive-ready');
  });
});

// ---- 8: real measured production data (regression table) ------------------

test('REGRESSION (real measured production data): 1 live workspace (36000ms old) is NOT dormant; 3 closed workspaces (2976000/95225000/73594000ms old) ARE dormant', () => {
  const now = Date.now();
  const measured = [
    { label: 'live workspace', ageMs: 36000, expectDormant: false },
    { label: 'closed workspace #1', ageMs: 2976000, expectDormant: true },
    { label: 'closed workspace #2', ageMs: 95225000, expectDormant: true },
    { label: 'closed workspace #3', ageMs: 73594000, expectDormant: true },
  ];
  for (const row of measured) {
    const got = isDormantActivity(now - row.ageMs, now);
    assert.equal(got, row.expectDormant,
      `${row.label} (age ${row.ageMs}ms) expected dormant=${row.expectDormant}, got ${got}`);
  }
});

// ---- 9: vacuous-red guard ---------------------------------------------------

test('VACUOUS-RED GUARD: an absurdly wide ANTIHALL_DEVSWARM_DORMANT_MS flips the 50-min-stale case back to false, proving the threshold comparison actually drives the result', () => {
  const now = Date.now();
  const age = 50 * 60 * 1000;
  // Same inputs as case 2 above, but with a threshold far larger than the age.
  assert.equal(isDormantActivity(now - age, now, { ANTIHALL_DEVSWARM_DORMANT_MS: String(age * 100) }), false,
    'with a threshold configured 100x wider than the age, the same stale activity must NOT be classified dormant');
  // Sanity: the default-threshold case (no env override) still reads dormant,
  // so the flip above is genuinely due to the widened threshold, not some
  // unrelated code path.
  assert.equal(isDormantActivity(now - age, now), true);
});

'use strict';
// task-neglect-e2e — TRUE END-TO-END system test for the v0.29.0 task-neglect
// enforcement. Unlike the per-hook suites (task-guard.test.js / task-tracker.test.js)
// this exercises BOTH real hooks TOGETHER as a system against SHARED, REAL fs state:
//
//   - task-tracker.js  (UserPromptSubmit) — per-turn "TASK REVIEW" review line
//   - task-guard.js    (Stop)             — idle-neglect Stop block + loop-safety
//
// Every step spawns the REAL hook PROCESS (via testHook -> spawnSync of the actual
// hook file) with a REAL stdin JSON payload, and reads the REAL stdout/exit. State
// is REAL on disk: one isolated temp HOME per scenario whose <home>/.anti-hall is
// the dir the hooks resolve from os.homedir(), so the real ~/.anti-hall is NEVER
// touched and we can plant/clear agent heartbeats + observe the loop-state file the
// Stop hook actually writes. Nothing is mocked or stubbed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const TRACKER = 'task-tracker.js'; // UserPromptSubmit
const GUARD = 'task-guard.js';     // Stop

// ---- payload builders (real hook stdin contracts) --------------------------

function trackerPayload(tp) {
  return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'continue', cwd: process.cwd(), transcript_path: tp };
}
function stopPayload(tp) {
  return { hook_event_name: 'Stop', transcript_path: tp, session_id: 't' };
}

// A TodoWrite tool_use line carrying full task records (id/content/status/owner/
// blockedBy) — the shape both hooks reconstruct from the transcript.
function todoWrite(todos) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', id: 'toolu_tw', input: { todos } }] },
  };
}

function trackerCtx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}
function isBlock(r) { return r.status === 0 && r.json && r.json.decision === 'block'; }
function isIdleNeglect(r) { return isBlock(r) && /IDLE NEGLECT/.test(r.json.reason || ''); }

// Plant a REAL fresh heartbeat at <home>/.anti-hall/agents/<id>.json (ts=now) —
// the exact path + format both hooks' agentsRunning() reads (numeric `ts` epoch ms).
function plantFreshAgent(h, id) {
  const dir = path.join(h.antiHall, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'),
    JSON.stringify({ id, ts: Date.now(), status: 'running', step: 'work' }), 'utf8');
}
function clearAgents(h) {
  fs.rmSync(path.join(h.antiHall, 'agents'), { recursive: true, force: true });
}

// The realistic shared transcript: 3 pending tasks —
//   #1 actionable: pending, unowned, no blocker
//   #2 blocked:    pending, blockedBy an OPEN task (#4 in_progress)
//   #3 owned:      pending, owned by a subagent
//   #4 in_progress foundation that blocks #2 (an open, non-actionable task)
function baseTodos() {
  return [
    { id: '1', content: 'refactor the parser', status: 'pending' },
    { id: '2', content: 'wire the cache layer', status: 'pending', blockedBy: ['4'] },
    { id: '3', content: 'ship the docs', status: 'pending', owner: 'worker-7' },
    { id: '4', content: 'design the schema', status: 'in_progress' },
  ];
}

// ===========================================================================
// SCENARIO: one transcript, both hooks, real fs heartbeat state.
// ===========================================================================

test('E2E step 1 — NO heartbeats: task-tracker NAMES only the actionable task + says dispatch/parallel', () => {
  const h = makeHome();
  try {
    clearAgents(h); // ensure no in-flight agents
    const tp = h.writeTranscript([todoWrite(baseTodos())]);
    const r = testHook(TRACKER, trackerPayload(tp), { home: h.home });
    const c = trackerCtx(r);
    assert.strictEqual(r.status, 0);
    // Exactly 1 actionable task; review line emitted, names it, demands parallel dispatch.
    assert.match(c, /TASK REVIEW \(every turn\): 1 non-blocked, unassigned pending task/, c);
    assert.match(c, /parallel/, c);
    assert.match(c, /dispatch a background agent/, c);
    // Isolate the TASK REVIEW dispatch line (ends before the trailing "open tasks:"
    // freshness note, which legitimately reports the oldest in_progress subject).
    const reviewLine = c.slice(c.indexOf('TASK REVIEW'), c.indexOf(' open tasks:'));
    assert.match(reviewLine, /"refactor the parser"/, reviewLine);
    // The blocked + owned + in_progress tasks must NOT be named as dispatch targets.
    assert.doesNotMatch(reviewLine, /wire the cache layer/, reviewLine);
    assert.doesNotMatch(reviewLine, /ship the docs/, reviewLine);
    assert.doesNotMatch(reviewLine, /design the schema/, reviewLine);
  } finally {
    h.cleanup();
  }
});

test('E2E step 2 — same state: task-guard BLOCKS with idle-neglect reason naming the actionable task', () => {
  const h = makeHome();
  try {
    clearAgents(h);
    const tp = h.writeTranscript([todoWrite(baseTodos())]);
    const r = testHook(GUARD, stopPayload(tp), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(isIdleNeglect(r), `expected idle-neglect Stop block; stdout: ${r.stdout}`);
    assert.match(r.json.reason, /refactor the parser/, 'idle-neglect reason names the actionable task');
    assert.match(r.json.reason, /PARALLEL/, 'demands parallel dispatch');
    // Idle-neglect must not name the blocked/owned ones.
    assert.doesNotMatch(r.json.reason, /wire the cache layer/, r.json.reason);
    assert.doesNotMatch(r.json.reason, /ship the docs/, r.json.reason);
  } finally {
    h.cleanup();
  }
});

test('E2E step 3 — FRESH heartbeat planted: BOTH hooks back off (agents in flight)', () => {
  const h = makeHome();
  try {
    // Plant a REAL fresh heartbeat in the temp HOME's agents dir (ts=now).
    plantFreshAgent(h, 'worker-a');
    const tp = h.writeTranscript([todoWrite(baseTodos())]);

    // task-tracker: no per-turn review line while work is in flight.
    const rt = testHook(TRACKER, trackerPayload(tp), { home: h.home });
    assert.doesNotMatch(trackerCtx(rt), /TASK REVIEW/, `agents running -> no review line; got: ${trackerCtx(rt)}`);

    // task-guard: not an idle-neglect block (it may still GENERIC-nudge on the
    // in_progress/blocked/owned open tasks — that is correct; only idle-neglect
    // must be suppressed while agents run).
    const rg = testHook(GUARD, stopPayload(tp), { home: h.home });
    assert.ok(!isIdleNeglect(rg), `agents running -> must NOT idle-neglect-block; reason: ${rg.json && rg.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('E2E step 4 — actionable task in_progress: neither hook flags it', () => {
  const h = makeHome();
  try {
    clearAgents(h); // no agents — isolate the in_progress effect
    const todos = baseTodos();
    todos[0].status = 'in_progress'; // the formerly-actionable #1 is now being worked
    const tp = h.writeTranscript([todoWrite(todos)]);

    // task-tracker: #1 is in_progress (not pending) -> not actionable; #2 blocked,
    // #3 owned -> 0 actionable -> no review line.
    const rt = testHook(TRACKER, trackerPayload(tp), { home: h.home });
    assert.doesNotMatch(trackerCtx(rt), /TASK REVIEW/, `no actionable -> no review line; got: ${trackerCtx(rt)}`);

    // task-guard: 0 actionable -> NOT idle-neglect (open tasks still -> generic nudge ok).
    const rg = testHook(GUARD, stopPayload(tp), { home: h.home });
    assert.ok(!isIdleNeglect(rg), `in_progress actionable -> not idle-neglect; reason: ${rg.json && rg.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('E2E step 5a — loop-safety: SAME actionable set + no agents -> blocks once then dedupes', () => {
  const h = makeHome();
  try {
    clearAgents(h);
    const tp = h.writeTranscript([todoWrite(baseTodos())]);
    // First Stop -> idle-neglect block (writes the REAL loop-state file).
    const r1 = testHook(GUARD, stopPayload(tp), { home: h.home });
    assert.ok(isIdleNeglect(r1), `first Stop should idle-neglect; stdout: ${r1.stdout}`);
    // Identical set, second Stop -> dedupes via the on-disk hash (no second block).
    const tp2 = h.writeTranscript([todoWrite(baseTodos())]);
    const r2 = testHook(GUARD, stopPayload(tp2), { home: h.home });
    assert.ok(!isBlock(r2), `identical actionable set must dedupe; stdout: ${r2.stdout}`);
    // Confirm the REAL loop-state file exists with blocks=1.
    const stateFile = path.join(h.antiHall, 'last-stop-taskset-t');
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(st.blocks, 1, `loop-state should record exactly 1 block; got ${st.blocks}`);
  } finally {
    h.cleanup();
  }
});

test('E2E step 5b — loop-safety: CHURNING actionable set capped at MAX_BLOCKS (5)', () => {
  const h = makeHome();
  try {
    clearAgents(h);
    // Each Stop presents a DIFFERENT actionable set (defeats hash dedupe) — only the
    // absolute MAX_BLOCKS cap can stop it. All against the REAL on-disk loop-state.
    let blocked = 0;
    for (let i = 0; i < 12; i++) {
      const tp = h.writeTranscript([
        todoWrite([{ id: 'churn-' + i, content: 'churning task ' + i, status: 'pending' }]),
      ]);
      const r = testHook(GUARD, stopPayload(tp), { home: h.home });
      if (isBlock(r)) blocked++;
    }
    assert.ok(blocked >= 1, `should have blocked at least once; got ${blocked}`);
    assert.ok(blocked <= 5, `MAX_BLOCKS cap must hold; got ${blocked} blocks across 12 churning Stops`);
    const st = JSON.parse(fs.readFileSync(path.join(h.antiHall, 'last-stop-taskset-t'), 'utf8'));
    assert.ok(st.blocks <= 5, `on-disk block count must be capped; got ${st.blocks}`);
  } finally {
    h.cleanup();
  }
});

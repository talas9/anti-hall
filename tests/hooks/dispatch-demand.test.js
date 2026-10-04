'use strict';
// dispatch-demand — the per-turn "DISPATCH NOW in parallel" demand (task-tracker)
// and task-guard IDLE NEGLECT, driven by REAL transcript shapes (TaskCreate
// tool_use + "Task #N created successfully" tool_result, TaskUpdate with
// taskId/addBlockedBy, background Agent launch + <task-notification>).
//
// Field regression (2026-09-27): a Primary had 9 pending, unblocked, unowned
// tasks and ONE of its own background agents running (on an in_progress task).
// The demand never appeared because both hooks treated ANY fresh
// ~/.anti-hall/agents/*.json heartbeat (phase-tracker's machine-global
// recent-spawn.json) as covering EVERY task. Coverage is now per task.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const TRACKER = 'task-tracker.js';
const GUARD = 'task-guard.js';
const NO_DEDUPE = { ANTIHALL_EMIT_DEDUPE: '0' };
// HIGH_CAP: pin guards.maxParallelDispatch above every running-agent count
// used in this file (max 2) so these tests assert per-task coverage/heartbeat
// logic, not the host's core count. defaultCap() is min(16, cores-2), so a
// low-core CI runner (2-4 vCPUs, common on hosted macOS/ubuntu runners) can
// silently drop the dynamic default to 1-2, which starved these assertions
// on CI while passing locally on higher-core dev machines (2026-09-28 CI
// regression). Tests that specifically exercise the cap feature itself still
// use their own explicit ANTIHALL_MAX_PARALLEL_DISPATCH value.
const HIGH_CAP = { ANTIHALL_MAX_PARALLEL_DISPATCH: '16' };

const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60 * 1000).toISOString();

function taskCreate(tuid, subject, metadata, ts) {
  return {
    type: 'assistant', timestamp: ts || iso(30),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: 'TaskCreate', input: Object.assign({ subject, description: subject }, metadata ? { metadata } : {}) }] },
  };
}
function taskCreated(tuid, n, subject, ts) {
  return {
    type: 'user', timestamp: ts || iso(30),
    message: { role: 'user', content: [{ tool_use_id: tuid, type: 'tool_result', content: 'Task #' + n + ' created successfully: ' + subject }] },
  };
}
function taskUpdate(tuid, input, ts) {
  return {
    type: 'assistant', timestamp: ts || iso(29),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: 'TaskUpdate', input }] },
  };
}
// A background Agent launch in THIS transcript (real launch-result text).
function agentLaunch(tuid, agentId, description, ts) {
  const text =
    'Async agent launched successfully. (This tool result is internal metadata.)\n' +
    'agentId: ' + agentId + " (internal ID - do not mention to user. Use SendMessage with to: '" + agentId + "')\n" +
    'The agent is working in the background. You will be notified automatically when it completes.\n' +
    'output_file: /tmp/none/' + agentId + '.output\n';
  return [
    { type: 'assistant', timestamp: ts || iso(10), message: { role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: 'Agent', input: { description, prompt: 'do it', run_in_background: true } }] } },
    { type: 'user', timestamp: ts || iso(10), message: { role: 'user', content: [{ tool_use_id: tuid, type: 'tool_result', content: [{ type: 'text', text }] }] } },
  ];
}
// A SendMessage to a background agent that carries a "Resuming agent <id>"
// tool_result — the real shape when the harness resumes a subagent stopped by
// a usage limit.
function sendMessageResume(tuid, agentId, ts) {
  const text = 'Resuming agent ' + agentId + ' (internal ID - do not mention to user).\n';
  return [
    { type: 'assistant', timestamp: ts || iso(4), message: { role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: 'SendMessage', input: { to: agentId, summary: 'continue' } }] } },
    { type: 'user', timestamp: ts || iso(4), message: { role: 'user', content: [{ tool_use_id: tuid, type: 'tool_result', content: [{ type: 'text', text }] }] } },
  ];
}
function agentDone(agentId, ts) {
  return {
    type: 'queue-operation', operation: 'enqueue', timestamp: ts || iso(5),
    content: '<task-notification>\n<task-id>' + agentId + '</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>',
  };
}
// n tasks created with the real two-line shape.
function createTasks(subjects, startN, meta) {
  const out = [];
  subjects.forEach((s, i) => {
    const tu = 'toolu_c' + (startN + i);
    out.push(taskCreate(tu, s, meta && meta[i]));
    out.push(taskCreated(tu, startN + i, s));
  });
  return out;
}

function trackerPayload(tp, sid) {
  return { hook_event_name: 'UserPromptSubmit', session_id: sid || 't', prompt: 'continue', cwd: process.cwd(), transcript_path: tp };
}
function stopPayload(tp) { return { hook_event_name: 'Stop', transcript_path: tp, session_id: 't' }; }
function ctx(r) { return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || ''; }
function isIdleNeglect(r) { return r.status === 0 && r.json && r.json.decision === 'block' && /have no in-flight agent/.test(r.json.reason || ''); }
function demandLine(c) {
  const i = c.indexOf('DISPATCH NOW');
  return i < 0 ? '' : c.slice(i, c.indexOf(' open tasks:', i));
}
function plantGlobalHeartbeat(h) {
  const dir = path.join(h.antiHall, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'recent-spawn.json'), JSON.stringify({ ts: Date.now() }), 'utf8');
}

// The field shape: 3 in_progress (one with its own running agent), 2 blocked
// via addBlockedBy, 1 OWNER:, and dispatchable P1 work. (Priority kept at/above
// the idle-neglect floor -- guards.idleNeglectMinPriority, default P1, added by
// 362d049 -- so this fixture still exercises per-task coverage/heartbeat logic
// rather than being filtered out as non-nagging P2/P3 backlog.)
function fieldTranscript() {
  return [
    ...createTasks([
      'P1: Release candidate',          // #1 in_progress
      'P1: Supervision lane',           // #2 in_progress, has an agent
      'P1: Respawn verb',               // #3 addBlockedBy #2
      'P1: mcp-reaper matcher',         // #4 dispatchable
      'P1: scan-throttle heredoc copy', // #5 dispatchable
      'OWNER: decisions pending',       // #6 owner-blocked
      'P1: archive signals child',      // #7 dispatchable
    ], 1, [null, null, null, { priority: 'P1' }, { priority: 'P1' }, null, { priority: 'P1' }]),
    taskUpdate('toolu_u1', { taskId: '1', status: 'in_progress' }),
    taskUpdate('toolu_u2', { taskId: '2', status: 'in_progress' }),
    taskUpdate('toolu_u3', { taskId: '3', addBlockedBy: ['2'] }),
    ...agentLaunch('toolu_a1', 'ad90a5a6fa875ab0c', 'Resume supervision lane in clone'),
  ];
}

test('FIELD REGRESSION: one own agent + global heartbeat -> task-tracker still demands dispatch, naming each id', () => {
  const h = makeHome();
  try {
    plantGlobalHeartbeat(h);
    const tp = h.writeTranscript(fieldTranscript());
    const line = demandLine(ctx(testHook(TRACKER, trackerPayload(tp), { home: h.home, env: Object.assign({}, NO_DEDUPE, HIGH_CAP) })));
    assert.match(line, /^DISPATCH NOW in parallel/, line);
    assert.match(line, /#4 "mcp-reaper matcher"/, line);
    assert.match(line, /#5 "scan-throttle heredoc copy"/, line);
    assert.match(line, /#7 "archive signals child"/, line);
    for (const n of ['#1 ', '#2 ', '#3 ', '#6 ']) assert.ok(!line.includes(n), n + ' must not be listed: ' + line);
  } finally { h.cleanup(); }
});

test('FIELD REGRESSION: same state at Stop -> task-guard IDLE NEGLECT blocks (global heartbeat does not suppress)', () => {
  const h = makeHome();
  try {
    plantGlobalHeartbeat(h);
    const tp = h.writeTranscript(fieldTranscript());
    const r = testHook(GUARD, stopPayload(tp), { home: h.home, env: HIGH_CAP });
    assert.ok(isIdleNeglect(r), 'expected IDLE NEGLECT; stdout: ' + r.stdout);
    assert.match(r.json.reason, /#5 "scan-throttle heredoc copy"/, r.json.reason);
    assert.doesNotMatch(r.json.reason, /Respawn verb/, 'addBlockedBy task is blocked: ' + r.json.reason);
  } finally { h.cleanup(); }
});

test('PER-TASK COVERAGE: agents naming #1 and #2 cover them; #3 still demanded', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      ...createTasks(['alpha work', 'beta work', 'gamma work'], 1),
      ...agentLaunch('toolu_a1', 'aaaaaaaaaaaaaaaa1', 'Lane A: #1 alpha'),
      ...agentLaunch('toolu_a2', 'aaaaaaaaaaaaaaaa2', 'Lane B: #2 beta'),
    ]);
    const line = demandLine(ctx(testHook(TRACKER, trackerPayload(tp), { home: h.home, env: HIGH_CAP })));
    assert.match(line, /#3 "gamma work"/, line);
    assert.ok(!/#1 |#2 /.test(line), 'covered tasks must not be listed: ' + line);
  } finally { h.cleanup(); }
});

test('ALL COVERED: every pending task named by a running agent -> no demand, no IDLE NEGLECT', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      ...createTasks(['alpha work', 'beta work'], 1),
      ...agentLaunch('toolu_a1', 'bbbbbbbbbbbbbbbb1', 'Lanes #1 #2'),
    ]);
    assert.doesNotMatch(ctx(testHook(TRACKER, trackerPayload(tp), { home: h.home })), /DISPATCH NOW/);
    assert.ok(!isIdleNeglect(testHook(GUARD, stopPayload(tp), { home: h.home })));
  } finally { h.cleanup(); }
});

test('UNMAPPED agents count one task each: 2 unmapped agents, 2 pending -> no demand; 3 pending -> demand', () => {
  const h = makeHome();
  try {
    const two = h.writeTranscript([
      ...createTasks(['one', 'two'], 1),
      ...agentLaunch('toolu_a1', 'cccccccccccccccc1', 'investigate thing'),
      ...agentLaunch('toolu_a2', 'cccccccccccccccc2', 'investigate other'),
    ]);
    assert.doesNotMatch(ctx(testHook(TRACKER, trackerPayload(two), { home: h.home })), /DISPATCH NOW/);
  } finally { h.cleanup(); }
  const h2 = makeHome();
  try {
    const three = h2.writeTranscript([
      ...createTasks(['one', 'two', 'three'], 1),
      ...agentLaunch('toolu_a1', 'cccccccccccccccc1', 'investigate thing'),
      ...agentLaunch('toolu_a2', 'cccccccccccccccc2', 'investigate other'),
    ]);
    assert.match(ctx(testHook(TRACKER, trackerPayload(three), { home: h2.home, env: HIGH_CAP })), /DISPATCH NOW in parallel/);
  } finally { h2.cleanup(); }
});

test('FINISHED agent no longer covers its task', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      ...createTasks(['alpha work'], 1),
      ...agentLaunch('toolu_a1', 'dddddddddddddddd1', 'Lane #1'),
      agentDone('dddddddddddddddd1'),
    ]);
    assert.match(demandLine(ctx(testHook(TRACKER, trackerPayload(tp), { home: h.home }))), /#1 "alpha work"/);
  } finally { h.cleanup(); }
});

test('TASK-ID EPOCH: numbering restarts at #1 -> pre-restart tasks (update-only #50) are dropped', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      taskUpdate('toolu_old', { taskId: '50', status: 'in_progress' }, iso(60)),
      taskUpdate('toolu_old2', { taskId: '13', status: 'pending' }, iso(60)),
      ...createTasks(['fresh one'], 1),
    ]);
    const c = ctx(testHook(TRACKER, trackerPayload(tp), { home: h.home }));
    assert.match(c, /open tasks: 1 — /, c);
    assert.doesNotMatch(c, /"50"|#13/, c);
  } finally { h.cleanup(); }
});

test('TAIL WINDOW: a task created >256KB before the end is still seen', () => {
  const h = makeHome();
  try {
    const filler = { type: 'user', timestamp: iso(20), message: { role: 'user', content: 'x'.repeat(100 * 1024) } };
    const tp = h.writeTranscript([...createTasks(['early task'], 1), filler, filler, filler, filler]);
    assert.match(demandLine(ctx(testHook(TRACKER, trackerPayload(tp), { home: h.home }))), /#1 "early task"/);
  } finally { h.cleanup(); }
});

test('METRICS: demand shown -> next turn with an Agent spawn scores followed; IDLE NEGLECT counted', () => {
  const h = makeHome();
  try {
    const base = createTasks(['alpha work', 'beta work'], 1);
    const tp = h.writeTranscript(base);
    testHook(TRACKER, trackerPayload(tp), { home: h.home, env: NO_DEDUPE });
    const mpath = path.join(h.antiHall, 'dispatch-demand-metrics.json');
    let m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
    assert.strictEqual(m.demandsShown, 1);
    // Same turn: the Primary spawns an agent (timestamp after the demand).
    const later = new Date(Date.now() + 1000).toISOString();
    fs.appendFileSync(tp, agentLaunch('toolu_a9', 'eeeeeeeeeeeeeee1', 'Lane #1 #2', later).map((l) => JSON.stringify(l)).join('\n') + '\n');
    testHook(TRACKER, trackerPayload(tp), { home: h.home, env: NO_DEDUPE });
    m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
    assert.strictEqual(m.demandsFollowed, 1, JSON.stringify(m));
    assert.strictEqual(m.demandsIgnored, 0, JSON.stringify(m));
    // A Stop with uncovered work -> IDLE NEGLECT counter.
    const h2tp = h.writeTranscript(createTasks(['gamma'], 1));
    testHook(GUARD, stopPayload(h2tp), { home: h.home });
    m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
    assert.strictEqual(m.idleNeglectBlocks, 1, JSON.stringify(m));
    // The report surfaces the three metrics.
    const rep = require('../../plugins/anti-hall/scripts/dispatch-report.js').build(h.home).dispatchDemand;
    assert.deepStrictEqual(
      [rep.demandsShown, rep.demandsFollowed, rep.complianceRate, rep.idleNeglectBlocks], [1, 1, 1, 1]);
  } finally { h.cleanup(); }
});

test('SETTING guards.dispatchDemand off -> no DISPATCH NOW line; task-guard falls back to the legacy heartbeat rule', () => {
  const h = makeHome();
  try {
    plantGlobalHeartbeat(h);
    const tp = h.writeTranscript(createTasks(['alpha work'], 1));
    const env = { ANTIHALL_DISPATCH_DEMAND: 'off' };
    assert.doesNotMatch(ctx(testHook(TRACKER, trackerPayload(tp), { home: h.home, env })), /DISPATCH NOW/);
    assert.ok(!isIdleNeglect(testHook(GUARD, stopPayload(tp), { home: h.home, env })));
  } finally { h.cleanup(); }
});

// ---- SENDMESSAGE-RESUMED AGENTS (0.117 field report): a background agent
// resumed via SendMessage after a usage-limit stop must count as RUNNING
// again, not terminal from whatever ended it before the resume. ----

function agentStopped(agentId, ts) {
  return {
    type: 'queue-operation', operation: 'enqueue', timestamp: ts || iso(5),
    content: '<task-notification>\n<task-id>' + agentId + '</task-id>\n<status>stopped</status>\n<summary>usage limit</summary>\n</task-notification>',
  };
}

test('RESUME (real): a "stopped" notification then a later SendMessage resume with NO further notification -> agent still covers its task, no demand for it', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      ...createTasks(['alpha work'], 1),
      ...agentLaunch('toolu_a1', 'ffffffffffffffff1', 'Lane #1 alpha', iso(20)),
      agentStopped('ffffffffffffffff1', iso(15)),
      ...sendMessageResume('toolu_r1', 'ffffffffffffffff1', iso(4)),
    ]);
    assert.doesNotMatch(ctx(testHook(TRACKER, trackerPayload(tp), { home: h.home })), /DISPATCH NOW/,
      'resumed agent must still cover #1 -> no demand');
    assert.ok(!isIdleNeglect(testHook(GUARD, stopPayload(tp), { home: h.home })), 'resumed agent must not IDLE NEGLECT #1');
  } finally { h.cleanup(); }
});

test('RESUME (real): a genuine completion notification AFTER the resume still marks the agent terminal', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      ...createTasks(['alpha work'], 1),
      ...agentLaunch('toolu_a1', 'ffffffffffffffff2', 'Lane #1 alpha', iso(20)),
      agentStopped('ffffffffffffffff2', iso(15)),
      ...sendMessageResume('toolu_r1', 'ffffffffffffffff2', iso(10)),
      agentDone('ffffffffffffffff2', iso(2)),
    ]);
    assert.match(demandLine(ctx(testHook(TRACKER, trackerPayload(tp), { home: h.home }))), /#1 "alpha work"/,
      'a real completion AFTER the resume must still free up #1 for redispatch');
  } finally { h.cleanup(); }
});

// ---- guards.maxParallelDispatch (0.117): a one-implementation-agent-per-
// workspace owner sets this to 1 so the demand only asks for the NEXT task
// once nothing is running, instead of piling on parallel-dispatch pressure. ----

test('SETTING guards.maxParallelDispatch=1: one running (unmapped) agent -> no demand for the remaining pending task', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      ...createTasks(['alpha work', 'beta work'], 1),
      ...agentLaunch('toolu_a1', '1111111111111111a', 'working on something'),
    ]);
    // Baseline (cap well above the running count, not the host's dynamic
    // default — defaultCap() is min(16, cores-2), which a low-core CI runner
    // can shrink to 1-2 and starve this assertion for a reason unrelated to
    // the feature under test): one unmapped running agent absorbs ONE pending
    // task, the other is still demanded. NO_DEDUPE on both calls — otherwise
    // the second (byte-identical, pre-fix) emission would be silently
    // collapsed by the burst-collapse dedupe and the assertion would pass for
    // the wrong reason.
    assert.match(ctx(testHook(TRACKER, trackerPayload(tp), { home: h.home, env: Object.assign({}, NO_DEDUPE, HIGH_CAP) })), /DISPATCH NOW/,
      'baseline: a cap above the running count still demands the second task');
    const env = Object.assign({ ANTIHALL_MAX_PARALLEL_DISPATCH: '1' }, NO_DEDUPE);
    assert.doesNotMatch(ctx(testHook(TRACKER, trackerPayload(tp), { home: h.home, env })), /DISPATCH NOW/,
      'cap=1 with one already running -> no demand for the next task');
  } finally { h.cleanup(); }
});

// ---- L34: running-agent count must come from durable evidence, never a guessed 0 ----
// Field (tf3-scanner, 0.120.7): right after /reload-plugins the line said
// "DISPATCH NOW … (0 running, cap 14)" while an agent spawned BEFORE the reload
// was still running. The count is transcript-derived (agent-scan), not
// plugin-version-keyed; the verified way to read 0 wrongly is the launch
// tool_result sitting before the capped 1.5MB tail window (or an unreadable
// scan collapsing to []).
function fillerEntry(bytes) {
  return { type: 'user', timestamp: iso(8), message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(bytes) }] } };
}

// 13MB filler: beyond the widened (12MB) proof window too, so the launch is unreachable.
test('L34: agent launched BEFORE the tail window (still pending) -> count unknown, NO "DISPATCH NOW (0 running)"', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      ...agentLaunch('toolu_a1', 'abcdef123456', 'long-running reviewer'),
      fillerEntry(13 * 1024 * 1024),
      ...createTasks(['write the docs'], 1),
    ]);
    const r = testHook(TRACKER, trackerPayload(tp), { home: h.home, env: Object.assign({}, NO_DEDUPE, HIGH_CAP) });
    assert.strictEqual(r.status, 0);
    assert.doesNotMatch(ctx(r), /DISPATCH NOW/, ctx(r));
    assert.match(ctx(r), /running-agent count unknown/, ctx(r));
  } finally { h.cleanup(); }
});

test('L34: agent launched in-window and pending is counted regardless of plugin version path', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      ...agentLaunch('toolu_a1', 'abcdef123456', 'reviewer on #1'),
      ...createTasks(['write the docs', 'second thing'], 1),
    ]);
    for (const root of ['/x/cache/anti-hall/0.120.7', '/x/cache/anti-hall/0.120.8']) {
      const r = testHook(TRACKER, trackerPayload(tp), { home: h.home, env: Object.assign({}, NO_DEDUPE, HIGH_CAP, { CLAUDE_PLUGIN_ROOT: root }) });
      assert.match(demandLine(ctx(r)), /\(1 running, cap 16\)/, ctx(r));
    }
  } finally { h.cleanup(); }
});

test('L34: transcript unreadable by the scan -> evaluate() reports unknown, never fires', () => {
  const DD = require('../../plugins/anti-hall/hooks/lib/dispatch-demand.js');
  const res = DD.evaluate({ actionable: [{ id: '1', content: 'a' }], knownIds: ['1'], running: null, cap: 14 });
  assert.strictEqual(res.fire, false);
  assert.strictEqual(res.unknown, true);
});

// ---- idle-neglect message: how to mark a task an agent already covers ----
const P1 = { priority: 'P1' };
const BRICK = 'P1 Brick modal: SOC Not read + raw BLE';
const PYRO = 'P1 Pyro colour from health signal';
const MATCH_ENV = Object.assign({}, HIGH_CAP);

test('unrelated running agent -> a pending task still blocks (no word matching)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      ...agentLaunch('toolu_a1', 'ffffffffffffffff1', 'Refactor billing invoice exporter', iso(40)),
      ...createTasks([BRICK, PYRO], 1, [P1, P1]),
    ]);
    const line = demandLine(ctx(testHook(TRACKER, trackerPayload(tp), { home: h.home, env: MATCH_ENV })));
    assert.match(line, /#1 /, line);
    assert.match(line, /#2 /, line);
    assert.ok(isIdleNeglect(testHook(GUARD, stopPayload(tp), { home: h.home, env: MATCH_ENV })));
  } finally { h.cleanup(); }
});

test('owner set -> attended (unchanged); both messages carry the owner hint', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      ...createTasks([BRICK, PYRO], 1, [P1, P1]),
      taskUpdate('toolu_u1', { taskId: '1', owner: 'agent-x' }),
      taskUpdate('toolu_u2', { taskId: '2', owner: 'agent-y' }),
    ]);
    assert.doesNotMatch(ctx(testHook(TRACKER, trackerPayload(tp), { home: h.home, env: MATCH_ENV })), /DISPATCH NOW/);
  } finally { h.cleanup(); }
  const h2 = makeHome();
  try {
    const tp = h2.writeTranscript(createTasks([BRICK, PYRO], 1, [P1, P1]));
    assert.match(ctx(testHook(TRACKER, trackerPayload(tp), { home: h2.home, env: MATCH_ENV })), /set the task's owner to it \(TaskUpdate owner\)/);
    const r = testHook(GUARD, stopPayload(tp), { home: h2.home, env: MATCH_ENV });
    assert.ok(isIdleNeglect(r));
    assert.match(r.json.reason, /set the task owner to it \(TaskUpdate owner\)/);
  } finally { h2.cleanup(); }
});

'use strict';
// idle-agent-sweep (UserPromptSubmit, advisory only): lists agents that finished
// but were never stopped (Claude teammates) / closed (Codex multi_agent_v1).
// Transcript entries use the real record shapes (tests/helpers/teammate-fixtures.js;
// Codex rollout lines as written by codex-cli 0.160). Every spawn uses an isolated HOME.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const { spawn, send, stop } = require('../helpers/teammate-fixtures.js');

const HOOK = 'idle-agent-sweep.js';
const ago = (min) => new Date(Date.now() - min * 60 * 1000).toISOString();
const ctx = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
const silent = (r) => r.status === 0 && !String(r.stdout || '').trim();
const payload = (tp, prompt) => ({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-idle', prompt: prompt || 'status?', transcript_path: tp, cwd: '/tmp' });

// A teammate's end-of-turn report; reason undefined = no idleReason field
// (the "still running, waiting on the monitor" shape).
function report(name, ts, reason) {
  const o = { type: 'idle_notification', from: name, timestamp: ts };
  if (reason !== undefined) o.idleReason = reason;
  o.result = 'report text';
  return [{
    type: 'user',
    message: { role: 'user', content: 'Another Claude session sent a message:\n<teammate-message teammate_id="' + name + '" color="blue">\n' + JSON.stringify(o) + '\n</teammate-message>\n\nThis came from another Claude session.' },
    timestamp: ts,
  }];
}
const finished = (name, spawnMin, idleMin, reason) => [spawn(name, ago(spawnMin)), report(name, ago(idleMin), reason === undefined ? 'available' : reason)].flat();
const names = (n) => Array.from({ length: n }, (_, i) => 'tf-' + String(i + 1).padStart(2, '0'));

function run(entries, opts) {
  const o = opts || {};
  const h = makeHome();
  try {
    if (o.settings) fs.writeFileSync(path.join(h.antiHall, 'settings.json'), JSON.stringify({ guards: o.settings }));
    let tp;
    if (o.rollout) {
      tp = path.join(h.home, '.codex', 'sessions', 'rollout-2026-10-04T10-00-00-x.jsonl');
      fs.mkdirSync(path.dirname(tp), { recursive: true });
      fs.writeFileSync(tp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    } else tp = h.writeTranscript(entries);
    const runs = [];
    for (const p of o.prompts || [o.prompt]) runs.push(testHook(HOOK, payload(tp, p), { home: h.home, env: o.env || {} }));
    return o.prompts ? runs : runs[0];
  } finally { h.cleanup(); }
}

test('FIELD CASE: 34 finished teammates not stopped -> one advisory naming 10 + "and 24 more", oldest first, exact TaskStop call', () => {
  const all = names(34);
  const e = all.flatMap((n, i) => finished(n, 200, 120 - i)); // tf-01 idle longest
  const r = run(e);
  assert.strictEqual(r.status, 0);
  const t = ctx(r);
  assert.match(t, /^💡 anti-hall · idle-agents: 34 finished agents are idle and not stopped: tf-01 \(120m\), tf-02 \(119m\),/);
  assert.match(t, /tf-10 \(111m\), and 24 more\./);
  assert.ok(!/tf-11/.test(t), 'capped at 10 names');
  assert.match(t, /TaskStop \{"task_id":"tf-01"\}/);
  assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.strictEqual(r.json.decision, undefined, 'advisory only, never a block');
});

test('after TaskStop of every one -> silent; stopped by <name>@<team> id counts too', () => {
  const all = names(34);
  const e = all.flatMap((n) => finished(n, 200, 100));
  assert.ok(silent(run(e.concat(all.flatMap((n) => stop(n, ago(1)))))));
  assert.ok(silent(run(e.concat(all.flatMap((n) => stop(n + '@session-fx', ago(1)))))));
});

test('an errored TaskStop stopped nothing -> still listed', () => {
  const e = finished('tf-a', 60, 40).concat(stop('tf-a', ago(1), { error: true }));
  assert.match(ctx(run(e)), /idle-agents: 1 finished agent is idle and not stopped: tf-a \(40m\)/);
});

test('re-tasked via SendMessage after its report -> not idle; reports again later -> idle again', () => {
  const base = finished('tf-a', 90, 60);
  assert.ok(silent(run(base.concat(send('tf-a', ago(30))))));
  assert.match(ctx(run(base.concat(send('tf-a', ago(30)), report('tf-a', ago(20), 'available')))), /tf-a \(20m\)/);
});

test('still running (no report) or waiting on its own work (idle_notification with no idleReason) -> not idle', () => {
  assert.ok(silent(run([spawn('tf-a', ago(90))].flat())));
  const waiting = [spawn('tf-a', ago(90)), report('tf-a', ago(60), undefined)].flat();
  assert.ok(silent(run(waiting)));
  // final report, then a later no-reason idle -> waiting again
  assert.ok(silent(run(finished('tf-a', 90, 60).concat(report('tf-a', ago(50), undefined)))));
});

test('idleReason "failed" counts as finished', () => {
  assert.match(ctx(run(finished('tf-a', 90, 30, 'failed'))), /tf-a \(30m\)/);
});

test('a background agent with a completed notification is not listed (it already ended)', () => {
  const ID = 'abcd111122223333e';
  const launch = { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_l', type: 'tool_result', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: ' + ID + '\noutput_file: /nonexistent/x.output' }] }] }, timestamp: ago(120) };
  const notif = { type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>' + ID + '</task-id>\n<status>completed</status>\n</task-notification>' }, timestamp: ago(90) };
  assert.ok(silent(run([launch, notif])));
});

test('thresholds: 2 fresh -> silent; 3 fresh -> fires; 1 idle >= 15 min -> fires; settings move both', () => {
  const two = names(2).flatMap((n) => finished(n, 20, 5));
  const three = names(3).flatMap((n) => finished(n, 20, 5));
  assert.ok(silent(run(two)));
  assert.match(ctx(run(three)), /3 finished agents/);
  assert.match(ctx(run(finished('tf-a', 30, 16))), /1 finished agent is idle/);
  assert.ok(silent(run(finished('tf-a', 30, 14))));
  assert.ok(silent(run(three, { settings: { idleAgentSweepCount: 4 } })));
  assert.ok(silent(run(finished('tf-a', 30, 16), { settings: { idleAgentSweepMin: 60 } })));
  assert.match(ctx(run(two, { env: { ANTIHALL_IDLE_AGENT_SWEEP_COUNT: '2' } })), /2 finished agents/);
});

test('once per turn: a queued burst gets one copy; a task-notification turn is skipped', () => {
  const e = names(3).flatMap((n) => finished(n, 60, 30));
  const [a, b] = run(e, { prompts: ['first', 'second queued'] });
  assert.match(ctx(a), /idle-agents: 3 finished/);
  assert.ok(silent(b), 'second copy in the same undelivered burst suppressed');
  assert.ok(silent(run(e, { prompt: '<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>' })));
});

test('SETTING OFF: env and settings file; skip.json; bad input -> silent', () => {
  const e = names(3).flatMap((n) => finished(n, 60, 30));
  assert.ok(silent(run(e, { env: { ANTIHALL_IDLE_AGENT_SWEEP: 'off' } })));
  assert.ok(silent(run(e, { settings: { idleAgentSweep: false } })));
  const h = makeHome();
  try {
    const tp = h.writeTranscript(e);
    h.writeSkip({ 'idle-agent-sweep': Date.now() + 60000 });
    assert.ok(silent(testHook(HOOK, payload(tp), { home: h.home })));
    assert.ok(silent(testHookRaw(HOOK, '{not json', { home: h.home })));
    assert.ok(silent(testHook(HOOK, payload(path.join(h.home, 'missing.jsonl')), { home: h.home })));
  } finally { h.cleanup(); }
});

// ---- Codex (multi_agent_v1 tool shapes from codex-cli 0.160 rollouts) ----
let cn = 0;
const call = (ts, name, args) => {
  const id = 'call_' + (++cn);
  return { id, line: { timestamp: ts, type: 'response_item', payload: { type: 'function_call', name, namespace: 'multi_agent_v1', arguments: JSON.stringify(args), call_id: id } } };
};
const output = (ts, id, out) => ({ timestamp: ts, type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: JSON.stringify(out) } });
const AID = (i) => '01a0fef9-d7e2-7fa3-81a8-d93be27a38' + String(i).padStart(2, '0');
function codexAgent(i, spawnMin, doneMin, status) {
  const s = call(ago(spawnMin), 'spawn_agent', { agent_type: 'explorer', message: 'm' });
  const w = call(ago(spawnMin), 'wait_agent', { targets: [AID(i)], timeout_ms: 120000 });
  return [s.line, output(ago(spawnMin), s.id, { agent_id: AID(i), nickname: 'Raman' + i }), w.line,
    output(ago(doneMin), w.id, { status: { [AID(i)]: { [status || 'completed']: 'done' } }, timed_out: false })];
}

test('CODEX: finished multi_agent_v1 agents never closed -> advisory with the close_agent call', () => {
  const e = [0, 1, 2].flatMap((i) => codexAgent(i, 60, 30 - i));
  const t = ctx(run(e, { rollout: true }));
  assert.match(t, /idle-agents: 3 finished agents are idle and not closed: Raman0 \(01a0fef9-d7e2-7fa3-81a8-d93be27a3800\) \(30m\)/);
  assert.match(t, /close_agent \{"target":"01a0fef9-d7e2-7fa3-81a8-d93be27a3800"\}/);
  assert.match(t, /thread slot/);
});

test('CODEX: closed, re-tasked (send_input), timed out or still running -> not listed; errored counts', () => {
  const closeAll = [0, 1, 2].map((i) => call(ago(5), 'close_agent', { target: AID(i) }).line);
  assert.ok(silent(run([0, 1, 2].flatMap((i) => codexAgent(i, 60, 30)).concat(closeAll), { rollout: true })));
  const resend = [0, 1, 2].map((i) => call(ago(5), 'send_input', { target: AID(i), message: 'more' }).line);
  assert.ok(silent(run([0, 1, 2].flatMap((i) => codexAgent(i, 60, 30)).concat(resend), { rollout: true })));
  const s = call(ago(60), 'spawn_agent', { message: 'm' });
  const w = call(ago(60), 'wait_agent', { targets: [AID(9)] });
  assert.ok(silent(run([s.line, output(ago(60), s.id, { agent_id: AID(9) }), w.line, output(ago(40), w.id, { status: {}, timed_out: true })], { rollout: true })));
  assert.match(ctx(run(codexAgent(4, 60, 20, 'errored'), { rollout: true })), /1 finished agent is idle and not closed/);
});

test('CODEX: the "collaboration" tool set (no close tool, no agent ids) -> silent', () => {
  const s = { timestamp: ago(60), type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', arguments: '{"task_name":"review"}', call_id: 'c1' } };
  const so = { timestamp: ago(60), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '{"task_name":"/root/review"}' } };
  const w = { timestamp: ago(60), type: 'response_item', payload: { type: 'function_call', name: 'wait_agent', namespace: 'collaboration', arguments: '{"timeout_ms":1000}', call_id: 'c2' } };
  const wo = { timestamp: ago(40), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: '{"message":"Wait completed.","timed_out":false}' } };
  assert.ok(silent(run([s, so, w, wo], { rollout: true })));
});

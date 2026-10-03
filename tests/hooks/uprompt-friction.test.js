'use strict';
// UserPromptSubmit friction (task-tracker): (1) owner/external-blocked tasks are
// not counted in "open tasks: N — update or close them" (same predicate as the
// Stop task-guard); (2) the running-agent count is PROVEN for agents that launched
// and finished inside a long transcript, and an unprovable count names what it saw.
require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const NO_DEDUPE = { ANTIHALL_EMIT_DEDUPE: '0' };
const HIGH_CAP = { ANTIHALL_MAX_PARALLEL_DISPATCH: '16' };
const iso = (m) => new Date(Date.now() - m * 60000).toISOString();

function createTask(n, subject, metadata) {
  const tu = 'toolu_c' + n;
  return [
    { type: 'assistant', timestamp: iso(30), message: { role: 'assistant', content: [{ type: 'tool_use', id: tu, name: 'TaskCreate', input: Object.assign({ subject, description: subject }, metadata ? { metadata } : {}) }] } },
    { type: 'user', timestamp: iso(30), message: { role: 'user', content: [{ tool_use_id: tu, type: 'tool_result', content: 'Task #' + n + ' created successfully: ' + subject }] } },
  ];
}
function launch(tuid, agentId) {
  const text = 'Async agent launched successfully. (This tool result is internal metadata.)\nagentId: ' + agentId +
    " (internal ID - do not mention to user. Use SendMessage with to: '" + agentId + "')\nThe agent is working in the background. You will be notified automatically when it completes.\noutput_file: /tmp/none/" + agentId + '.output\n';
  return [
    { type: 'assistant', timestamp: iso(20), message: { role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: 'Agent', input: { description: 'rev ' + agentId, prompt: 'x', run_in_background: true } }] } },
    { type: 'user', timestamp: iso(20), message: { role: 'user', content: [{ tool_use_id: tuid, type: 'tool_result', content: [{ type: 'text', text }] }] } },
  ];
}
const done = (id) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(15), content: '<task-notification>\n<task-id>' + id + '</task-id>\n<status>completed</status>\n<summary>ok</summary>\n</task-notification>' });
const filler = (bytes) => ({ type: 'user', timestamp: iso(25), message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(bytes) }] } });
const MB = 1024 * 1024;
const payload = (tp) => ({ hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'continue', cwd: process.cwd(), transcript_path: tp });
const ctx = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
function run(h, entries) {
  const tp = h.writeTranscript(entries);
  return ctx(testHook('task-tracker.js', payload(tp), { home: h.home, env: Object.assign({}, NO_DEDUPE, HIGH_CAP) }));
}

test('BUG1: a blockedOn:external task is not counted and gets no "update or close" instruction', () => {
  const h = makeHome();
  try {
    const c = run(h, createTask(1, 'wait for vendor', { blockedOn: 'external' }));
    assert.doesNotMatch(c, /update or close them/, c);
    assert.match(c, /open tasks: 0 \(\+1 blocked: external\)/, c);
  } finally { h.cleanup(); }
});

test('BUG1: blocked tasks are excluded from N when others are open (OWNER: prefix too)', () => {
  const h = makeHome();
  try {
    const c = run(h, [...createTask(1, 'real work A'), ...createTask(2, 'real work B'), ...createTask(3, 'x', { blockedOn: 'external' }), ...createTask(4, 'OWNER: pick a name')]);
    assert.match(c, /open tasks: 2 \(\+2 blocked: external\/owner\)/, c);
    assert.match(c, /update or close them/, c);
  } finally { h.cleanup(); }
});

test('BUG2: agents launched AND finished in-window of a >1.5MB transcript -> count proven (0 running), not "unknown"', () => {
  const h = makeHome();
  try {
    const c = run(h, [filler(1 * MB), ...launch('toolu_a1', 'abcdef123456'), done('abcdef123456'), ...createTask(1, 'write the docs'), filler(0.7 * MB)]);
    assert.doesNotMatch(c, /count unknown/, c);
    assert.match(c, /DISPATCH NOW/, c);
  } finally { h.cleanup(); }
});

test('BUG2: pre-window pending agent is found by the widened read and counted as running', () => {
  const h = makeHome();
  try {
    const c = run(h, [...launch('toolu_a1', 'abcdef123456'), filler(1.7 * MB), ...createTask(1, 'write the docs')]);
    assert.doesNotMatch(c, /count unknown/, c);
  } finally { h.cleanup(); }
});

test('BUG2: unprovable count (beyond the widened window) names the agent ids seen and stays short', () => {
  const h = makeHome();
  try {
    const c = run(h, [filler(13 * MB), ...launch('toolu_a1', 'abcdef123456'), done('abcdef123456'), ...createTask(1, 'write the docs')]);
    assert.match(c, /count unknown \(saw 1 launched, all finished: abcdef123456; launches older than the last 12MB/, c);
    const line = c.match(/Background-agent[^\n]*?before dispatching more\./)[0];
    assert.ok(line.length < 230, 'short: ' + line.length + ' ' + line);
  } finally { h.cleanup(); }
});

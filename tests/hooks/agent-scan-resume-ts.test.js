'use strict';
// agent-scan: terminal-vs-resumed must honour entry TIMESTAMPS, not only
// transcript order. After launch, stop, resume, a stop notification that is
// LATER in the transcript but stamped BEFORE the resume refers to the earlier
// run and must not re-mark the resumed agent terminal. Pure scanner test:
// lines are passed in directly (no HOME, no subprocess).

const { test } = require('node:test');
const assert = require('node:assert');
const { scanTranscript } = require('../../plugins/anti-hall/hooks/lib/agent-scan.js');

const ID = 'bbbb111122223333c';
const T = (min) => new Date(Date.UTC(2026, 9, 3, 12, min, 0)).toISOString();

const text = (status) => '<task-notification>\n<task-id>' + ID + '</task-id>\n<status>' + status + '</status>\n</task-notification>';
// The three transcript shapes a task notification arrives in.
const SHAPES = {
  'user bare string': (status, ts) => ({ type: 'user', message: { role: 'user', content: text(status) }, timestamp: ts }),
  'attachment.prompt': (status, ts) => ({ type: 'attachment', attachment: { type: 'prompt', prompt: text(status) }, timestamp: ts }),
  'queue-operation': (status, ts) => ({ type: 'queue-operation', operation: 'enqueue', content: text(status), timestamp: ts }),
};

const launch = (ts) => ({
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: 'toolu_l', type: 'tool_result', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: ' + ID + '\noutput_file: /tmp/x.output' }] }] },
  timestamp: ts,
});
const resume = (ts) => ({
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: 'toolu_r', type: 'tool_result', content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Resuming agent ' + ID.slice(0, 7), resumedAgentId: ID }) }] }] },
  timestamp: ts,
});
const scan = (entries) => scanTranscript('/nonexistent', entries.map((e) => JSON.stringify(e)));
const rm = (e, k) => { const c = { ...e }; delete c[k]; return c; };

for (const [shape, mk] of Object.entries(SHAPES)) {
  test('RESUME-TS [' + shape + ']: late stop notification stamped BEFORE the resume -> still running', () => {
    const r = scan([launch(T(0)), mk('stopped', T(5)), resume(T(10)), mk('stopped', T(6))]);
    assert.ok(!r.terminal.has(ID), 'stale earlier-run stop must not re-terminate the resumed agent');
  });
  test('RESUME-TS [' + shape + ']: late stop notification stamped AFTER the resume -> terminal', () => {
    const r = scan([launch(T(0)), mk('stopped', T(5)), resume(T(10)), mk('stopped', T(12))]);
    assert.ok(r.terminal.has(ID));
  });
  test('RESUME-TS [' + shape + ']: stamped at the resume instant -> terminal', () => {
    const r = scan([launch(T(0)), resume(T(10)), mk('stopped', T(10))]);
    assert.ok(r.terminal.has(ID));
  });
  test('RESUME-TS [' + shape + ']: no timestamps -> order-based (late stop wins; earlier stop loses)', () => {
    const late = scan([launch(T(0)), mk('stopped', T(5)), resume(T(10)), mk('stopped', T(6))].map((e) => rm(e, 'timestamp')));
    assert.ok(late.terminal.has(ID), 'order-based: stop after resume is terminal');
    const early = scan([launch(T(0)), mk('stopped', T(5)), resume(T(10))].map((e) => rm(e, 'timestamp')));
    assert.ok(!early.terminal.has(ID), 'order-based: resume after stop is running');
  });
  test('RESUME-TS [' + shape + ']: unparseable timestamp on the notification -> order-based', () => {
    const r = scan([launch(T(0)), resume(T(10)), mk('stopped', 'garbage')]);
    assert.ok(r.terminal.has(ID));
  });
}

test('RESUME-TS [task_status attachment]: late terminal stamped BEFORE resume -> running; AFTER -> terminal', () => {
  const ts = (status, t) => ({ type: 'attachment', attachment: { type: 'task_status', taskId: ID, status }, timestamp: t });
  assert.ok(!scan([launch(T(0)), resume(T(10)), ts('killed', T(6))]).terminal.has(ID));
  assert.ok(scan([launch(T(0)), resume(T(10)), ts('killed', T(12))]).terminal.has(ID));
});

test('RESUME-TS [TaskStop tool_use]: late stop stamped BEFORE resume -> running; AFTER -> terminal', () => {
  const stop = (t) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_s', name: 'TaskStop', input: { task_id: ID } }] }, timestamp: t });
  assert.ok(!scan([launch(T(0)), resume(T(10)), stop(T(6))]).terminal.has(ID));
  assert.ok(scan([launch(T(0)), resume(T(10)), stop(T(12))]).terminal.has(ID));
});

test('RESUME-TS: a quoted "Resuming agent" phrase in text still does not re-open an agent', () => {
  const quote = { type: 'user', message: { role: 'user', content: 'note: "Resuming agent ' + ID.slice(0, 7) + '"' }, timestamp: T(20) };
  assert.ok(scan([launch(T(0)), SHAPES['user bare string']('stopped', T(5)), quote]).terminal.has(ID));
});

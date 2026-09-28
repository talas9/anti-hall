'use strict';
// Direct unit tests for hooks/lib/task-state.js's reconstructTasks(), which
// task-tracker.js and dispatch-tier.js both consume. The TaskCreate gate at
// task-state.js:62 (`callName === 'TaskCreate' ? txt.match(...) : null`) is
// code-identical to the same gate in task-guard.js (which HAS a dedicated
// "EPOCH RESET regression (C2-1)" test at tests/hooks/task-guard.test.js) but
// had no direct or indirect coverage of its own (round-3 deadly-loop finding
// R3-3/R3C1-4/R3A1-5). These tests call reconstructTasks() directly (no hook
// spawn needed - it is a pure function of a transcript tail).

const { test } = require('node:test');
const assert = require('node:assert');
const { reconstructTasks } = require('../../plugins/anti-hall/hooks/lib/task-state.js');

function taskUpdateEntry(tuid, input) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: 'TaskUpdate', input }] },
  };
}
function bashCall(tuid, command) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: 'Bash', input: { command } }] },
  };
}
function toolResult(tuid, text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: tuid, type: 'tool_result', content: text }] },
  };
}
function taskCreateCall(tuid, input) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: 'TaskCreate', input }] },
  };
}
function tailOf(entries) {
  return { data: entries.map((e) => JSON.stringify(e)).join('\n'), truncated: false };
}

test('reconstructTasks: a REAL TaskCreate "Task #N created successfully" result resets the epoch when N <= the highest id seen', () => {
  const tail = tailOf([
    taskUpdateEntry('toolu_u3', { taskId: '3', status: 'in_progress' }),
    taskCreateCall('toolu_c1', { subject: 'post-reset work' }),
    toolResult('toolu_c1', 'Task #1 created successfully: post-reset work'),
  ]);
  const { taskMap } = reconstructTasks(tail);
  assert.ok(!taskMap.has('3'), 'the pre-reset task #3 must be dropped once a genuine TaskCreate restarts numbering at #1');
  assert.ok(taskMap.has('1'), 'the fresh post-reset task must be tracked');
});

test('reconstructTasks (C2-1 direct): a Bash result that merely PRINTS "Task #N created successfully" must NOT wipe the task map', () => {
  const tail = tailOf([
    taskUpdateEntry('toolu_u3', { taskId: '3', status: 'in_progress' }),
    bashCall('toolu_b1', 'echo "Task #1 created successfully: x"'),
    toolResult('toolu_b1', 'Task #1 created successfully: x'),
  ]);
  const { taskMap } = reconstructTasks(tail);
  assert.ok(taskMap.has('3'), 'a Bash tool_result that only PRINTS the TaskCreate-shaped text must not be mistaken for a real TaskCreate result (task-state.js:62 callName gate)');
  const t3 = taskMap.get('3');
  assert.strictEqual(t3.status, 'in_progress');
});

test('reconstructTasks: a real TaskCreate result whose id is HIGHER than any seen so far does not reset the epoch', () => {
  const tail = tailOf([
    taskUpdateEntry('toolu_u3', { taskId: '3', status: 'in_progress' }),
    taskCreateCall('toolu_c1', { subject: 'a fourth task' }),
    toolResult('toolu_c1', 'Task #4 created successfully: a fourth task'),
  ]);
  const { taskMap } = reconstructTasks(tail);
  assert.ok(taskMap.has('3'), 'task #3 must stay tracked when the new id (#4) extends the numbering, not restarts it');
  assert.ok(taskMap.has('4'), 'the new task #4 must be tracked');
});

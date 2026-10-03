'use strict';
// Transcript entries for a named in-process teammate, modelled on the real
// record shapes (field transcript, 2026-10-02); ids and text are synthetic.

const T = (min, sec) => new Date(Date.UTC(2026, 9, 3, 12, min, sec || 0)).toISOString();
const ms = (min, sec) => Date.parse(T(min, sec));

let n = 0;
const tid = () => 'toolu_fx' + (++n);

// Agent tool_use + its "teammate_spawned" tool_result.
function spawn(name, ts, description) {
  const id = tid();
  return [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: description || 'do the thing', subagent_type: 'general-purpose', name, prompt: 'p' } }] }, timestamp: ts },
    {
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text: 'Spawned successfully.\nagent_id: ' + name + '@session-fx\nname: ' + name + '\nThe agent is now running and will receive instructions via mailbox.' }] }] },
      toolUseResult: { status: 'teammate_spawned', teammate_id: name + '@session-fx', agent_id: name + '@session-fx', agent_type: 'general-purpose', name, team_name: 'session-fx' },
      timestamp: ts,
    },
  ];
}

const inboxResult = (name) => JSON.stringify({ success: true, message: 'Message sent to ' + name + "'s inbox", msg_id: 'm-1', routing: { sender: 'team-lead', target: '@' + name, summary: 's', content: 'c' } });

// SendMessage tool_use + its "Message sent to <name>'s inbox" tool_result.
function send(name, ts) {
  const id = tid();
  return [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to: name, summary: 's', message: 'c' } }] }, timestamp: ts },
    { type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text: inboxResult(name) }] }] }, toolUseResult: JSON.parse(inboxResult(name)), timestamp: ts },
  ];
}

const idleBlock = (name, innerTs) => '<teammate-message teammate_id="' + name + '" color="blue">\n' +
  JSON.stringify({ type: 'idle_notification', from: name, timestamp: innerTs, idleReason: 'available', result: 'report text' }) + '\n</teammate-message>';

// The teammate's end-of-turn report: innerTs = when its turn ended, entryTs =
// when the coordinator's transcript recorded it (later).
function idle(name, innerTs, entryTs) {
  return [{
    type: 'user',
    message: { role: 'user', content: 'Another Claude session sent a message:\n<teammate-message teammate_id="' + name + '" color="blue" summary="s">\nreport text\n</teammate-message>\n\n' + idleBlock(name, innerTs) + '\n\nThis came from another Claude session.' },
    timestamp: entryTs || innerTs,
  }];
}

// TaskStop tool_use (+ its result unless answered === false).
function stop(taskId, ts, opts) {
  const id = tid();
  const out = [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'TaskStop', input: { task_id: taskId } }] }, timestamp: ts }];
  if (!opts || opts.answered !== false) {
    const err = !!(opts && opts.error);
    out.push({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', is_error: err || undefined, content: err ? 'No task found' : JSON.stringify({ message: 'Successfully stopped task: t1', task_id: 't1', task_type: 'in_process_teammate' }) }] }, timestamp: ts });
  }
  return out;
}

const lines = (...groups) => groups.flat().map((e) => JSON.stringify(e));

module.exports = { T, ms, spawn, send, idle, stop, lines, inboxResult, idleBlock, tid };

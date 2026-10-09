'use strict';
// silent-agent-nudge (Stop hook). Mechanically reminds the parent session when
// one of its OWN background subagents has gone silent past a threshold. The
// PRIMARY signal is the main transcript itself — the harness ALWAYS appends a
// tool_result on every background Agent launch containing
// "Async agent launched successfully", an `agentId: <id>` line and an
// `output_file: <path>` line (that agent's own growing per-run JSONL), and
// later a `<task-notification>` block with `<task-id>` (== the agentId) and
// `<status>completed|failed|stopped</status>` once it resolves. "Silent" =
// launched, no terminal notification yet, and the output_file's mtime (or the
// launch timestamp, if the file is missing — missing counts as silent/dead
// too) is older than the threshold.
//
// The ~/.anti-hall/agents/<id>.json heartbeat convention is kept as an
// ADDITIONAL source (some subagents self-report per the orchestration
// skill), but nothing writes it automatically, so it is not the only path.
//
// Fixtures below mirror the EXACT line shapes read from a real transcript
// (both the array-of-text-block tool_result form and the bare-string
// task-notification form actually observed).
//
// Stop hooks in this repo have no non-blocking advisory channel — every
// existing Stop nudge (task-guard, codex-nudge, auto-handover-pause-nag, …)
// emits {decision:'block', reason}; this hook follows the same convention.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'silent-agent-nudge.js';
const THRESHOLD_MS = 20 * 60 * 1000;

function isBlock(r) {
  return r.status === 0 && r.json && r.json.decision === 'block';
}

// ---------------------------------------------------------------------------
// Transcript-line builders — mirror the exact shapes read from a live
// transcript (b23a3aca-62be-4105-bddc-d61791a4db42.jsonl).
// ---------------------------------------------------------------------------

// agentToolUseLine(toolUseId, description, isoTs) -> the assistant message
// that spawns the Agent tool_use (used to recover a human-readable label).
function agentToolUseLine(toolUseId, description, isoTs) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: toolUseId, name: 'Agent', input: { description, subagent_type: 'general-purpose', prompt: 'do the thing' } },
      ],
    },
    timestamp: isoTs,
  };
}

// agentLaunchResultLine(id, outputFile, toolUseId, isoTs) -> the tool_result
// the harness appends immediately after a background Agent launch. Real text
// verbatim (redacted only where irrelevant), array-of-text-block content.
function agentLaunchResultLine(id, outputFile, toolUseId, isoTs) {
  const text =
    'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\n' +
    'agentId: ' + id + " (internal ID - do not mention to user. Use SendMessage with to: '" + id + "', summary: '<5-10 word recap>' to continue this agent.)\n" +
    'The agent is working in the background. You will be notified automatically when it completes.\n' +
    "Do not duplicate this agent's work — avoid working with the same files or topics it is using.\n" +
    'output_file: ' + outputFile + '\n' +
    'Do NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context.';
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { tool_use_id: toolUseId, type: 'tool_result', content: [{ type: 'text', text }] },
      ],
    },
    timestamp: isoTs,
  };
}

// notificationLine(taskId, status, isoTs) -> a terminal task-notification.
// Real shape: message.content is a BARE STRING (not a content-block array).
function notificationLine(taskId, status, isoTs) {
  const text = notificationText(taskId, status);
  return {
    type: 'user',
    message: { role: 'user', content: text },
    timestamp: isoTs,
  };
}

// notificationText(taskId, status) -> the raw <task-notification> block text,
// shared by all three real transcript shapes below.
function notificationText(taskId, status) {
  return '<task-notification>\n<task-id>' + taskId + '</task-id>\n' +
    '<tool-use-id>toolu_01ABCDEF</tool-use-id>\n' +
    '<output-file>/tmp/whatever/tasks/' + taskId + '.output</output-file>\n' +
    '<status>' + status + '</status>\n' +
    '<summary>Agent "x" finished</summary>\n</task-notification>';
}

// notificationAttachmentLine(taskId, status, isoTs) -> the ATTACHMENT shape
// verified against a real transcript: type:'attachment', with the
// notification text living at attachment.prompt (a string), not
// message.content.
function notificationAttachmentLine(taskId, status, isoTs) {
  return {
    type: 'attachment',
    attachment: { type: 'prompt', commandMode: false, prompt: notificationText(taskId, status), timestamp: isoTs },
    timestamp: isoTs,
  };
}

// notificationQueueOpLine(taskId, status, isoTs) -> the QUEUE-OPERATION shape
// verified against a real transcript: type:'queue-operation', with the
// notification text living directly at entry.content (a string).
function notificationQueueOpLine(taskId, status, isoTs) {
  return {
    type: 'queue-operation',
    operation: 'enqueue',
    content: notificationText(taskId, status),
    timestamp: isoTs,
  };
}

function isoMinutesAgo(mins) {
  return new Date(Date.now() - mins * 60 * 1000).toISOString();
}

// writeOutputFile(h, name, ageMs) -> absolute path to a file whose mtime is
// `ageMs` in the past (or now, when omitted).
function writeOutputFile(h, name, ageMs) {
  const p = path.join(h.home, name);
  fs.writeFileSync(p, '{}\n', 'utf8');
  if (typeof ageMs === 'number') {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
  }
  return p;
}

function stopPayload(transcriptPath) {
  return { hook_event_name: 'Stop', session_id: 't', transcript_path: transcriptPath, cwd: process.cwd() };
}

// ---------------------------------------------------------------------------
// Transcript source
// ---------------------------------------------------------------------------

test('TRANSCRIPT: launched agent, output_file stale, no terminal notification -> nudge once, names the description', () => {
  const h = makeHome();
  try {
    const out = writeOutputFile(h, 'worker-a.output', THRESHOLD_MS + 5 * 60 * 1000);
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_1', 'Investigate the flaky test', isoMinutesAgo(30)),
      agentLaunchResultLine('a1111111111111111', out, 'toolu_1', isoMinutesAgo(30)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), 'must nudge for a launched-but-stale agent');
    assert.match(r.json.reason, /Investigate the flaky test/, 'should name the agent by its launch description');
    assert.match(r.json.reason, /silent/i);
  } finally { h.cleanup(); }
});

test('TRANSCRIPT: fresh output_file (recently written) -> nothing', () => {
  const h = makeHome();
  try {
    const out = writeOutputFile(h, 'worker-b.output', 60 * 1000);
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_2', 'Quick lookup', isoMinutesAgo(1)),
      agentLaunchResultLine('a2222222222222222', out, 'toolu_2', isoMinutesAgo(1)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), 'a fresh output_file must never be nudged');
  } finally { h.cleanup(); }
});

test('TRANSCRIPT: agent resolved (terminal task-notification present) -> nothing, even if the file looks stale', () => {
  const h = makeHome();
  try {
    const out = writeOutputFile(h, 'worker-c.output', THRESHOLD_MS + 60 * 60 * 1000);
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_3', 'Finished work', isoMinutesAgo(90)),
      agentLaunchResultLine('a3333333333333333', out, 'toolu_3', isoMinutesAgo(90)),
      notificationLine('a3333333333333333', 'completed', isoMinutesAgo(1)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), 'a resolved agent (completed/failed/stopped) must never be nudged');
  } finally { h.cleanup(); }
});

test('TRANSCRIPT: failed/stopped notifications also count as resolved -> nothing', () => {
  const h = makeHome();
  try {
    const out1 = writeOutputFile(h, 'worker-d.output', THRESHOLD_MS + 60000);
    const out2 = writeOutputFile(h, 'worker-e.output', THRESHOLD_MS + 60000);
    const tp = h.writeTranscript([
      agentLaunchResultLine('a4444444444444444', out1, 'toolu_4', isoMinutesAgo(60)),
      notificationLine('a4444444444444444', 'failed', isoMinutesAgo(50)),
      agentLaunchResultLine('a5555555555555555', out2, 'toolu_5', isoMinutesAgo(60)),
      notificationLine('a5555555555555555', 'stopped', isoMinutesAgo(50)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r));
  } finally { h.cleanup(); }
});

test('TRANSCRIPT: output_file missing entirely -> counts as silent/dead (launched well past threshold)', () => {
  const h = makeHome();
  try {
    const missingPath = path.join(h.home, 'does-not-exist.output');
    const tp = h.writeTranscript([
      agentLaunchResultLine('a6666666666666666', missingPath, 'toolu_6', isoMinutesAgo(45)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), 'a missing output_file must be treated as silent/dead, not skipped');
    assert.match(r.json.reason, /a6666666666666666/);
  } finally { h.cleanup(); }
});

test('TRANSCRIPT: output_file missing but agent was JUST launched (within threshold) -> nothing yet', () => {
  const h = makeHome();
  try {
    const missingPath = path.join(h.home, 'does-not-exist-2.output');
    const tp = h.writeTranscript([
      agentLaunchResultLine('a7777777777777777', missingPath, 'toolu_7', isoMinutesAgo(1)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), 'a just-launched agent whose output file has not appeared yet should get a grace period');
  } finally { h.cleanup(); }
});

test('CAP HOLDS (transcript source): same stale snapshot nudged only once across repeated Stop calls', () => {
  const h = makeHome();
  try {
    const out = writeOutputFile(h, 'worker-f.output', THRESHOLD_MS + 60000);
    const tp = h.writeTranscript([
      agentLaunchResultLine('a8888888888888888', out, 'toolu_8', isoMinutesAgo(30)),
    ]);
    const r1 = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r1), 'first call must nudge');
    const r2 = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r2), 'second call for the same unchanged output_file mtime must not nudge again');
    const r3 = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r3), 'cap holds across further calls too');
  } finally { h.cleanup(); }
});

test('a stale agent that later gets a terminal notification stops being nudged', () => {
  const h = makeHome();
  try {
    const out = writeOutputFile(h, 'worker-g.output', THRESHOLD_MS + 60000);
    const tp1 = h.writeTranscript([
      agentLaunchResultLine('a9999999999999999', out, 'toolu_9', isoMinutesAgo(30)),
    ]);
    const r1 = testHook(HOOK, stopPayload(tp1), { home: h.home });
    assert.ok(isBlock(r1));

    const tp2 = h.writeTranscript([
      agentLaunchResultLine('a9999999999999999', out, 'toolu_9', isoMinutesAgo(30)),
      notificationLine('a9999999999999999', 'completed', isoMinutesAgo(1)),
    ]);
    const r2 = testHook(HOOK, stopPayload(tp2), { home: h.home });
    assert.ok(!isBlock(r2), 'once resolved, must never nudge again');
  } finally { h.cleanup(); }
});

test('a MIXED-CASE terminal status (e.g. "Completed") still counts as resolved -> nothing', () => {
  const h = makeHome();
  try {
    const out = writeOutputFile(h, 'worker-mixedcase.output', THRESHOLD_MS + 60000);
    const tp = h.writeTranscript([
      agentLaunchResultLine('a1200000000000009', out, 'toolu_mc', isoMinutesAgo(30)),
      notificationLine('a1200000000000009', 'Completed', isoMinutesAgo(1)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), 'a differently-cased terminal status must still resolve the agent, not be misread as still-silent');
  } finally { h.cleanup(); }
});

test('TRANSCRIPT: terminal notification arriving as an ATTACHMENT entry (attachment.prompt) resolves the agent -> nothing', () => {
  const h = makeHome();
  try {
    const out = writeOutputFile(h, 'worker-attach.output', THRESHOLD_MS + 60 * 60 * 1000);
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_att', 'Attachment-shape completion', isoMinutesAgo(90)),
      agentLaunchResultLine('aaaa100000000001', out, 'toolu_att', isoMinutesAgo(90)),
      notificationAttachmentLine('aaaa100000000001', 'completed', isoMinutesAgo(1)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), 'an attachment-shaped terminal notification must resolve the agent, not be missed: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('TRANSCRIPT: terminal notification arriving as a QUEUE-OPERATION entry (entry.content) resolves the agent -> nothing', () => {
  const h = makeHome();
  try {
    const out = writeOutputFile(h, 'worker-queueop.output', THRESHOLD_MS + 60 * 60 * 1000);
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_qop', 'Queue-op-shape completion', isoMinutesAgo(90)),
      agentLaunchResultLine('aaab100000000001', out, 'toolu_qop', isoMinutesAgo(90)),
      notificationQueueOpLine('aaab100000000001', 'completed', isoMinutesAgo(1)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), 'a queue-operation-shaped terminal notification must resolve the agent, not be missed: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('SAFETY NET: output_file stale but a LATER tool_result references the agentId (result delivered) -> resolved, not nudged', () => {
  const h = makeHome();
  try {
    const out = writeOutputFile(h, 'worker-delivered.output', THRESHOLD_MS + 60 * 60 * 1000);
    const agentId = 'aaac100000000001';
    // A later transcript entry (e.g. a SendMessage/TaskOutput tool_result)
    // that quotes the agentId in its own tool_result content — the harness
    // does this when the coordinator follows up on a finished agent — must
    // count as delivered even with no <task-notification> block at all.
    const followUpResultLine = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { tool_use_id: 'toolu_followup', type: 'tool_result', content: [{ type: 'text', text: 'Agent ' + agentId + ' result: done, see summary.' }] },
        ],
      },
      timestamp: isoMinutesAgo(1),
    };
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_del', 'Delivered via follow-up reference', isoMinutesAgo(90)),
      agentLaunchResultLine(agentId, out, 'toolu_del', isoMinutesAgo(90)),
      followUpResultLine,
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), 'a later tool_result referencing the agentId means the result was delivered -> must not nudge: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('SAFETY NET: a ListAgents result listing the agent as RUNNING is not delivery evidence -> still nudged', () => {
  const h = makeHome();
  try {
    const out = writeOutputFile(h, 'worker-listed.output', THRESHOLD_MS + 60 * 60 * 1000);
    const agentId = 'aaaf100000000001';
    // The coordinator checks on the agent with ListAgents; that result quotes
    // the id in a "running" row. That must not disarm the nudge (field bug).
    const listAgentsResultLine = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: 'toolu_list', type: 'tool_result',
            content: 'This session is demo-1 [abc123].\n\nSubagents (1):\n  ' + agentId + '  ·  general-purpose  ·  running  ·  started 25m ago\n\nPeer sessions (0):\n',
          },
        ],
      },
      timestamp: isoMinutesAgo(1),
    };
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_lst', 'Listed but silent', isoMinutesAgo(90)),
      agentLaunchResultLine(agentId, out, 'toolu_lst', isoMinutesAgo(90)),
      listAgentsResultLine,
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), 'a "running" listing row must not count as delivered: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('COMPACTION: launch record outside the capped tail window, agent re-injected as a running task_status attachment -> still nudged', () => {
  const h = makeHome();
  try {
    const out = writeOutputFile(h, 'worker-compacted.output', THRESHOLD_MS + 60 * 60 * 1000);
    const agentId = 'aaaf200000000001';
    const taskStatusLine = {
      type: 'attachment',
      attachment: { type: 'task_status', taskId: agentId, taskType: 'local_agent', description: 'Compacted worker', status: 'running', outputFilePath: out },
      timestamp: isoMinutesAgo(2),
    };
    // Filler larger than the 1.5MB tail window pushes the launch record out of it.
    const filler = { type: 'attachment', attachment: { type: 'instructions', content: 'x'.repeat(2 * 1024 * 1024) }, timestamp: isoMinutesAgo(3) };
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_cmp', 'Compacted worker', isoMinutesAgo(90)),
      agentLaunchResultLine(agentId, out, 'toolu_cmp', isoMinutesAgo(90)),
      filler,
      taskStatusLine,
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), 'a running task_status attachment must restore the agent after the launch scrolls out: ' + JSON.stringify(r.json));
    assert.match(r.json.reason, /Compacted worker/);
  } finally { h.cleanup(); }
});

function adoptedLine(taskId, taskType, description, out) {
  return {
    type: 'attachment',
    attachment: { type: 'task_status', taskId, taskType, description, status: 'running', outputFilePath: out },
    timestamp: isoMinutesAgo(90),
  };
}

test('RESTART: a previous session\'s agent re-injected as a running task_status is NOT ours -> nothing', () => {
  const h = makeHome();
  try {
    const out = path.join(h.home, '11111111-2222-3333-4444-555555555555', 'tasks', 'abc.output');
    const tp = h.writeTranscript([adoptedLine('abc', 'local_agent', 'Old session lane', out)]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), 'a task dir of another session is not this session\'s agent: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('RESTART: the same shape inside THIS session\'s task dir still nudges (control)', () => {
  const h = makeHome();
  try {
    const sid = '11111111-2222-3333-4444-555555555555';
    const out = path.join(h.home, sid, 'tasks', 'abc.output');
    const tp = h.writeTranscript([adoptedLine('abc', 'local_agent', 'Own lane', out)]);
    const r = testHook(HOOK, Object.assign(stopPayload(tp), { session_id: sid }), { home: h.home });
    assert.ok(isBlock(r), JSON.stringify(r.json));
    assert.match(r.json.reason, /of your own background subagent\(s\)/);
  } finally { h.cleanup(); }
});

test('SHELL: a quiet background shell is reported as a shell, never as a subagent', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([adoptedLine('b9hc3cu3v', 'local_bash', 'Restart the build-load throttle', path.join(h.home, 'nope.output'))]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), JSON.stringify(r.json));
    assert.match(r.json.reason, /of your own background shell\(s\)/);
    assert.match(r.json.reason, /shell: Restart the build-load throttle/);
    assert.doesNotMatch(r.json.reason, /subagent/);
  } finally { h.cleanup(); }
});

test('HARD CAP: 5 consecutive Stops for the same stale agent produce exactly 1 block, even when the snapshot keeps changing', () => {
  const h = makeHome();
  try {
    const out = path.join(h.home, 'worker-hardcap.output');
    const agentId = 'aaae100000000001';
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_hcp', 'Hard cap scenario', isoMinutesAgo(90)),
      agentLaunchResultLine(agentId, out, 'toolu_hcp', isoMinutesAgo(90)),
    ]);
    let blocks = 0;
    for (let i = 0; i < 5; i++) {
      // Re-touch the output file EVERY call so its mtime (the snapshot dedup
      // key) is DIFFERENT each time — the snapshot-only dedup above would nudge
      // again on every call; the hard cap must still suppress after the first.
      fs.writeFileSync(out, '{}\n', 'utf8');
      const t = new Date(Date.now() - (THRESHOLD_MS + 60 * 60 * 1000) + i); // distinct mtime each iteration
      fs.utimesSync(out, t, t);
      const r = testHook(HOOK, stopPayload(tp), { home: h.home });
      if (isBlock(r)) blocks++;
    }
    assert.strictEqual(blocks, 1, 'exactly one block across 5 consecutive Stops for the same agent, regardless of snapshot churn');
  } finally { h.cleanup(); }
});

test('CONTROL: a genuinely silent agent (no notification in ANY shape, no later reference) is still flagged', () => {
  const h = makeHome();
  try {
    const out = writeOutputFile(h, 'worker-truly-silent.output', THRESHOLD_MS + 60 * 60 * 1000);
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_silent', 'Genuinely still running', isoMinutesAgo(90)),
      agentLaunchResultLine('aaad100000000001', out, 'toolu_silent', isoMinutesAgo(90)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), 'an agent with no completion signal in any shape must still be nudged: ' + JSON.stringify(r.json));
    assert.match(r.json.reason, /Genuinely still running|aaad100000000001/);
  } finally { h.cleanup(); }
});

test('TWO <task-notification> blocks in ONE text leaf (several agents finishing together) each resolve their OWN agent, not a mismatched pairing', () => {
  const h = makeHome();
  try {
    const outA = writeOutputFile(h, 'worker-multi-a.output', THRESHOLD_MS + 60000);
    const outB = writeOutputFile(h, 'worker-multi-b.output', THRESHOLD_MS + 60000);

    // A single transcript text leaf carrying BOTH agents' terminal
    // notifications concatenated -- the real shape when several background
    // agents finish in the same turn. Both launches AND both notifications
    // land in the SAME (single) Stop call/transcript read, so a stale-
    // snapshot dedup cap from an earlier call can never mask the bug: a
    // first-match-only parser would resolve only 'aaaa...001' (the first
    // block) and leave 'bbbb...002' looking silent on this very first read.
    const twoBlockText =
      '<task-notification>\n<task-id>aaaa000000000001</task-id>\n<status>completed</status>\n</task-notification>\n' +
      '<task-notification>\n<task-id>bbbb000000000002</task-id>\n<status>failed</status>\n</task-notification>';
    const twoBlockLine = {
      type: 'user',
      message: { role: 'user', content: twoBlockText },
      timestamp: isoMinutesAgo(1),
    };
    const tp = h.writeTranscript([
      agentLaunchResultLine('aaaa000000000001', outA, 'toolu_ma', isoMinutesAgo(30)),
      agentLaunchResultLine('bbbb000000000002', outB, 'toolu_mb', isoMinutesAgo(30)),
      twoBlockLine,
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), 'both agents must resolve from the SAME text leaf — a first-match-only bug would leave the second one silently unresolved: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('the SAME agent id showing up through BOTH the transcript AND heartbeat sources in one Stop produces only ONE nudge line for it', () => {
  const h = makeHome();
  try {
    const sharedId = 'acaf000000000009';
    const out = writeOutputFile(h, 'worker-shared.output', THRESHOLD_MS + 60000);
    const tp = h.writeTranscript([
      agentLaunchResultLine(sharedId, out, 'toolu_shared', isoMinutesAgo(30)),
    ]);
    writeHeartbeatAgent(h, sharedId, { ageMs: THRESHOLD_MS + 5 * 60 * 1000, status: 'running', step: 'still going' });

    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r));
    const occurrences = (r.json.reason.match(new RegExp(sharedId, 'g')) || []).length;
    assert.strictEqual(occurrences, 1, 'the shared agent id must appear exactly once in the nudge text, not once per source: ' + r.json.reason);
    assert.match(r.json.reason, /silent-agent-nudge: 1 of your own/, 'the reported stale count must also be deduped to 1: ' + r.json.reason);
    require('../helpers/block-shape.js').assertShape(r.json.reason, 'silent-agent-nudge', 'silent-agent-nudge', { requireWhy: true });
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Heartbeat source (kept as an ADDITIONAL signal)
// ---------------------------------------------------------------------------

// writeHeartbeatAgent(h, id, opts) — writes a genuine per-agent heartbeat.
// `opts.session` defaults to 't' (the session_id stopPayload() uses) so a
// heartbeat is "ours" by default; pass a different value (or omit via
// `opts.noSession: true`) to simulate another session's/legacy heartbeat.
function writeHeartbeatAgent(h, id, opts) {
  const o = opts || {};
  const ts = Date.now() - (typeof o.ageMs === 'number' ? o.ageMs : 0);
  const dir = path.join(h.antiHall, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const body = { id, ts, status: o.status || 'running', step: o.step || 'doing work' };
  if (!o.noSession) body.session = o.session || 't';
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(body), 'utf8');
}

// writeRawAgentsFile(h, filename, obj) — writes an arbitrary raw JSON blob
// straight into ~/.anti-hall/agents/, for simulating non-heartbeat files that
// share that directory (phase-tracker.js's recent-spawn.json, other
// projects'/workspaces' devswarm-<branch>.json).
function writeRawAgentsFile(h, filename, obj) {
  const dir = path.join(h.antiHall, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(obj), 'utf8');
}

test('HEARTBEAT SOURCE: still nudges on a stale ~/.anti-hall/agents heartbeat with no transcript activity', () => {
  const h = makeHome();
  try {
    writeHeartbeatAgent(h, 'hb-worker', { ageMs: THRESHOLD_MS + 5 * 60 * 1000, status: 'running', step: 'scanning repo' });
    const r = testHook(HOOK, stopPayload(''), { home: h.home });
    assert.ok(isBlock(r));
    assert.match(r.json.reason, /hb-worker|scanning repo/);
  } finally { h.cleanup(); }
});

test('HEARTBEAT SOURCE: finished status -> nothing', () => {
  const h = makeHome();
  try {
    writeHeartbeatAgent(h, 'hb-worker2', { ageMs: THRESHOLD_MS + 60 * 60 * 1000, status: 'done' });
    const r = testHook(HOOK, stopPayload(''), { home: h.home });
    assert.ok(!isBlock(r));
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Shared-directory false positives (probeB regression: a stale non-heartbeat
// file in ~/.anti-hall/agents/ must never be mistaken for a silent subagent).
// ---------------------------------------------------------------------------

test('SHARED DIR: stale recent-spawn.json alone (phase-tracker orchestration-live marker, no id/status) -> no block', () => {
  const h = makeHome();
  try {
    writeRawAgentsFile(h, 'recent-spawn.json', { ts: Date.now() - (THRESHOLD_MS + 45 * 60 * 1000) });
    const r = testHook(HOOK, stopPayload(''), { home: h.home });
    assert.ok(!isBlock(r), 'recent-spawn.json must never be read as a subagent heartbeat: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('SHARED DIR: stale devswarm-<branch>.json alone (foreign DevSwarm tooling file) -> no block', () => {
  const h = makeHome();
  try {
    writeRawAgentsFile(h, 'devswarm-some-branch.json', { ts: Date.now() - (THRESHOLD_MS + 60 * 60 * 1000), branch: 'some-branch' });
    const r = testHook(HOOK, stopPayload(''), { home: h.home });
    assert.ok(!isBlock(r), 'devswarm-*.json must never be read as a subagent heartbeat: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('SHARED DIR: another session\'s stale genuine heartbeat -> no block (session mismatch)', () => {
  const h = makeHome();
  try {
    writeHeartbeatAgent(h, 'hb-other-session', { ageMs: THRESHOLD_MS + 30 * 60 * 1000, status: 'running', session: 'some-other-session-id' });
    const r = testHook(HOOK, stopPayload(''), { home: h.home }); // stopPayload() uses session_id 't'
    assert.ok(!isBlock(r), 'a heartbeat naming a DIFFERENT session must never nudge this session: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('SHARED DIR: legacy heartbeat with no session field at all -> no block (unattributable, fail-open toward no nudge)', () => {
  const h = makeHome();
  try {
    writeHeartbeatAgent(h, 'hb-legacy', { ageMs: THRESHOLD_MS + 30 * 60 * 1000, status: 'running', noSession: true });
    const r = testHook(HOOK, stopPayload(''), { home: h.home });
    assert.ok(!isBlock(r), 'a pre-session-field heartbeat cannot be attributed to any session and must not nudge: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Named teammates with a pending message (agent-scan pendingMessage)
// ---------------------------------------------------------------------------

test('TEAMMATE: finished, never-woken and freshly-messaged teammates never produce a Stop block', () => {
  const tm = require('../helpers/teammate-fixtures.js');
  const cases = {
    'reported after the message': [tm.spawn('tm-a', isoMinutesAgo(90)), tm.idle('tm-a', isoMinutesAgo(80)), tm.send('tm-a', isoMinutesAgo(70)), tm.idle('tm-a', isoMinutesAgo(40))],
    'sent a message long ago, never woke': [tm.spawn('tm-b', isoMinutesAgo(90)), tm.idle('tm-b', isoMinutesAgo(80)), tm.send('tm-b', isoMinutesAgo(70))],
    'sent a message just now': [tm.spawn('tm-c', isoMinutesAgo(90)), tm.idle('tm-c', isoMinutesAgo(80)), tm.send('tm-c', isoMinutesAgo(2))],
    'stopped after the message': [tm.spawn('tm-d', isoMinutesAgo(90)), tm.send('tm-d', isoMinutesAgo(70)), tm.stop('tm-d', isoMinutesAgo(60))],
    'spawned, working, no message': [tm.spawn('tm-e', isoMinutesAgo(90))],
  };
  for (const [label, groups] of Object.entries(cases)) {
    const h = makeHome();
    try {
      const r = testHook(HOOK, stopPayload(h.writeTranscript(groups.flat())), { home: h.home });
      assert.ok(!isBlock(r), label + ': ' + JSON.stringify(r.json));
    } finally { h.cleanup(); }
  }
});

test('TEAMMATE: a pending-message row never blocks, at any silentAgentNudgeMin (1, 5, 10, 20, 30)', () => {
  const tm = require('../helpers/teammate-fixtures.js');
  // Messaged 15 min ago, report not in the transcript: running per agent-scan
  // (an inference), older than the 1/5/10 min thresholds.
  const groups = [tm.spawn('tm-p', isoMinutesAgo(90)), tm.idle('tm-p', isoMinutesAgo(80)), tm.send('tm-p', isoMinutesAgo(15))];
  for (const min of ['1', '5', '10', '20', '30']) {
    const h = makeHome();
    try {
      const r = testHook(HOOK, stopPayload(h.writeTranscript(groups.flat())), { home: h.home, env: { ANTIHALL_SILENT_AGENT_NUDGE_MIN: min } });
      assert.ok(!isBlock(r), 'min=' + min + ': ' + JSON.stringify(r.json));
    } finally { h.cleanup(); }
  }
});

// ---------------------------------------------------------------------------
// Settings / skip / fail-open
// ---------------------------------------------------------------------------

test('SETTING OFF: ANTIHALL_SILENT_AGENT_NUDGE=off -> no nudge even when stale', () => {
  const h = makeHome();
  try {
    const out = writeOutputFile(h, 'worker-h.output', THRESHOLD_MS + 60000);
    const tp = h.writeTranscript([
      agentLaunchResultLine('aaaaaaaaaaaaaaaaaa', out, 'toolu_h', isoMinutesAgo(30)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home, env: { ANTIHALL_SILENT_AGENT_NUDGE: 'off' } });
    assert.ok(!isBlock(r));
  } finally { h.cleanup(); }
});

test('SKIP HATCH: skip.json active -> no nudge even when stale', () => {
  const h = makeHome();
  try {
    const out = writeOutputFile(h, 'worker-i.output', THRESHOLD_MS + 60000);
    const tp = h.writeTranscript([
      agentLaunchResultLine('abababababababab12', out, 'toolu_i', isoMinutesAgo(30)),
    ]);
    h.writeSkip({ 'silent-agent-nudge': Date.now() + 600000 });
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r));
  } finally { h.cleanup(); }
});

test('never emits any kill/stop field — advisory text only', () => {
  const h = makeHome();
  try {
    const out = writeOutputFile(h, 'worker-j.output', THRESHOLD_MS + 60000);
    const tp = h.writeTranscript([
      agentLaunchResultLine('acacacacacacacac12', out, 'toolu_j', isoMinutesAgo(30)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r));
    assert.ok(!r.json.kill, 'must never carry a kill/stop field');
  } finally { h.cleanup(); }
});

test('no transcript_path and no agents directory -> nothing (fail-open, no crash)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(''), { home: h.home });
    assert.ok(!isBlock(r));
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: malformed stdin -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad json', { home: h.home });
    assert.strictEqual(r.status, 0);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: transcript_path points at a missing file -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(path.join(h.home, 'no-such-transcript.jsonl')), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!isBlock(r));
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// SIGNATURE-ACK (peer complaint #1) — once the agent acks the exact stale-
// agent-id-set signature for this session (stopPayload's session_id is
// always 't'), the same signature stays advisory (no block) for the rest of
// the session; a DIFFERENT stale set (new agent id) still nudges normally.
// ---------------------------------------------------------------------------
test('SIGNATURE-ACK: acking the exact stale-agent signature silences it; a different set still nudges', () => {
  const h = makeHome();
  try {
    const stopAck = require('../../plugins/anti-hall/hooks/lib/stop-ack.js');
    const agentId = 'ccce100000000001';
    const out = writeOutputFile(h, 'worker-ack.output', THRESHOLD_MS + 60000);
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_ack', 'Ack scenario', isoMinutesAgo(90)),
      agentLaunchResultLine(agentId, out, 'toolu_ack', isoMinutesAgo(90)),
    ]);
    const payload = stopPayload(tp);

    const before = testHook(HOOK, payload, { home: h.home });
    assert.ok(isBlock(before), 'first Stop must block on the genuinely stale agent: ' + JSON.stringify(before.json));
    assert.match(before.json.reason, /Override \(only if the user explicitly confirmed/, 'reason must carry the ack hint');

    const sig = stopAck.signatureFor(agentId);
    assert.ok(stopAck.recordAck(h.home, payload.session_id, 'silent-agent-nudge', sig), 'ack write must succeed');

    // Re-touch the output file so the snapshot dedup key changes too — the
    // ack must silence it independent of the snapshot/hard-cap dedup already
    // in place, proving THIS is the ack mechanism at work, not those.
    const t = new Date(Date.now() - (THRESHOLD_MS + 2 * 60 * 60 * 1000));
    fs.utimesSync(out, t, t);
    const after = testHook(HOOK, payload, { home: h.home });
    assert.ok(!isBlock(after), 'an acked signature must stay advisory (no block) for the rest of the session: ' + JSON.stringify(after.json));

    // A DIFFERENT stale agent (new signature) must still nudge normally.
    const otherId = 'ddde100000000002';
    const out2 = writeOutputFile(h, 'worker-ack-other.output', THRESHOLD_MS + 60000);
    const tp2 = h.writeTranscript([
      agentToolUseLine('toolu_ack2', 'Different agent', isoMinutesAgo(90)),
      agentLaunchResultLine(otherId, out2, 'toolu_ack2', isoMinutesAgo(90)),
    ]);
    const other = testHook(HOOK, stopPayload(tp2), { home: h.home });
    assert.ok(isBlock(other), 'a different stale-agent signature must still nudge: ' + JSON.stringify(other.json));
  } finally { h.cleanup(); }
});

test('SETTING OFF: guards.stopAck=false ignores an existing ack and blocks again', () => {
  const h = makeHome();
  try {
    const stopAck = require('../../plugins/anti-hall/hooks/lib/stop-ack.js');
    const agentId = 'eeee100000000003';
    const out = writeOutputFile(h, 'worker-ack-off.output', THRESHOLD_MS + 60000);
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_ackoff', 'Ack off scenario', isoMinutesAgo(90)),
      agentLaunchResultLine(agentId, out, 'toolu_ackoff', isoMinutesAgo(90)),
    ]);
    const payload = stopPayload(tp);
    const sig = stopAck.signatureFor(agentId);
    assert.ok(stopAck.recordAck(h.home, payload.session_id, 'silent-agent-nudge', sig));
    const r = testHook(HOOK, payload, { home: h.home, env: { ANTIHALL_STOP_ACK: 'off' } });
    assert.ok(isBlock(r), 'ANTIHALL_STOP_ACK=off must ignore the existing ack: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('TERMINAL: killed/cancelled/canceled agents (notification and task_status shapes) are neither running nor silent', () => {
  for (const status of ['killed', 'cancelled', 'canceled']) {
    const h = makeHome();
    try {
      const out = writeOutputFile(h, 'worker-' + status + '.output', THRESHOLD_MS + 60 * 60 * 1000);
      const idN = 'aaaf300000000001';
      const idA = 'aaaf300000000002';
      const tp = h.writeTranscript([
        agentToolUseLine('toolu_k1', 'Ended via notification', isoMinutesAgo(90)),
        agentLaunchResultLine(idN, out, 'toolu_k1', isoMinutesAgo(90)),
        agentToolUseLine('toolu_k2', 'Ended via attachment', isoMinutesAgo(90)),
        agentLaunchResultLine(idA, out, 'toolu_k2', isoMinutesAgo(90)),
        notificationLine(idN, status, isoMinutesAgo(5)),
        { type: 'attachment', attachment: { type: 'task_status', taskId: idA, taskType: 'local_agent', description: 'x', status, outputFilePath: out }, timestamp: isoMinutesAgo(4) },
      ]);
      const r = testHook(HOOK, stopPayload(tp), { home: h.home });
      assert.ok(!isBlock(r), status + ' must be terminal, not silent: ' + JSON.stringify(r.json));
      const scan = require('../../plugins/anti-hall/hooks/lib/agent-scan.js').runningAgents(tp);
      assert.deepStrictEqual(scan.map((a) => a.id), [], status + ' must not be reported as running');
    } finally { h.cleanup(); }
  }
});

test('ADOPTED: task_status agent with no timestamp and no output file has no evidence of age -> not nudged', () => {
  const h = makeHome();
  try {
    const agentId = 'aaaf400000000001';
    const tp = h.writeTranscript([
      { type: 'attachment', attachment: { type: 'task_status', taskId: agentId, taskType: 'local_agent', description: 'Ageless', status: 'running' } },
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), 'no timestamp + no output file must not nudge: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('ADOPTED: task_status agent with an old entry timestamp and no output file is nudged from that timestamp', () => {
  const h = makeHome();
  try {
    const agentId = 'aaaf400000000002';
    const tp = h.writeTranscript([
      { type: 'attachment', attachment: { type: 'task_status', taskId: agentId, taskType: 'local_agent', description: 'Old adopted', status: 'running' }, timestamp: isoMinutesAgo(90) },
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), 'old entry timestamp is the launch time: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// SendMessage RESUME / queued-message / wide window (field, 2026-10-02: two
// background agents hung 45 and 88 minutes with no nudge). Synthetic ids only.
// ---------------------------------------------------------------------------

// resumeResultLine(fullId, isoTs) -> the REAL SendMessage-resume tool_result
// shape: JSON text whose message quotes only a SHORT id prefix, with the full
// id in resumedAgentId.
function resumeResultLine(fullId, isoTs) {
  const payload = { success: true, message: 'Resuming agent ' + fullId.slice(0, 7), resumedAgentId: fullId, pin: { id: fullId, name: fullId, ref: 'abc123' } };
  return {
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_r' + fullId.slice(-4), type: 'tool_result', content: [{ type: 'text', text: JSON.stringify(payload) }] }] },
    timestamp: isoTs,
  };
}

// queuedResultLine(fullId, isoTs) -> SendMessage to a STILL-RUNNING agent.
function queuedResultLine(fullId, isoTs) {
  const payload = { success: true, message: 'Message queued for delivery to ' + fullId + ' at its next tool round.', pin: { id: fullId, name: fullId, ref: 'abc123' } };
  return {
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_q' + fullId.slice(-4), type: 'tool_result', content: [{ type: 'text', text: JSON.stringify(payload) }] }] },
    timestamp: isoTs,
  };
}

test('RESUME: completed -> resumed (short-prefix message + resumedAgentId) -> silent 25m -> nudged', () => {
  const h = makeHome();
  try {
    const id = 'aaaa111122223333c';
    const out = writeOutputFile(h, 'resume-a.output', 25 * 60 * 1000);
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_ra', 'Resumed worker', isoMinutesAgo(120)),
      agentLaunchResultLine(id, out, 'toolu_ra', isoMinutesAgo(120)),
      notificationLine(id, 'completed', isoMinutesAgo(60)),
      resumeResultLine(id, isoMinutesAgo(40)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), 'a resumed agent silent past the threshold must nudge: ' + JSON.stringify(r.json));
    assert.match(r.json.reason, /Resumed worker/);
  } finally { h.cleanup(); }
});

test('RESUME: completed -> resumed -> completes AGAIN -> not nudged', () => {
  const h = makeHome();
  try {
    const id = 'aaaa111122223334c';
    const out = writeOutputFile(h, 'resume-b.output', 90 * 60 * 1000);
    const tp = h.writeTranscript([
      agentLaunchResultLine(id, out, 'toolu_rb', isoMinutesAgo(200)),
      notificationLine(id, 'completed', isoMinutesAgo(120)),
      resumeResultLine(id, isoMinutesAgo(100)),
      notificationLine(id, 'completed', isoMinutesAgo(30)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), 'a re-completed resumed agent is terminal: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('RESUME: completed -> resumed -> output still fresh -> not nudged', () => {
  const h = makeHome();
  try {
    const id = 'aaaa111122223335c';
    const out = writeOutputFile(h, 'resume-c.output', 60 * 1000);
    const tp = h.writeTranscript([
      agentLaunchResultLine(id, out, 'toolu_rc', isoMinutesAgo(200)),
      notificationLine(id, 'completed', isoMinutesAgo(120)),
      resumeResultLine(id, isoMinutesAgo(40)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), 'fresh output after a resume is working, not silent: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('RESUME: staleness runs from the resume time when the output file is older than the resume', () => {
  const h = makeHome();
  try {
    const id = 'aaaa111122223336c';
    const out = writeOutputFile(h, 'resume-d.output', 120 * 60 * 1000);
    const tp = h.writeTranscript([
      agentLaunchResultLine(id, out, 'toolu_rd', isoMinutesAgo(200)),
      notificationLine(id, 'completed', isoMinutesAgo(150)),
      resumeResultLine(id, isoMinutesAgo(5)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), 'just resumed (5m ago) is running from the resume, whatever the old output mtime: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('RESUME: the once-per-agent cap resets when the agent is resumed again', () => {
  const h = makeHome();
  try {
    const id = 'aaaa111122223337c';
    const out = writeOutputFile(h, 'resume-e.output', 90 * 60 * 1000);
    const first = h.writeTranscript([
      agentLaunchResultLine(id, out, 'toolu_re', isoMinutesAgo(200)),
    ]);
    assert.ok(isBlock(testHook(HOOK, stopPayload(first), { home: h.home })), 'first silence nudges');
    assert.ok(!isBlock(testHook(HOOK, stopPayload(first), { home: h.home })), 'cap holds without a resume');
    const second = h.writeTranscript([
      agentLaunchResultLine(id, out, 'toolu_re', isoMinutesAgo(200)),
      notificationLine(id, 'completed', isoMinutesAgo(80)),
      resumeResultLine(id, isoMinutesAgo(60)),
    ]);
    assert.ok(isBlock(testHook(HOOK, stopPayload(second), { home: h.home })), 'a resumed agent that goes silent again is a new life and nudges again');
  } finally { h.cleanup(); }
});

test('QUEUED MESSAGE: SendMessage "queued for delivery" to a running agent is not delivery evidence -> still nudged', () => {
  const h = makeHome();
  try {
    const id = 'aaaa111122223338c';
    const out = writeOutputFile(h, 'queued.output', 60 * 60 * 1000);
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_qa', 'Messaged worker', isoMinutesAgo(90)),
      agentLaunchResultLine(id, out, 'toolu_qa', isoMinutesAgo(90)),
      queuedResultLine(id, isoMinutesAgo(80)),
      queuedResultLine(id, isoMinutesAgo(79)),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), 'messaging a running agent must not mark it terminal: ' + JSON.stringify(r.json));
    assert.match(r.json.reason, /Messaged worker/);
  } finally { h.cleanup(); }
});

test('WINDOW: launch record more than 1.5MB before the end of the transcript is still seen', () => {
  const h = makeHome();
  try {
    const id = 'aaaa111122223339c';
    const out = writeOutputFile(h, 'wide.output', 60 * 60 * 1000);
    const filler = [];
    for (let i = 0; i < 4; i++) filler.push({ type: 'attachment', attachment: { type: 'note', text: 'x'.repeat(600 * 1024) }, timestamp: isoMinutesAgo(50) });
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_wa', 'Far-back worker', isoMinutesAgo(90)),
      agentLaunchResultLine(id, out, 'toolu_wa', isoMinutesAgo(90)),
      ...filler,
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), 'a launch outside the shared 1.5MB tail must still be scanned: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('SIDECHAIN: a fresh sidechain transcript keeps an agent with a stale output file from being nudged', () => {
  const h = makeHome();
  try {
    const id = 'aaaa11112222333ac';
    const out = writeOutputFile(h, 'side.output', 60 * 60 * 1000);
    const tp = h.writeTranscript([agentLaunchResultLine(id, out, 'toolu_sa', isoMinutesAgo(90))]);
    const subDir = path.join(path.dirname(tp), path.basename(tp, '.jsonl'), 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-' + id + '.jsonl'), '{}\n');
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), 'sidechain written just now means the agent is working: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

test('STALE-BUILD DOWNGRADE does not burn the once-per-agent cap', () => {
  const h = makeHome();
  try {
    const id = 'aaaa11112222333bc';
    const out = writeOutputFile(h, 'stalegate.output', 60 * 60 * 1000);
    const tp = h.writeTranscript([agentLaunchResultLine(id, out, 'toolu_sg', isoMinutesAgo(90))]);
    const installed = path.join(h.home, '.claude', 'plugins', 'installed_plugins.json');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, JSON.stringify({ plugins: { 'anti-hall@anti-hall': { version: '999.0.0', scope: 'user' } } }));
    assert.ok(!isBlock(testHook(HOOK, stopPayload(tp), { home: h.home })), 'stale build downgrades the block');
    fs.unlinkSync(installed);
    assert.ok(isBlock(testHook(HOOK, stopPayload(tp), { home: h.home })), 'once the build is current the suppressed nudge still fires');
  } finally { h.cleanup(); }
});

test('RESUME: a prefix-only resume matching TWO completed agents un-terminates neither; a unique prefix does', () => {
  const h = makeHome();
  try {
    const idA = 'bbbb111122223331c';
    const idB = 'bbbb111122223332c';
    const out = writeOutputFile(h, 'ambig.output', 60 * 1000);
    const prefixOnly = (prefix, ts) => ({
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_p' + prefix, type: 'tool_result', content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Resuming agent ' + prefix }) }] }] },
      timestamp: ts,
    });
    const base = [
      agentLaunchResultLine(idA, out, 'toolu_pa', isoMinutesAgo(100)),
      agentLaunchResultLine(idB, out, 'toolu_pb', isoMinutesAgo(100)),
      notificationLine(idA, 'completed', isoMinutesAgo(60)),
      notificationLine(idB, 'completed', isoMinutesAgo(60)),
    ];
    const { scanTranscript } = require('../../plugins/anti-hall/hooks/lib/agent-scan.js');
    const ambiguous = scanTranscript(h.writeTranscript(base.concat([prefixOnly('bbbb1111', isoMinutesAgo(30))])));
    assert.ok(ambiguous.terminal.has(idA) && ambiguous.terminal.has(idB), 'ambiguous prefix must un-terminate neither');
    const none = scanTranscript(h.writeTranscript(base.concat([prefixOnly('cccc9999', isoMinutesAgo(30))])));
    assert.ok(none.terminal.has(idA) && none.terminal.has(idB), 'a prefix matching nothing does nothing');
    const unique = scanTranscript(h.writeTranscript(base.concat([prefixOnly('bbbb11112222333' + '1', isoMinutesAgo(30))])));
    assert.ok(!unique.terminal.has(idA) && unique.terminal.has(idB), 'a prefix matching exactly one agent un-terminates only it');
  } finally { h.cleanup(); }
});

test('QUEUED MESSAGE: a leaf that merely QUOTES the phrase (not the JSON message field) is still delivery evidence', () => {
  const h = makeHome();
  try {
    const id = 'bbbb111122223333c';
    const out = writeOutputFile(h, 'quote.output', 60 * 60 * 1000);
    const quoting = {
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_qq', type: 'tool_result', content: [{ type: 'text', text: 'Agent ' + id + ' result: done. (log: Message queued for delivery to ' + id + ' earlier)' }] }] },
      timestamp: isoMinutesAgo(10),
    };
    const tp = h.writeTranscript([
      agentLaunchResultLine(id, out, 'toolu_qa2', isoMinutesAgo(90)),
      quoting,
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), 'a quoting leaf is not a SendMessage result and must still count as delivery: ' + JSON.stringify(r.json));
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// QUOTED RESUME / TaskStop (field, 2026-10-02: an agent killed hours earlier was
// re-opened by an unrelated notification whose result text quoted "Resuming
// agent <prefix>"). A resume counts only from a genuine tool_result.
// ---------------------------------------------------------------------------
const AGENT_SCAN = '../../plugins/anti-hall/hooks/lib/agent-scan.js';
const QUOTE = (id) => 'Report: the harness prints "Resuming agent ' + id.slice(0, 7) + '" on a SendMessage resume.';

function killedBase(h, id) {
  const out = writeOutputFile(h, 'q-' + id + '.output', 3 * 60 * 60 * 1000);
  return [
    agentToolUseLine('toolu_k' + id.slice(-3), 'Killed worker', isoMinutesAgo(400)),
    agentLaunchResultLine(id, out, 'toolu_k' + id.slice(-3), isoMinutesAgo(400)),
    notificationLine(id, 'killed', isoMinutesAgo(300)),
  ];
}

test('QUOTED RESUME: a later notification for ANOTHER agent whose result quotes "Resuming agent <prefix>" does not re-open the killed agent', () => {
  const h = makeHome();
  try {
    const id = 'a180b191000d7a82e';
    const other = 'cccc111122223333d';
    const quoting = {
      type: 'user',
      message: { role: 'user', content: '<task-notification>\n<task-id>' + other + '</task-id>\n<status>completed</status>\n<result>' + QUOTE(id) + '</result>\n</task-notification>' },
      timestamp: isoMinutesAgo(10),
    };
    const tp = h.writeTranscript(killedBase(h, id).concat([quoting]));
    const scan = require(AGENT_SCAN).scanTranscript(tp);
    assert.ok(scan.terminal.has(id), 'killed agent must stay terminal');
    assert.ok(!isBlock(testHook(HOOK, stopPayload(tp), { home: h.home })), 'no nudge for a killed agent');
  } finally { h.cleanup(); }
});

test('QUOTED RESUME: the quote inside assistant text, user-typed text, or a tool_use input does not re-open', () => {
  const id = 'a180b191000d7a82f';
  const shapes = {
    assistant: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: QUOTE(id) }] } },
    typed: { type: 'user', message: { role: 'user', content: QUOTE(id) } },
    typedBlocks: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: QUOTE(id) }] } },
    toolUseInput: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_zz', name: 'Bash', input: { command: 'echo ' + QUOTE(id) } }] } },
    // a tool_result that only QUOTES the phrase (not the JSON result itself)
    quotingToolResult: { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_qr', type: 'tool_result', content: [{ type: 'text', text: 'grep hit: {"success":true,"message":"Resuming agent ' + id.slice(0, 7) + '"} in notes' }] }] } },
  };
  for (const [name, line] of Object.entries(shapes)) {
    const h = makeHome();
    try {
      const tp = h.writeTranscript(killedBase(h, id).concat([Object.assign({ timestamp: isoMinutesAgo(10) }, line)]));
      const scan = require(AGENT_SCAN).scanTranscript(tp);
      assert.ok(scan.terminal.has(id), name + ': killed agent must stay terminal');
      assert.ok(!isBlock(testHook(HOOK, stopPayload(tp), { home: h.home })), name + ': no nudge');
    } finally { h.cleanup(); }
  }
});

test('QUOTED LAUNCH: a notification/typed text quoting a launch result does not open an agent', () => {
  const h = makeHome();
  try {
    const ghost = 'dddd111122223333e';
    const launchText = agentLaunchResultLine(ghost, '/tmp/nope.output', 'toolu_g', isoMinutesAgo(90)).message.content[0].content[0].text;
    const tp = h.writeTranscript([
      { type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>x1</task-id>\n<status>completed</status>\n<result>' + launchText + '</result>\n</task-notification>' }, timestamp: isoMinutesAgo(90) },
      { type: 'user', message: { role: 'user', content: launchText }, timestamp: isoMinutesAgo(90) },
    ]);
    assert.strictEqual(require(AGENT_SCAN).scanTranscript(tp).launched.size, 0, 'quoted launch text is not a launch');
  } finally { h.cleanup(); }
});

test('QUOTED LAUNCH: a Read/Bash tool_result containing launch text is not a launch (no phantom running agent)', () => {
  const h = makeHome();
  try {
    const ghost = 'dddd111122223333f';
    const launchText = agentLaunchResultLine(ghost, '/tmp/nope.output', 'x', isoMinutesAgo(90)).message.content[0].content[0].text;
    const readUse = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_rd', name: 'Read', input: { file_path: '/tmp/notes.md' } }] }, timestamp: isoMinutesAgo(90) };
    const readResult = { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_rd', type: 'tool_result', content: [{ type: 'text', text: launchText }] }] }, timestamp: isoMinutesAgo(89) };
    const tp = h.writeTranscript([readUse, readResult]);
    assert.strictEqual(require(AGENT_SCAN).scanTranscript(tp).launched.size, 0, 'a Read result is not a launch');
    // the genuine launch (answering a seen Agent call) still counts
    const real = h.writeTranscript([agentToolUseLine('toolu_ag', 'Real', isoMinutesAgo(90)), agentLaunchResultLine(ghost, '/tmp/nope.output', 'toolu_ag', isoMinutesAgo(90))]);
    assert.ok(require(AGENT_SCAN).scanTranscript(real).launched.has(ghost), 'a launch answering an Agent call counts');
  } finally { h.cleanup(); }
});

test('QUOTED NOTIFICATION: a user message quoting a completed block mid-text does not close a live agent; a real leading notice does', () => {
  const h = makeHome();
  try {
    const id = '1234abcd5678ef901';
    const out = writeOutputFile(h, 'qn.output', 60 * 60 * 1000);
    const launch = [agentToolUseLine('toolu_qn', 'Live worker', isoMinutesAgo(90)), agentLaunchResultLine(id, out, 'toolu_qn', isoMinutesAgo(90))];
    const quoted = { type: 'user', message: { role: 'user', content: 'FYI this is what a notice looks like:\n' + notificationText(id, 'completed') }, timestamp: isoMinutesAgo(5) };
    const tp = h.writeTranscript(launch.concat([quoted]));
    assert.deepStrictEqual(require(AGENT_SCAN).runningAgents(tp).map((a) => a.id), [id], 'quoted notice must not close it');
    const tp2 = h.writeTranscript(launch.concat([notificationLine(id, 'completed', isoMinutesAgo(5))]));
    assert.deepStrictEqual(require(AGENT_SCAN).runningAgents(tp2).map((a) => a.id), [], 'a real notice closes it');
  } finally { h.cleanup(); }
});

test('DELIVERY NET: a Bash/Read result that merely contains the agent id does not close it; a TaskOutput result naming it does', () => {
  const h = makeHome();
  try {
    const id = '99aa111122223333b';
    const out = writeOutputFile(h, 'dn.output', 60 * 60 * 1000);
    const launch = [agentToolUseLine('toolu_dn', 'Net worker', isoMinutesAgo(90)), agentLaunchResultLine(id, out, 'toolu_dn', isoMinutesAgo(90))];
    const pair = (name, input, text) => [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_p_' + name, name, input }] }, timestamp: isoMinutesAgo(10) },
      { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_p_' + name, type: 'tool_result', content: [{ type: 'text', text }] }] }, timestamp: isoMinutesAgo(9) },
    ];
    const grep = h.writeTranscript(launch.concat(pair('Bash', { command: 'grep -r worker notes/' }, 'notes/todo.md: check ' + id + ' later')));
    assert.deepStrictEqual(require(AGENT_SCAN).runningAgents(grep).map((a) => a.id), [id], 'a grep result mentioning the id is not delivery');
    const delivered = h.writeTranscript(launch.concat(pair('TaskOutput', { task_id: id }, 'agent ' + id + ' result: done')));
    assert.deepStrictEqual(require(AGENT_SCAN).runningAgents(delivered).map((a) => a.id), [], 'a TaskOutput result for the id is delivery');
  } finally { h.cleanup(); }
});

test('NOTIFICATION LEAF: a system-reminder-wrapped notice after other text is terminal; a sentence-quoted one is not', () => {
  const id = '5555aaaa6666bbbb7';
  const wrapped = notificationText(id, 'completed');
  const cases = [
    ['text before a system-reminder block', 'hello\n<system-reminder>\n' + wrapped + '\n</system-reminder>', true],
    ['"Note:" before a system-reminder block (array text block)', [{ type: 'text', text: 'Note: <system-reminder>' + wrapped + '</system-reminder>' }], true],
    ['quoted mid-sentence, no system-reminder wrapper', 'as the report said: ' + wrapped, false],
  ];
  for (const [name, content, closes] of cases) {
    const h = makeHome();
    try {
      const out = writeOutputFile(h, 'nl.output', 60 * 60 * 1000);
      const tp = h.writeTranscript([
        agentToolUseLine('toolu_nl', 'Leaf worker', isoMinutesAgo(90)),
        agentLaunchResultLine(id, out, 'toolu_nl', isoMinutesAgo(90)),
        { type: 'user', message: { role: 'user', content }, timestamp: isoMinutesAgo(5) },
      ]);
      assert.strictEqual(require(AGENT_SCAN).scanTranscript(tp).terminal.has(id), closes, name);
    } finally { h.cleanup(); }
  }
});

test('DELIVERY NET: a TaskOutput call with a short unique id prefix whose result names the agent closes it; an ambiguous prefix does not', () => {
  const h = makeHome();
  try {
    const idA = '77bb111122223333c';
    const idB = '77bb111122223333d';
    const out = writeOutputFile(h, 'dp.output', 60 * 60 * 1000);
    const launches = [
      agentToolUseLine('toolu_da', 'A', isoMinutesAgo(90)), agentLaunchResultLine(idA, out, 'toolu_da', isoMinutesAgo(90)),
      agentToolUseLine('toolu_db', 'B', isoMinutesAgo(90)), agentLaunchResultLine(idB, out, 'toolu_db', isoMinutesAgo(90)),
    ];
    const pair = (prefix) => [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_to', name: 'TaskOutput', input: { task_id: prefix } }] }, timestamp: isoMinutesAgo(10) },
      { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_to', type: 'tool_result', content: [{ type: 'text', text: 'agent ' + idA + ' result: done' }] }] }, timestamp: isoMinutesAgo(9) },
    ];
    const full = require(AGENT_SCAN).scanTranscript(h.writeTranscript(launches.concat(pair(idA))));
    assert.ok(full.terminal.has(idA), 'full-id call closes A');
    const ambiguous = require(AGENT_SCAN).scanTranscript(h.writeTranscript(launches.concat(pair('77bb1111'))));
    assert.ok(!ambiguous.terminal.has(idA), 'a prefix matching two launches names neither');
    const solo = require(AGENT_SCAN).scanTranscript(h.writeTranscript(launches.slice(0, 2).concat(pair('77bb1111'))));
    assert.ok(solo.terminal.has(idA), 'a unique >=7-hex prefix names the agent');
  } finally { h.cleanup(); }
});

test('TASKSTOP: an errored TaskStop (paired tool_result is_error) is not terminal; with no visible result it still is', () => {
  const h = makeHome();
  try {
    const id = '8899aabb1122ccddd';
    const out = writeOutputFile(h, 'te.output', 60 * 60 * 1000);
    const base = [agentToolUseLine('toolu_te', 'Err worker', isoMinutesAgo(90)), agentLaunchResultLine(id, out, 'toolu_te', isoMinutesAgo(90))];
    const stop = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_tse', name: 'TaskStop', input: { task_id: id } }] }, timestamp: isoMinutesAgo(10) };
    const errResult = { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_tse', type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'No task found' }] }] }, timestamp: isoMinutesAgo(9) };
    assert.ok(!require(AGENT_SCAN).scanTranscript(h.writeTranscript(base.concat([stop, errResult]))).terminal.has(id), 'errored TaskStop is not terminal');
    assert.ok(require(AGENT_SCAN).scanTranscript(h.writeTranscript(base.concat([stop]))).terminal.has(id), 'no visible result -> terminal');
  } finally { h.cleanup(); }
});

test('TASKSTOP: an assistant TaskStop tool_use for the agent id is terminal with no notification; a later genuine resume re-opens it', () => {
  const h = makeHome();
  try {
    const id = 'eeee111122223333f';
    const out = writeOutputFile(h, 'ts.output', 3 * 60 * 60 * 1000);
    const stop = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ts', name: 'TaskStop', input: { task_id: id } }] }, timestamp: isoMinutesAgo(200) };
    const base = [
      agentToolUseLine('toolu_tsa', 'Stopped worker', isoMinutesAgo(400)),
      agentLaunchResultLine(id, out, 'toolu_tsa', isoMinutesAgo(400)),
      stop,
    ];
    const tp = h.writeTranscript(base);
    assert.ok(require(AGENT_SCAN).scanTranscript(tp).terminal.has(id), 'TaskStop is terminal');
    assert.ok(!isBlock(testHook(HOOK, stopPayload(tp), { home: h.home })), 'no nudge after TaskStop');
    const tp2 = h.writeTranscript(base.concat([resumeResultLine(id, isoMinutesAgo(100))]));
    assert.ok(!require(AGENT_SCAN).scanTranscript(tp2).terminal.has(id), 'a later genuine resume re-opens it');
  } finally { h.cleanup(); }
});

test('RESUME: killed -> real SendMessage resume tool_result (resumedAgentId) -> live again and flagged when silent', () => {
  const h = makeHome();
  try {
    const id = 'ffff111122223333a';
    const out = writeOutputFile(h, 'kr.output', 60 * 60 * 1000);
    const tp = h.writeTranscript([
      agentToolUseLine('toolu_kr', 'Revived worker', isoMinutesAgo(300)),
      agentLaunchResultLine(id, out, 'toolu_kr', isoMinutesAgo(300)),
      notificationLine(id, 'killed', isoMinutesAgo(200)),
      resumeResultLine(id, isoMinutesAgo(100)),
    ]);
    assert.ok(!require(AGENT_SCAN).scanTranscript(tp).terminal.has(id), 'resumed agent is live');
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), 'resumed then silent -> flagged: ' + JSON.stringify(r.json));
    assert.match(r.json.reason, /Revived worker/);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Slow-run diagnostics: a slow boundary (or a huge transcript) leaves a line in
// the central anti-hall log; a fast run leaves nothing; logging never changes
// the hook's output. Slowness is injected through the test-only clock hook
// ANTIHALL_TEST_SLOW_PHASE="<phase>:<ms>" (no sleeping).
// ---------------------------------------------------------------------------

function diagLines(logDir) {
  try {
    return fs.readFileSync(path.join(logDir, 'devswarm.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.component === 'silent-agent-nudge');
  } catch (_) { return []; }
}

function staleTranscript(h) {
  const out = writeOutputFile(h, 'diag.output', THRESHOLD_MS + 5 * 60 * 1000);
  return h.writeTranscript([
    agentToolUseLine('toolu_d', 'Diag agent', isoMinutesAgo(30)),
    agentLaunchResultLine('d1111111111111111', out, 'toolu_d', isoMinutesAgo(30)),
  ]);
}

test('DIAG: a fast run writes nothing to the log', () => {
  const h = makeHome();
  try {
    const logDir = path.join(h.home, 'diag-log');
    const r = testHook(HOOK, stopPayload(staleTranscript(h)), { home: h.home, env: { ANTI_HALL_LOG_DIR: logDir } });
    assert.ok(isBlock(r), 'the nudge itself is unchanged');
    assert.deepStrictEqual(diagLines(logDir), []);
  } finally { h.cleanup(); }
});

test('DIAG: a slow boundary writes exactly one line carrying hook, session, size, phases and node version', () => {
  const h = makeHome();
  try {
    const logDir = path.join(h.home, 'diag-log');
    const tp = h.writeTranscript([agentToolUseLine('toolu_x', 'nothing launched', isoMinutesAgo(1))]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home, env: { ANTI_HALL_LOG_DIR: logDir, ANTIHALL_TEST_SLOW_PHASE: 'decision:2500' } });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    const lines = diagLines(logDir);
    assert.strictEqual(lines.length, 1, 'exactly one slow line: ' + JSON.stringify(lines));
    assert.strictEqual(lines[0].op, 'slow');
    assert.strictEqual(lines[0].ctx.hook, 'silent-agent-nudge');
    assert.strictEqual(lines[0].ctx.sessionId, 't');
    assert.strictEqual(lines[0].ctx.transcriptBytes, fs.statSync(tp).size);
    assert.strictEqual(lines[0].ctx.node, process.version);
    assert.deepStrictEqual(lines[0].ctx.phases.map((p) => p.phase),
      ['start', 'stdin-read', 'settings-skip', 'transcript-scan', 'sidechain-heartbeat', 'decision']);
    assert.ok(lines[0].ctx.phases[5].ms > 2000, 'the slow boundary is past 2000 ms');
    assert.ok(lines[0].ctx.phases.slice(0, 5).every((p) => p.ms < 2000), 'earlier phases were fast');
  } finally { h.cleanup(); }
});

test('DIAG: a transcript over 8 MB writes one "started" line before the scan', () => {
  const h = makeHome();
  try {
    const logDir = path.join(h.home, 'diag-log');
    const tp = h.writeTranscript([agentToolUseLine('toolu_x', 'nothing launched', isoMinutesAgo(1))]);
    fs.appendFileSync(tp, 'x'.repeat(9 * 1024 * 1024) + '\n');
    const r = testHook(HOOK, stopPayload(tp), { home: h.home, env: { ANTI_HALL_LOG_DIR: logDir } });
    assert.strictEqual(r.status, 0);
    const lines = diagLines(logDir);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].op, 'started');
    assert.ok(lines[0].ctx.transcriptBytes > 8 * 1024 * 1024);
    assert.deepStrictEqual(lines[0].ctx.phases.map((p) => p.phase), ['start', 'stdin-read', 'settings-skip']);
  } finally { h.cleanup(); }
});

test('DIAG: a logging failure changes neither the hook output nor its exit code', () => {
  const h = makeHome();
  try {
    const tp = staleTranscript(h);
    const blocker = path.join(h.home, 'not-a-dir');
    fs.writeFileSync(blocker, 'file');
    const base = testHook(HOOK, stopPayload(tp), { home: h.home, env: { ANTI_HALL_LOG_DIR: path.join(h.home, 'ok-log') } });
    assert.ok(isBlock(base), 'baseline nudges');
    // the baseline persisted its once-only state; clear it so the second run is comparable
    fs.rmSync(path.join(h.home, '.anti-hall', 'silent-agent-nudge-state.json'), { force: true });
    const broken = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: { ANTI_HALL_LOG_DIR: path.join(blocker, 'sub'), ANTIHALL_TEST_SLOW_PHASE: 'state-read:2500' },
    });
    assert.strictEqual(broken.status, base.status);
    // the ack hint embeds the wall-clock time; mask only that 13-digit timestamp
    const mask = (s) => s.replace(/": \d{13}\}/, '": <ts>}');
    assert.strictEqual(mask(broken.stdout), mask(base.stdout), 'identical block output despite the failed log write');
  } finally { h.cleanup(); }
});

test('TERMINAL SHAPES: killed via user-string, queued attachment, and system-reminder-in-later-user-message are all terminal', () => {
  const id = 'abab111122223333b';
  const shapes = {
    userString: (i) => notificationLine(i, 'killed', isoMinutesAgo(5)),
    attachment: (i) => notificationAttachmentLine(i, 'killed', isoMinutesAgo(5)),
    systemReminder: (i) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>\n' + notificationText(i, 'killed') + '\n</system-reminder>' }] }, timestamp: isoMinutesAgo(5) }),
  };
  for (const [name, mk] of Object.entries(shapes)) {
    const h = makeHome();
    try {
      const out = writeOutputFile(h, 'sh-' + name + '.output', 3 * 60 * 60 * 1000);
      const tp = h.writeTranscript([agentLaunchResultLine(id, out, 'toolu_sh', isoMinutesAgo(300)), mk(id)]);
      assert.ok(require(AGENT_SCAN).scanTranscript(tp).terminal.has(id), name + ' must be terminal');
      assert.ok(!isBlock(testHook(HOOK, stopPayload(tp), { home: h.home })), name + ': no nudge');
    } finally { h.cleanup(); }
  }
});

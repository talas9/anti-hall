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
    assert.match(r.json.reason, /^anti-hall silent-agent-nudge: 1 /, 'the reported stale count must also be deduped to 1: ' + r.json.reason);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Heartbeat source (kept as an ADDITIONAL signal)
// ---------------------------------------------------------------------------

function writeHeartbeatAgent(h, id, opts) {
  const o = opts || {};
  const ts = Date.now() - (typeof o.ageMs === 'number' ? o.ageMs : 0);
  const dir = path.join(h.antiHall, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({
    id, ts, status: o.status || 'running', step: o.step || 'doing work',
  }), 'utf8');
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
    assert.match(before.json.reason, /ack it for the rest of this session/, 'reason must carry the ack hint');

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

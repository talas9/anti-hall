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
  const text = '<task-notification>\n<task-id>' + taskId + '</task-id>\n' +
    '<tool-use-id>toolu_01ABCDEF</tool-use-id>\n' +
    '<output-file>/tmp/whatever/tasks/' + taskId + '.output</output-file>\n' +
    '<status>' + status + '</status>\n' +
    '<summary>Agent "x" finished</summary>\n</task-notification>';
  return {
    type: 'user',
    message: { role: 'user', content: text },
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

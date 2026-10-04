'use strict';
// Child-turn static block (COMMS OVERRIDE + SELF_CONTINUE + REMINDER +
// RECEIVE_NUDGE) must follow guards.injectionRepeatEvery like the parent-inbox
// COMMS OVERRIDE: once delivered, re-sent on change, after compaction, and every
// N delivered turns — not on every turn. Real spawned hook, isolated HOME.
// The Codex port runs this same file (codex/hooks/hooks.json -> hooks/devswarm-child-turn.js).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');

const HOOK = 'devswarm-child-turn.js';
const MARK = 'DEVSWARM COMMS OVERRIDE';
function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-childka-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function attLine(ts, text) {
  return JSON.stringify({
    type: 'attachment', timestamp: new Date(ts).toISOString(),
    attachment: { type: 'hook_additional_context', content: [text], hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit' },
  }) + '\n';
}
function ctx(r) { return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || ''; }

function session(home, tp) {
  return function turn(builderId, extraEnv) {
    const r = testHook(HOOK, { hook_event_name: 'UserPromptSubmit', session_id: 'ka', prompt: 'go', transcript_path: tp, cwd: '/tmp' }, {
      home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: builderId,
        ANTIHALL_INGEST_DRY_RUN: '1', ANTIHALL_EMIT_DEDUPE: '1', ...(extraEnv || {}) },
    });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    // the model "received" this turn's context -> it lands in the transcript
    if (c) fs.appendFileSync(tp, attLine(Date.now(), c));
    return c.includes(MARK);
  };
}
function setup() {
  const home = tmpHome();
  const tp = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(tp, attLine(Date.now() - 3600 * 1000, 'OLDER TURN'));
  return { home, tp, turn: session(home, tp) };
}
const wait = () => { const t = Date.now() + 15; while (Date.now() < t) { /* ensure strictly later timestamps */ } };

test('child: 12 delivered turns, unchanged -> COMMS OVERRIDE once plus keepalive, not every turn', () => {
  const { home, turn } = setup();
  try {
    const emitted = [];
    for (let i = 0; i < 12; i++) { emitted.push(turn('b-1')); wait(); }
    assert.strictEqual(emitted[0], true, 'first turn injects');
    assert.ok(emitted.slice(1, 10).every((x) => !x), 'quiet between keepalives: ' + emitted.join());
    const n = emitted.filter(Boolean).length;
    assert.ok(n >= 2 && n <= 3, 'one injection + keepalive within 12 turns, got ' + n);
  } finally { rm(home); }
});

test('child: changed content (different builder id) -> re-injected', () => {
  const { home, turn } = setup();
  try {
    assert.strictEqual(turn('b-1'), true); wait();
    assert.strictEqual(turn('b-1'), false); wait();
    assert.strictEqual(turn('b-2'), true, 'content changed -> re-sent');
  } finally { rm(home); }
});

test('child: after compaction reset (SessionStart compact) -> re-injected', () => {
  const { home, tp, turn } = setup();
  try {
    assert.strictEqual(turn('b-1'), true); wait();
    assert.strictEqual(turn('b-1'), false); wait();
    const r = testHook('emit-dedupe-reset.js', { hook_event_name: 'SessionStart', source: 'compact', session_id: 'ka', transcript_path: tp, cwd: home },
      { home, env: { ANTIHALL_INGEST_DRY_RUN: '1', ANTIHALL_EMIT_DEDUPE: '1' } });
    assert.strictEqual(r.status, 0); wait();
    assert.strictEqual(turn('b-1'), true, 'post-compact re-sent');
  } finally { rm(home); }
});

test('child: injectionRepeatEvery=0 -> burst collapse only, re-sent every delivered turn', () => {
  const { home, turn } = setup();
  try {
    const env = { ANTIHALL_INJECTION_REPEAT_EVERY: '0' };
    assert.strictEqual(turn('b-1', env), true); wait();
    assert.strictEqual(turn('b-1', env), true); wait();
    assert.strictEqual(turn('b-1', env), true);
  } finally { rm(home); }
});

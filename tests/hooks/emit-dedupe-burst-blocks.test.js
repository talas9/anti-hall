'use strict';
// L14(a): queued-prompt bursts (cron ticks delivered together) must emit each
// static block ONCE, for every hook that emits one — limit-conserve, the
// DevSwarm PRIMARY task-tracker blocks (TASK-LIST / DISPATCH TIER) and the
// parent-inbox COMMS OVERRIDE. Real spawned hooks, isolated HOME.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');

const T0 = Date.now() - 3600 * 1000;
function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-burst-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function attLine(ts, text) {
  return JSON.stringify({
    type: 'attachment', timestamp: new Date(ts).toISOString(),
    attachment: { type: 'hook_additional_context', content: [text], hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit' },
  }) + '\n';
}
function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

// n queued invocations, no delivery between them -> per-matcher emit counts;
// then deliver the first emitted copy and invoke once more.
function burst(hook, n, { env, seed }, matchers) {
  const home = tmpHome();
  try {
    if (seed) seed(home);
    const tp = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(tp, attLine(T0, 'OLDER TURN'));
    const counts = matchers.map(() => 0);
    let first = '';
    const run = (i) => {
      const r = testHook(hook, { hook_event_name: 'UserPromptSubmit', session_id: 'burst', prompt: 'cron tick ' + i, transcript_path: tp, cwd: '/tmp/x' },
        { home, env: { ANTIHALL_INGEST_DRY_RUN: '1', ANTIHALL_EMIT_DEDUPE: '1', ...env } });
      assert.strictEqual(r.status, 0);
      return ctx(r);
    };
    const start = Date.now();
    for (let i = 0; i < n; i++) {
      const c = run(i);
      if (!first && c) first = c;
      matchers.forEach((m, j) => { if (m(c)) counts[j]++; });
    }
    fs.appendFileSync(tp, attLine(start, first)); // delivered
    const after = run(n);
    return { counts, after: matchers.map((m) => (m(after) ? 1 : 0)) };
  } finally { rm(home); }
}

test('limit-conserve: 4 queued prompts -> 1 LIMIT CONSERVATION block; emitted again after delivery', () => {
  const r = burst('limit-conserve-inject.js', 4, { env: { ANTIHALL_LIMIT_CONSERVE: 'on' } }, [(c) => c.includes('limit conservation is active')]);
  assert.deepStrictEqual(r.counts, [1]);
  // keepalive key (guards.injectionRepeatEvery=10): consumed + unchanged -> quiet on the next delivered turn by design.
  assert.deepStrictEqual(r.after, [0]);
});

test('task-tracker as DevSwarm PRIMARY: 4 queued prompts -> 1 TASK-LIST and 1 DISPATCH TIER; again after delivery', () => {
  const r = burst('task-tracker.js', 4, { env: { DEVSWARM_REPO_ID: 'repo-x' } },
    [(c) => c.includes('task-tracker: capture'), (c) => c.includes('task-tracker: Primary dispatch tier')]);
  assert.deepStrictEqual(r.counts, [1, 1]);
  // TASK-LIST is burst-collapse only (re-emitted after delivery); the PRIMARY block is a keepalive key (quiet).
  assert.deepStrictEqual(r.after, [1, 0]);
});

test('devswarm-parent-inbox: 4 queued prompts -> 1 COMMS OVERRIDE; again after delivery', () => {
  const r = burst('devswarm-parent-inbox.js', 4, { env: { DEVSWARM_REPO_ID: 'repo-x' } },
    [(c) => c.includes('devswarm-comms')]);
  assert.deepStrictEqual(r.counts, [1]);
  assert.deepStrictEqual(r.after, [0]);
});

test('devswarm-parent-inbox: injectionRepeatEvery=0 -> burst collapse only, COMMS OVERRIDE re-emitted after delivery', () => {
  const r = burst('devswarm-parent-inbox.js', 4, { env: { DEVSWARM_REPO_ID: 'repo-x', ANTIHALL_INJECTION_REPEAT_EVERY: '0' } },
    [(c) => c.includes('devswarm-comms')]);
  assert.deepStrictEqual(r.counts, [1]);
  assert.deepStrictEqual(r.after, [1]);
});

test('vacuity: emit-dedupe off -> every queued prompt repeats the COMMS OVERRIDE', () => {
  const r = burst('devswarm-parent-inbox.js', 4, { env: { DEVSWARM_REPO_ID: 'repo-x', ANTIHALL_EMIT_DEDUPE: '0' } },
    [(c) => c.includes('devswarm-comms')]);
  assert.deepStrictEqual(r.counts, [4]);
});

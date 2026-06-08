'use strict';
// merge-gate (PreToolUse Bash). OPT-IN, default OFF. Backstops the v0.30.0
// "false done" discipline: block an AUTO-MERGE when the agent's own recent output
// carries an UNRESOLVED self-hedge.
// Verifies: default-off no-op; ON + merge + hedge -> block + reason; ON + merge +
// no hedge -> allow; ON + hedge + resolution token -> allow; ON + non-merge cmd ->
// allow; fail-open on malformed/no transcript.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome, assistantMessage } = require('../helpers/fixtures.js');

const HOOK = 'merge-gate.js';
const ON = { ANTIHALL_MERGE_GATE: '1' };

// Build a PreToolUse Bash payload with the given command + transcript path.
function bashPayload(command, transcriptPath) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    session_id: 't',
    cwd: process.cwd(),
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
  };
}

test('DEFAULT OFF: env unset -> no-op allow even on a merge with a recent hedge', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('This is a first-pass, do not merge yet.')]);
    const r = testHook(HOOK, bashPayload('gh pr merge 42 --squash', tp), { home: h.home });
    assert.strictEqual(r.status, 0, `expected allow when gate off; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('ON + `gh pr merge` + recent unresolved hedge -> BLOCK (exit 2) with reason', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('Built the dashboard — pending review by you.')]);
    const r = testHook(HOOK, bashPayload('gh pr merge 42 --squash', tp), { home: h.home, env: ON });
    assert.strictEqual(r.status, 2, `expected block; stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.match(r.stderr, /merge-gate/);
    assert.match(r.stderr, /pending review/);
    assert.match(r.stderr, /false-done backstop/);
  } finally { h.cleanup(); }
});

test('ON + `gh pr merge --auto` + hedge ("do not merge") -> BLOCK', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('Landed the slice. Do not merge — needs your eyes.')]);
    const r = testHook(HOOK, bashPayload('gh pr merge --auto 7', tp), { home: h.home, env: ON });
    assert.strictEqual(r.status, 2, `expected block; stderr: ${r.stderr}`);
    assert.match(r.stderr, /merge-gate/);
  } finally { h.cleanup(); }
});

test('ON + `gh pr review --approve` + hedge -> BLOCK', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('First-pass implementation, not pixel-perfect.')]);
    const r = testHook(HOOK, bashPayload('gh pr review 9 --approve', tp), { home: h.home, env: ON });
    assert.strictEqual(r.status, 2, `expected block; stderr: ${r.stderr}`);
    assert.match(r.stderr, /merge-gate/);
    // Order-sensitive: reports the LAST hedge ("not pixel-perfect")
    assert.match(r.stderr, /not pixel[- ]perfect/i);
  } finally { h.cleanup(); }
});

test('ON + `git merge --no-ff` into main + hedge -> BLOCK', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('Done, pending owner sign-off on copy.')]);
    const r = testHook(HOOK, bashPayload('git merge --no-ff feature-x main', tp), { home: h.home, env: ON });
    assert.strictEqual(r.status, 2, `expected block; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('ON + `gh pr merge` + NO hedge -> allow', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('All criteria verified and green. Merging.')]);
    const r = testHook(HOOK, bashPayload('gh pr merge 42 --squash', tp), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow with no hedge; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('ON + hedge + resolution token ("verified against") -> allow', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      assistantMessage('This was a first-pass earlier.'),
      assistantMessage('Now verified against the agreed spec — all checks pass.'),
    ]);
    const r = testHook(HOOK, bashPayload('gh pr merge 42 --squash', tp), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow after resolution; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('ON + hedge + resolution token ("owner signed off") -> allow', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      assistantMessage('Pending review of the layout.'),
      assistantMessage('Owner signed off in the thread.'),
    ]);
    const r = testHook(HOOK, bashPayload('gh pr merge 1', tp), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow after owner sign-off; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('ON + resolution token THEN later hedge ("verified against spec" then "still first-pass") -> BLOCK (order-sensitive)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      assistantMessage('verified against spec — all checks pass.'),
      assistantMessage('Wait, still first-pass, do not merge yet.'),
    ]);
    const r = testHook(HOOK, bashPayload('gh pr merge 42 --squash', tp), { home: h.home, env: ON });
    assert.strictEqual(r.status, 2, `expected block when hedge appears after resolution; stderr: ${r.stderr}`);
    assert.match(r.stderr, /merge-gate/);
    // Order-sensitive: reports the LAST hedge ("do not merge" comes after "first-pass")
    assert.match(r.stderr, /do not merge/);
  } finally { h.cleanup(); }
});

test('ON + non-merge command (`ls`) + hedge present -> allow', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('This is a first-pass, do not merge.')]);
    const r = testHook(HOOK, bashPayload('ls -la', tp), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow on non-merge cmd; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('ON + non-merge command (`git status`) + hedge present -> allow', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('first-pass, pending review')]);
    const r = testHook(HOOK, bashPayload('git status', tp), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow on git status; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('ON + plain `git merge` (no --no-ff/--ff, not into protected branch) -> allow', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('first-pass, do not merge')]);
    const r = testHook(HOOK, bashPayload('git merge feature-branch', tp), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow on plain feature merge; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('hedge only in a USER message (not assistant) -> allow (agent did not hedge)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'is this a first-pass? do not merge.' }] } },
      assistantMessage('It is fully verified and complete.'),
    ]);
    const r = testHook(HOOK, bashPayload('gh pr merge 5', tp), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow when only user hedged; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('fail-open: malformed JSON stdin -> allow (exit 0) even with gate ON', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{not json', { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected fail-open on bad stdin; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('fail-open: empty stdin -> allow (exit 0)', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected fail-open on empty stdin; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('fail-open: ON + merge + hedge but NO transcript_path -> allow', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, bashPayload('gh pr merge 42', undefined), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected fail-open with no transcript; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('fail-open: ON + merge + hedge but transcript path does not exist -> allow', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, bashPayload('gh pr merge 42', '/no/such/transcript.jsonl'), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected fail-open on missing transcript; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('env value "off"/"0"/"false" -> treated as OFF (no-op allow)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('first-pass, do not merge')]);
    for (const v of ['off', '0', 'false', 'no', '']) {
      const r = testHook(HOOK, bashPayload('gh pr merge 42', tp), { home: h.home, env: { ANTIHALL_MERGE_GATE: v } });
      assert.strictEqual(r.status, 0, `expected allow for env="${v}"; stderr: ${r.stderr}`);
    }
  } finally { h.cleanup(); }
});

test('skip-hatch: merge-gate skip marker disables the gate', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'merge-gate': Date.now() + 60_000 });
    const tp = h.writeTranscript([assistantMessage('first-pass, do not merge')]);
    const r = testHook(HOOK, bashPayload('gh pr merge 42', tp), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow when skipped; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

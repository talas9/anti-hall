'use strict';
// devswarm-parent-reply-tracker (PostToolUse hook, matcher Bash, Primary only).
// Observation mechanism for PLAN §4.3: on a genuine successful
// `send --to <id> ...` DIRECT, records a reply via
// companion/lib/devswarm-reply-state.js's recordReply so the Stop-gate can tell
// "read" apart from "decided and replied". Observe-only: never blocks, never
// emits a `decision`, fails open on every malformed/wrong-shape input.
//
// PER-PROJECT SCOPING (fix-wave): the reply is now recorded under a durable
// `repoKey` (companion/lib/devswarm-repokey.js's repoKeyForWorktree, resolved
// from the PostToolUse payload's `cwd`) instead of the Claude `session_id` —
// see devswarm-parent-gate.js/devswarm-parent-inbox.js's own reply-state
// reads, which reuse the SAME per-project key. `postToolUseBashPayload`
// (spawn-hook.js) always sets `cwd: process.cwd()`, i.e. THIS repo's own real
// git checkout, so every test below reads/writes reply-state via REPO_KEY,
// not the payload's `sessionId` field (kept in payloads purely for
// readability/uniqueness across cases, no longer load-bearing for this hook).

const { test } = require('node:test');
const assert = require('node:assert');
const { testHookRaw, postToolUseBashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const { readReplyState } = require('../../plugins/anti-hall/companion/lib/devswarm-reply-state.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const HOOK = 'devswarm-parent-reply-tracker.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' }; // active + Primary (no SOURCE_BRANCH)
const CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'some-branch' };

// REPO_KEY — the durable per-project key `postToolUseBashPayload`'s
// `cwd: process.cwd()` resolves to (this repo's own real git checkout). Every
// test below reads reply-state back via THIS key, matching what the hook
// itself now resolves from the same payload.cwd.
const REPO_KEY = repokey.repoKeyForWorktree(process.cwd());

function run(home, payload, env) {
  return testHookRaw(HOOK, JSON.stringify(payload), {
    home,
    env: { ...(env !== undefined ? env : PRIMARY_ENV) },
  });
}

// needsReply defaults to false here — this fixture represents a GENUINE reply/
// ordinary send (an answer), not a new question. Tests exercising the P1 FIX
// below (a response that IS itself a new question) explicitly override
// needsReply: true.
function sendResponse(overrides) {
  return JSON.stringify(Object.assign({
    ok: true, action: 'send', from: 'me', to: 'child-1', type: 'direct',
    urgency: 'normal', sent: true, seq: 1, needsReply: false, toId: 'child-1',
  }, overrides || {}));
}

test('records a reply on a genuine successful direct send', () => {
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload(
      'node scripts/devswarm.js send --to child-1 --question --message "hi"',
      { stdout: sendResponse(), sessionId: 'sess-1' }
    );
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout.trim(), '', 'observe-only hook must emit no stdout on success');

    const state = readReplyState(REPO_KEY, h.home);
    assert.ok(state['child-1'], 'child-1 entry must exist');
    assert.ok(Number.isFinite(state['child-1'].lastReplyTs), 'lastReplyTs must be set');
  } finally {
    h.cleanup();
  }
});

// P1 FIX (Round 3 review): a response carrying `needsReply: true` is ITSELF a
// NEW question (e.g. the Primary sending child C "what's your status?"), not
// an answer to anything — recording it as a reply would clear C's ORIGINAL
// unanswered question without the Primary ever actually deciding/answering,
// reintroducing the starvation this feature exists to prevent.
test('P1 FIX: a send response carrying needsReply:true is NEVER recorded as a reply', () => {
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload(
      'node scripts/devswarm.js send --to child-1 --question --message "what is your status?"',
      { stdout: sendResponse({ needsReply: true }), sessionId: 'sess-needsreply' }
    );
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0, 'must exit 0');
    const state = readReplyState(REPO_KEY, h.home);
    assert.deepStrictEqual(state, {}, 'a response that is itself a new question must never be recorded as a reply');
  } finally {
    h.cleanup();
  }
});

test('ignores a non-Bash tool call', () => {
  const h = makeHome();
  try {
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x' },
      tool_response: sendResponse(),
      session_id: 'sess-2',
    };
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.deepStrictEqual(state, {}, 'no state should be recorded for a non-Bash tool');
  } finally {
    h.cleanup();
  }
});

test('ignores a child-workspace session (not Primary)', () => {
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload('node scripts/devswarm.js send --to child-1 --message "hi"', {
      stdout: sendResponse(), sessionId: 'sess-3',
    });
    const r = run(h.home, payload, CHILD_ENV);
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.deepStrictEqual(state, {}, 'a child-workspace session must not record a reply');
  } finally {
    h.cleanup();
  }
});

test('ignores a non-DevSwarm session', () => {
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload('node scripts/devswarm.js send --to child-1 --message "hi"', {
      stdout: sendResponse(), sessionId: 'sess-4',
    });
    const r = run(h.home, payload, {}); // no DEVSWARM_REPO_ID -> inactive
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.deepStrictEqual(state, {}, 'a non-DevSwarm session must not record a reply');
  } finally {
    h.cleanup();
  }
});

test('a failed send (ok:false) does NOT record a reply', () => {
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload('node scripts/devswarm.js send --to child-1 --message "hi"', {
      stdout: sendResponse({ ok: false, error: 'unregistered-recipient' }),
      sessionId: 'sess-5',
    });
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.deepStrictEqual(state, {}, 'ok:false must never record a reply');
  } finally {
    h.cleanup();
  }
});

test('a command that never invoked devswarm send, but whose stdout is shaped like a valid send response, does NOT record a reply (spoofing case)', () => {
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload('cat /tmp/fake-response.json', {
      stdout: sendResponse(), sessionId: 'sess-spoof',
    });
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.deepStrictEqual(state, {}, 'a non-send command must never record a reply, even with send-shaped stdout');
  } finally {
    h.cleanup();
  }
});

test('a genuine send with sent:false (dedupe hit) does NOT record a reply', () => {
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload('node scripts/devswarm.js send --to child-1 --question --message "hi"', {
      stdout: sendResponse({ sent: false }), sessionId: 'sess-dedupe',
    });
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.deepStrictEqual(state, {}, 'a dedupe hit (sent:false) must never record a reply');
  } finally {
    h.cleanup();
  }
});

test('a broadcast (even carrying a toId) does NOT record a reply', () => {
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload('node scripts/devswarm.js send --broadcast --message "hi"', {
      stdout: sendResponse({ type: 'broadcast', to: null, toId: 'child-1' }),
      sessionId: 'sess-6',
    });
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.deepStrictEqual(state, {}, 'a broadcast must never record a reply, even with a toId present');
  } finally {
    h.cleanup();
  }
});

test('malformed/non-JSON response content fails open: exits 0, no throw, no state written', () => {
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload('echo not json', {
      stdout: 'this is not JSON at all {{{', sessionId: 'sess-7',
    });
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0, 'must still exit 0 on malformed response');
    const state = readReplyState(REPO_KEY, h.home);
    assert.deepStrictEqual(state, {}, 'malformed response must never write state');
  } finally {
    h.cleanup();
  }
});

test('empty stdin fails open: exits 0, no throw', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  } finally {
    h.cleanup();
  }
});

// P1 FIX (Round 2 review): the anti-spoof regex used to be bound to a SINGLE
// LINE (`[^\n]*` between the two required tokens), so an ordinary multi-line
// shell invocation — a variable assignment on one line, the actual
// `... send ...` call on the next — silently failed to match, dropping a
// GENUINE reply. Fixed via two independent token tests over the FULL command
// string; this proves the fix.
test('a genuine send split across multiple lines (variable-then-invocation shell pattern) DOES get recorded as a reply', () => {
  const h = makeHome();
  try {
    const command = [
      'CLI="$HOME/.claude/plugins/anti-hall/scripts/devswarm.js"',
      'node "$CLI" send --to child-1 --question --message "do X"',
    ].join('\n');
    const payload = postToolUseBashPayload(command, { stdout: sendResponse(), sessionId: 'sess-multiline' });
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0, 'must exit 0');
    const state = readReplyState(REPO_KEY, h.home);
    assert.ok(state['child-1'], 'a multi-line devswarm send must still be recorded as a reply');
    assert.ok(Number.isFinite(state['child-1'].lastReplyTs), 'lastReplyTs must be set');
  } finally {
    h.cleanup();
  }
});

test('a genuine send where "send" precedes the devswarm token on the line still records (token order does not matter)', () => {
  const h = makeHome();
  try {
    const command = 'echo "about to send" && node scripts/devswarm.js send --to child-1 --message "hi"';
    const payload = postToolUseBashPayload(command, { stdout: sendResponse(), sessionId: 'sess-order' });
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.ok(state['child-1'], 'token order within the command must not matter');
  } finally {
    h.cleanup();
  }
});

// PER-PROJECT SCOPING (Bug 1a fix): a reply recorded while the payload carried
// ONE Claude session_id must still be visible when the SAME project is
// checked under a COMPLETELY DIFFERENT session_id — proving the reply-state
// key is the durable repoKey (derived from cwd), not the short-lived
// session_id. Both payloads share the same cwd (process.cwd(), this repo),
// so both resolve to the identical REPO_KEY.
test('BUG 1a FIX: a reply recorded under one session_id is visible under a totally different session_id for the SAME project (repoKey, not session_id, is the key)', () => {
  const h = makeHome();
  try {
    const payloadSessionA = postToolUseBashPayload(
      'node scripts/devswarm.js send --to child-1 --question --message "hi"',
      { stdout: sendResponse(), sessionId: 'session-A-completely-different' }
    );
    const r1 = run(h.home, payloadSessionA);
    assert.strictEqual(r1.status, 0);

    // Read back as if from a BRAND NEW Claude session (session-B) — same
    // project (same cwd -> same repoKey), different session_id entirely.
    const state = readReplyState(REPO_KEY, h.home);
    assert.ok(state['child-1'], 'the reply recorded under session-A must be visible via the project-scoped repoKey, independent of session_id');
  } finally {
    h.cleanup();
  }
});

// Fail-open (per task): an unresolvable repoKey (no `cwd` on the payload)
// must never crash the hook and must never record anything under a guessed
// key.
test('FAIL-OPEN: a payload with no cwd at all (unresolvable repoKey) never crashes and never records a reply', () => {
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload('node scripts/devswarm.js send --to child-1 --message "hi"', {
      stdout: sendResponse(), sessionId: 'sess-no-cwd',
    });
    delete payload.cwd;
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0, 'must exit 0, never throw, even with no cwd to resolve a repoKey from');
    const state = readReplyState(REPO_KEY, h.home);
    assert.deepStrictEqual(state, {}, 'no cwd -> no resolvable repoKey -> nothing recorded (fail-open, never guessed)');
  } finally {
    h.cleanup();
  }
});

test('never emits a blocking decision field under any circumstance', () => {
  const h = makeHome();
  try {
    const cases = [
      postToolUseBashPayload('node scripts/devswarm.js send --to child-1 --message "hi"', { stdout: sendResponse(), sessionId: 's-a' }),
      postToolUseBashPayload('node scripts/devswarm.js send --to child-1', { stdout: sendResponse({ ok: false }), sessionId: 's-b' }),
      postToolUseBashPayload('echo hi', { stdout: 'not json', sessionId: 's-c' }),
    ];
    for (const payload of cases) {
      const r = run(h.home, payload);
      assert.strictEqual(r.status, 0);
      assert.ok(!r.stdout.includes('"decision"'), `stdout must never contain "decision": ${r.stdout}`);
    }
  } finally {
    h.cleanup();
  }
});

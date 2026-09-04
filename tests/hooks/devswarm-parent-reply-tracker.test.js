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
const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const fs = require('node:fs');
const path = require('node:path');

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

// ---------------------------------------------------------------------------
// FIELD DEFECT FIX (088494cc3d3b, revised root cause, confirmed via field
// reproduction). The ORIGINAL code did `JSON.parse(text.trim())` on the
// WHOLE stdout string, which only succeeds when stdout is NOTHING but the
// send response's one JSON line. In the field, every uncredited send was
// part of a COMPOUND Bash command (heredoc write + `grep -c` sanity check +
// the actual `devswarm.js send --message-file` call), so stdout looked like
// `0\n{"ok":true,...}` — a leading unrelated line before the real JSON —
// and the whole-string parse threw, silently dropping the reply forever.
//
// MUTATION LIST (each mutant proven RED against these tests, then GREEN
// against the real fix — see the pasted transcript in the fix's PR/report):
//   M1: revert parseSendResponse to `JSON.parse(text.trim())` (the original
//       whole-string parse) -> kills "compound stdout" / "trailing junk" /
//       "CRLF" / "two JSON lines" tests below (all RED).
//   M2: make parseSendResponse keep the FIRST matching JSON line instead of
//       the LAST -> kills "two JSON lines where only the last is a send"
//       (RED: would record the wrong/earlier object's fields, or none).
//   M3: delete the `logReplyParseDrop` call on parse failure -> kills
//       "diagnostic: malformed stdout logs exactly once" (RED: log file
//       absent/empty).
//   M4: revert `if (!envActive && !hasOnDiskDevswarmState(home, repoKey))
//       return;` to `if (!envActive) return;` (drop the on-disk-evidence
//       fallback entirely) -> kills "ON-DISK FALLBACK: ... still records
//       when the repo HAS DevSwarm state on disk" (RED: nothing recorded).
//
// (An earlier draft of this list included a 4th stdout-parsing mutant —
// dropping the blank-line `continue` in parseSendResponse's scan loop. That
// mutant was verified NOT to kill any test: `JSON.parse('')` already throws
// and is caught by the existing try/catch, so skipping blank lines is a
// micro-optimization, not load-bearing for correctness. Replaced with M4
// above, which IS verified to kill a real test.)
// ---------------------------------------------------------------------------

test('FIELD FIX: compound Bash stdout (grep sanity-check line before the send JSON) still records a reply', () => {
  const h = makeHome();
  try {
    const stdout = '0\n' + sendResponse();
    const payload = postToolUseBashPayload(
      "cat > f <<'EOF'\nhi\nEOF\ngrep -c '[`$]' f; node scripts/devswarm.js send --to child-1 --question --message-file f",
      { stdout, sessionId: 'sess-compound' }
    );
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.ok(state['child-1'], 'a compound command whose stdout has a leading non-JSON line must still record the reply');
  } finally {
    h.cleanup();
  }
});

test('FIELD FIX: trailing junk after the send JSON still records a reply', () => {
  const h = makeHome();
  try {
    const stdout = sendResponse() + '\nsome trailing junk that is not JSON';
    const payload = postToolUseBashPayload('node scripts/devswarm.js send --to child-1 --question --message "hi"', {
      stdout, sessionId: 'sess-trailing',
    });
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.ok(state['child-1'], 'trailing non-JSON output after the real send line must not defeat the parse');
  } finally {
    h.cleanup();
  }
});

test('FIELD FIX: two JSON lines where only the LAST is a genuine send are recorded using the last one', () => {
  const h = makeHome();
  try {
    const firstLine = JSON.stringify({ ok: true, action: 'other-thing', note: 'not a send' });
    const stdout = firstLine + '\n' + sendResponse({ toId: 'child-2' });
    const payload = postToolUseBashPayload('node scripts/devswarm.js send --to child-2 --question --message "hi"', {
      stdout, sessionId: 'sess-two-json',
    });
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.ok(state['child-2'], 'the LAST JSON line (the real send) must be the one credited');
    assert.ok(!state['other-thing'], 'the first, non-send JSON line must never itself be treated as a reply target');
  } finally {
    h.cleanup();
  }
});

test('WAVE 9 P1 FIX: a send followed by an unrelated JSON line (e.g. `send && inbox count`) still records the reply using the send-shaped line, not the last JSON line', () => {
  const h = makeHome();
  try {
    // The exact field shape: one Bash call chains `devswarm.js send --to X`
    // then `devswarm.js inbox count X` — stdout carries the send's JSON line
    // FIRST, then the count's `{"action":"count",...}` JSON line LAST. The
    // old "last JSON-object line wins" rule picked the count line (no toId/
    // sent/needsReply fields), silently dropping the reply.
    const countLine = JSON.stringify({ ok: true, action: 'count', id: 'child-3', unread: 0 });
    const stdout = sendResponse({ toId: 'child-3' }) + '\n' + countLine;
    const payload = postToolUseBashPayload(
      'node scripts/devswarm.js send --to child-3 --question --message "hi" && node scripts/devswarm.js inbox count child-3',
      { stdout, sessionId: 'sess-send-then-count' }
    );
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.ok(state['child-3'], 'the send-shaped line must be credited even though a later, unrelated JSON line (inbox count) follows it');
  } finally {
    h.cleanup();
  }
});

test('FIELD FIX: CRLF line endings in stdout still record a reply', () => {
  const h = makeHome();
  try {
    const stdout = '0\r\n' + sendResponse() + '\r\n';
    const payload = postToolUseBashPayload('node scripts/devswarm.js send --to child-1 --question --message "hi"', {
      stdout, sessionId: 'sess-crlf',
    });
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.ok(state['child-1'], 'CRLF-delimited stdout must still parse and record the reply');
  } finally {
    h.cleanup();
  }
});

test('NEGATIVE CONTROL: stdout with NO send JSON anywhere in it never records a reply', () => {
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload('node scripts/devswarm.js send --to child-1 --message "hi"', {
      stdout: 'just some plain text output, no braces at all\nanother line',
      sessionId: 'sess-no-json-anywhere',
    });
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.deepStrictEqual(state, {}, 'stdout with no JSON object anywhere must never credit a reply');
  } finally {
    h.cleanup();
  }
});

test('DIAGNOSTIC: a send-shaped command whose stdout has no parseable JSON logs the drop exactly once to parent-inbox.log', () => {
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload('node scripts/devswarm.js send --to child-1 --message "hi"', {
      stdout: 'this is not JSON at all {{{',
      sessionId: 'sess-diagnostic',
    });
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);

    const logPath = path.join(h.home, '.devswarm', 'parent-inbox.log');
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const dropLines = lines.filter((l) => {
      try { return JSON.parse(l).event === 'reply-parse-drop'; } catch (_) { return false; }
    });
    assert.strictEqual(dropLines.length, 1, 'exactly one reply-parse-drop diagnostic line must be written');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// SECONDARY FIX (088494cc3d3b, latent path): the on-disk-evidence fallback.
// Nothing in this plugin sets DEVSWARM_REPO_ID for a Primary's own process —
// it is a per-SESSION var set externally by the DevSwarm spawn path — so a
// Primary launched any other way never gets it and the env-based fast path
// alone stays false forever. Fallback: this repo already has DevSwarm state
// on disk for its own repoKey (summaries/<repoKey>.json).
// ---------------------------------------------------------------------------

test('ON-DISK FALLBACK: a reply from a process with NO DEVSWARM_REPO_ID and no supervisor override still records when the repo HAS DevSwarm state on disk', () => {
  const h = makeHome();
  try {
    const p = store.summaryPathForHash(h.home, REPO_KEY);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ workspaces: {} }));

    const payload = postToolUseBashPayload('node scripts/devswarm.js send --to child-1 --question --message "hi"', {
      stdout: sendResponse(), sessionId: 'sess-ondisk-fallback',
    });
    const r = run(h.home, payload, {}); // no DEVSWARM_REPO_ID, no ANTIHALL_DEVSWARM_SUPERVISOR
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.ok(state['child-1'], 'on-disk DevSwarm state must be enough to arm reply recording even with no active env var');
  } finally {
    h.cleanup();
  }
});

test('ON-DISK FALLBACK negative control: a child workspace still never records, even when on-disk DevSwarm state exists', () => {
  const h = makeHome();
  try {
    const p = store.summaryPathForHash(h.home, REPO_KEY);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ workspaces: {} }));

    const payload = postToolUseBashPayload('node scripts/devswarm.js send --to child-1 --question --message "hi"', {
      stdout: sendResponse(), sessionId: 'sess-ondisk-child',
    });
    // DEVSWARM_SOURCE_BRANCH set, no DEVSWARM_REPO_ID: isChildWorkspace must
    // win regardless of the on-disk evidence tier.
    const r = run(h.home, payload, { DEVSWARM_SOURCE_BRANCH: 'some-branch' });
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.deepStrictEqual(state, {}, 'a child workspace must never write the parent reply state, on-disk evidence notwithstanding');
  } finally {
    h.cleanup();
  }
});

test('WAVE 9 EASY: an UNARMED session (no active env, no on-disk DevSwarm state) with malformed send-shaped stdout must NOT write a reply-parse-drop diagnostic line', () => {
  // logReplyParseDrop moved to AFTER the arming gate (envActive ||
  // hasOnDiskDevswarmState) — previously it ran unconditionally on any Bash
  // call that merely looked like a devswarm send, even for a stranger in a
  // repo/session with zero DevSwarm activity, polluting parent-inbox.log for
  // sessions that were never armed in the first place.
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload('node scripts/devswarm.js send --to child-1 --message "hi"', {
      stdout: 'this is not JSON at all {{{',
      sessionId: 'sess-unarmed-diagnostic',
    });
    const r = run(h.home, payload, {}); // no env, and makeHome() has NO summaries file at all -> unarmed
    assert.strictEqual(r.status, 0);

    const logPath = path.join(h.home, '.devswarm', 'parent-inbox.log');
    let dropLines = [];
    if (fs.existsSync(logPath)) {
      const raw = fs.readFileSync(logPath, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      dropLines = lines.filter((l) => {
        try { return JSON.parse(l).event === 'reply-parse-drop'; } catch (_) { return false; }
      });
    }
    assert.strictEqual(dropLines.length, 0, 'an unarmed session must never write a reply-parse-drop diagnostic line');
  } finally {
    h.cleanup();
  }
});

test('ON-DISK FALLBACK negative control: a repo with NO DevSwarm state on disk and no active env still does not record (covered above by "ignores a non-DevSwarm session", restated for this fix)', () => {
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload('node scripts/devswarm.js send --to child-1 --message "hi"', {
      stdout: sendResponse(), sessionId: 'sess-ondisk-none',
    });
    const r = run(h.home, payload, {}); // no env, and makeHome() has NO summaries file at all
    assert.strictEqual(r.status, 0);
    const state = readReplyState(REPO_KEY, h.home);
    assert.deepStrictEqual(state, {}, 'zero DevSwarm history on disk and no active env must never arm the fallback');
  } finally {
    h.cleanup();
  }
});

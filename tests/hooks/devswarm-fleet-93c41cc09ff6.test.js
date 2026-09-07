'use strict';
// Defect G / 93c41cc09ff6 (revised): hooks/devswarm-parent-reply-tracker.js's
// `resp.needsReply === true && !recipientHasPendingQuestion(...)` credited ANY
// `--question` send as a reply the instant the RECIPIENT had SOME pending
// question recorded against them — never checking whether THIS particular
// message actually answers it. A brand-new, unrelated `--question` send to a
// recipient who happens to have an older outstanding question got silently
// credited as the reply that clears it (a false positive).
//
// Fix under test: cmdSend (scripts/devswarm.js) gains an explicit `--answers`
// bare flag, echoed on its response as `answers:true`. The tracker now
// requires `resp.answers === true` before crediting a needsReply:true send,
// and logs a one-line hint (event 'reply-not-credited-missing-answers',
// naming --answers) when a question-carrying send to a recipient with a
// genuinely pending question is NOT credited for lacking it.
//
// Uses the SAME test harness conventions as
// tests/hooks/devswarm-parent-reply-tracker.test.js (testHookRaw/
// postToolUseBashPayload/makeHome) and reuses process.cwd() (this real repo
// checkout) as the payload cwd, matching that file's REPO_KEY convention.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHookRaw, postToolUseBashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const { readReplyState } = require('../../plugins/anti-hall/companion/lib/devswarm-reply-state.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const cli = require('../../plugins/anti-hall/scripts/devswarm.js');

const HOOK = 'devswarm-parent-reply-tracker.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_KEY = repokey.repoKeyForWorktree(process.cwd());

function run(home, payload, env) {
  return testHookRaw(HOOK, JSON.stringify(payload), {
    home,
    env: { ...(env !== undefined ? env : PRIMARY_ENV) },
  });
}

function sendResponse(overrides) {
  return JSON.stringify(Object.assign({
    ok: true, action: 'send', from: 'me', to: 'child-1', type: 'direct',
    urgency: 'normal', sent: true, seq: 1, needsReply: false, toId: 'child-1',
  }, overrides || {}));
}

// seedPendingQuestionFromChild1(home) — registers 'me' and 'child-1' against
// THIS real repo's worktree (process.cwd(), matching REPO_KEY/payload.cwd),
// then sends a real `--question` from child-1 to 'me' via the actual CLI so
// computeSummary's pendingQuestions machinery populates 'me' workspace's
// pendingQuestions with a genuine {from:'child-1'} entry — the exact shape
// recipientHasPendingQuestion reads. Uses the real store, not a hand-rolled
// summary.json, so this test can never drift from the real pendingQuestions
// contract.
function seedPendingQuestionFromChild1(home) {
  const cwd = process.cwd();
  const regMe = cli.run(['register', 'me', '--worktree', cwd, '--session', 'sess-me'], { home, cwd, env: {} });
  assert.strictEqual(regMe.result.ok, true, 'register me should succeed: ' + JSON.stringify(regMe.result));
  const regChild = cli.run(['register', 'child-1', '--worktree', cwd, '--session', 'sess-child-1'], { home, cwd, env: {} });
  assert.strictEqual(regChild.result.ok, true, 'register child-1 should succeed: ' + JSON.stringify(regChild.result));
  const q = cli.run(
    ['send', '--to', 'me', '--message', 'what should I do next?', '--question'],
    { home, cwd, env: { DEVSWARM_BUILDER_ID: 'child-1' } }
  );
  assert.strictEqual(q.result.ok, true, 'child-1 asking me a question should succeed: ' + JSON.stringify(q.result));
}

function readReplyStateSafe(home) {
  try { return readReplyState(REPO_KEY, home); } catch (_) { return {}; }
}

test('G case 1: a --question send WITH --answers to a recipient with a pending question IS credited', () => {
  const h = makeHome();
  try {
    seedPendingQuestionFromChild1(h.home);
    const payload = postToolUseBashPayload(
      'node scripts/devswarm.js send --to child-1 --question --answers --message "approved, also can you check Y?"',
      { stdout: sendResponse({ needsReply: true, answers: true, toId: 'child-1' }), sessionId: 'sess-answers' }
    );
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    const state = readReplyStateSafe(h.home);
    assert.ok(state['child-1'], 'a --answers send to a recipient with a pending question must be credited');
    assert.ok(Number.isFinite(state['child-1'].lastReplyTs));
  } finally { h.cleanup(); }
});

test('G case 2: a --question send WITHOUT --answers to the SAME recipient is NOT credited (and logs a --answers hint)', () => {
  const h = makeHome();
  try {
    seedPendingQuestionFromChild1(h.home);
    const payload = postToolUseBashPayload(
      'node scripts/devswarm.js send --to child-1 --question --message "unrelated new question"',
      { stdout: sendResponse({ needsReply: true, answers: false, toId: 'child-1' }), sessionId: 'sess-no-answers' }
    );
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    const state = readReplyStateSafe(h.home);
    assert.deepStrictEqual(state, {}, 'a --question send with no --answers must NOT be credited as a reply, '
      + 'even though the recipient has a pending question on file (got: ' + JSON.stringify(state) + ')');

    // The hint names --answers, on the parent-inbox JSONL log (same file
    // logReplyParseDrop already writes to).
    const logPath = path.join(h.home, '.devswarm', 'parent-inbox.log');
    let logged = false;
    try {
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      logged = lines.some((l) => l && l.event === 'reply-not-credited-missing-answers' && String(l.hint || '').includes('--answers'));
    } catch (_) { logged = false; }
    assert.ok(logged, 'a not-credited --question send to a recipient with a genuinely pending question must log a hint naming --answers');
  } finally { h.cleanup(); }
});

test('G case 3: a non-question send (needsReply:false) is credited as before, regardless of --answers', () => {
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload(
      'node scripts/devswarm.js send --to child-1 --message "just an update, no question involved"',
      { stdout: sendResponse({ needsReply: false, toId: 'child-1' }), sessionId: 'sess-plain' }
    );
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    const state = readReplyStateSafe(h.home);
    assert.ok(state['child-1'], 'a plain (non-question) send must still be credited as a reply, unaffected by the G fix');
  } finally { h.cleanup(); }
});

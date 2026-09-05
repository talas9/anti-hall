'use strict';
// devswarm-parent-reply-tracker — RECEIPT-FIRST reply crediting (Wave C2 item 4).
//
// ROOT CAUSE this closes: every reply this hook has ever credited came from
// PARSING the Bash call's stdout, so crediting depended on the SHAPE OF THE
// SHELL COMMAND rather than on the send having happened. A send whose stdout is
// redirected, swallowed by a wrapper, or otherwise unparseable credited NOTHING,
// and the sender's question then stayed "unanswered" forever with no signal.
//
// scripts/devswarm.js's cmdSend now writes
// ~/.anti-hall/devswarm/send-receipts/<YYYY-MM-DD>/<hash>.json at the moment it
// appends the row, and this hook consults those FIRST.
//
// The RED half of every test below is real, not narrated: each one supplies
// stdout that the parser provably cannot turn into a send response (garbage, or
// nothing at all), so the ONLY path that can credit the reply is the receipt.
//
// A SEPARATE FILE from tests/hooks/devswarm-parent-reply-tracker.test.js — that
// file is owned by another worker in this wave and is not touched here.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHookRaw, postToolUseBashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const { readReplyState } = require('../../plugins/anti-hall/companion/lib/devswarm-reply-state.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const HOOK = 'devswarm-parent-reply-tracker.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' }; // active + Primary (no SOURCE_BRANCH)
const REPO_KEY = repokey.repoKeyForWorktree(process.cwd());

// STDOUT THE PARSER PROVABLY CANNOT USE. Line-by-line JSON scanning is what the
// stdout path does (parseSendResponse), so a body with no JSON object anywhere
// leaves it with nothing — the receipt is then the only possible source.
const UNPARSEABLE_STDOUT = 'sending...\nrc=0\n';

const SEND_COMMAND = 'node scripts/devswarm.js send --to child-1 --message "here is your answer" > /dev/null';

function run(home, payload, env) {
  return testHookRaw(HOOK, JSON.stringify(payload), { home, env: { ...(env || PRIMARY_ENV) } });
}

function receiptDir(home, ts) {
  const day = new Date(ts).toISOString().slice(0, 10);
  return path.join(home, '.anti-hall', 'devswarm', 'send-receipts', day);
}

function writeReceipt(home, receipt, ts) {
  const at = Number.isFinite(ts) ? ts : Date.now();
  const dir = receiptDir(home, at);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, (receipt.hash || 'nohash').replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
  fs.writeFileSync(file, JSON.stringify(Object.assign({ ts: at }, receipt)) + '\n');
  return file;
}

// The shape cmdSend writes for an ordinary (non-question) direct send.
function goodReceipt(over) {
  return Object.assign({
    from: 'primary-a', to: 'child-1', toId: 'child-1', type: 'direct',
    urgency: 'normal', hash: 'mesh:aaa111', bytes: 12, ok: true, sent: true,
    needsReply: false, verified: true,
  }, over || {});
}

// ---------------------------------------------------------------------------
// RED -> GREEN
// ---------------------------------------------------------------------------

test('RED: with stdout the parser cannot use and NO receipt, nothing is credited', () => {
  const h = makeHome();
  try {
    const payload = postToolUseBashPayload(SEND_COMMAND, { stdout: UNPARSEABLE_STDOUT, sessionId: 'sess-red' });
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0, 'must exit 0 (observe-only)');
    const state = readReplyState(REPO_KEY, h.home);
    assert.ok(!state['child-1'],
      'this is the FIELD FAILURE: a real send whose stdout is unparseable credits nothing at all');
  } finally { h.cleanup(); }
});

test('GREEN: the SAME unparseable stdout credits the reply once a receipt exists', () => {
  const h = makeHome();
  try {
    writeReceipt(h.home, goodReceipt());
    const payload = postToolUseBashPayload(SEND_COMMAND, { stdout: UNPARSEABLE_STDOUT, sessionId: 'sess-green' });
    const r = run(h.home, payload);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '', 'still observe-only: no stdout, ever');
    const state = readReplyState(REPO_KEY, h.home);
    assert.ok(state['child-1'], 'THE FIX: the send\'s own on-disk evidence credits the reply');
    assert.ok(Number.isFinite(state['child-1'].lastReplyTs));
  } finally { h.cleanup(); }
});

test('GREEN: an EMPTY stdout (fully redirected send) is credited from the receipt', () => {
  const h = makeHome();
  try {
    writeReceipt(h.home, goodReceipt({ toId: 'child-2' }));
    const payload = postToolUseBashPayload(SEND_COMMAND, { stdout: '', sessionId: 'sess-empty' });
    assert.strictEqual(run(h.home, payload).status, 0);
    assert.ok(readReplyState(REPO_KEY, h.home)['child-2'],
      'empty stdout used to be an unconditional early return — the receipt path must still reach the credit');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// The receipt path applies the SAME acceptance rules as the stdout path.
// ---------------------------------------------------------------------------

test('a receipt for a --question send is NEVER credited (it is a new question, not an answer)', () => {
  const h = makeHome();
  try {
    writeReceipt(h.home, goodReceipt({ needsReply: true, hash: 'mesh:q1' }));
    assert.strictEqual(run(h.home, postToolUseBashPayload(SEND_COMMAND, { stdout: UNPARSEABLE_STDOUT })).status, 0);
    assert.ok(!readReplyState(REPO_KEY, h.home)['child-1'],
      'crediting a question would clear the other side\'s pending question with nobody having answered it');
  } finally { h.cleanup(); }
});

test('a receipt that is failed / broadcast / a dedupe hit / missing a toId is never credited', () => {
  const cases = [
    ['ok:false', { ok: false, hash: 'mesh:c1' }],
    ['broadcast', { type: 'broadcast', hash: 'mesh:c2' }],
    ['dedupe hit', { sent: false, hash: 'mesh:c3' }],
    ['no toId', { toId: null, hash: 'mesh:c4' }],
    ['empty toId', { toId: '', hash: 'mesh:c5' }],
  ];
  for (const [label, over] of cases) {
    const h = makeHome();
    try {
      writeReceipt(h.home, goodReceipt(over));
      assert.strictEqual(run(h.home, postToolUseBashPayload(SEND_COMMAND, { stdout: UNPARSEABLE_STDOUT })).status, 0);
      assert.ok(!readReplyState(REPO_KEY, h.home)['child-1'], label + ' must not be credited as a reply');
    } finally { h.cleanup(); }
  }
});

// ---------------------------------------------------------------------------
// Windowing, robustness, and scoping.
// ---------------------------------------------------------------------------

test('a receipt OUTSIDE this turn\'s window is not credited', () => {
  const h = makeHome();
  try {
    const old = Date.now() - 60 * 60 * 1000; // an hour ago, far past the 5-minute default
    const file = writeReceipt(h.home, goodReceipt({ hash: 'mesh:old' }), old);
    const t = new Date(old);
    fs.utimesSync(file, t, t); // the window is keyed on mtime
    assert.strictEqual(run(h.home, postToolUseBashPayload(SEND_COMMAND, { stdout: UNPARSEABLE_STDOUT })).status, 0);
    assert.ok(!readReplyState(REPO_KEY, h.home)['child-1'],
      'an old receipt from an earlier turn must never be re-credited as if it happened now');
  } finally { h.cleanup(); }
});

test('the window is env-tunable, so an out-of-window receipt CAN be credited when the caller widens it', () => {
  const h = makeHome();
  try {
    const old = Date.now() - 60 * 60 * 1000;
    const file = writeReceipt(h.home, goodReceipt({ hash: 'mesh:widened' }), old);
    const t = new Date(old);
    fs.utimesSync(file, t, t);
    const r = run(h.home, postToolUseBashPayload(SEND_COMMAND, { stdout: UNPARSEABLE_STDOUT }),
      Object.assign({}, PRIMARY_ENV, { ANTIHALL_DEVSWARM_RECEIPT_WINDOW_MS: String(4 * 60 * 60 * 1000) }));
    assert.strictEqual(r.status, 0);
    assert.ok(readReplyState(REPO_KEY, h.home)['child-1'],
      'proves the previous test failed on the WINDOW and not on some unrelated rejection');
  } finally { h.cleanup(); }
});

test('a corrupt receipt never stops the sweep, and never crashes the hook', () => {
  const h = makeHome();
  try {
    const dir = receiptDir(h.home, Date.now());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(dir, 'ignored.txt'), JSON.stringify(goodReceipt()));
    writeReceipt(h.home, goodReceipt({ toId: 'child-9', hash: 'mesh:ok9' }));
    const r = run(h.home, postToolUseBashPayload(SEND_COMMAND, { stdout: UNPARSEABLE_STDOUT }));
    assert.strictEqual(r.status, 0, 'fail-open: a bad receipt must never break the session');
    assert.ok(readReplyState(REPO_KEY, h.home)['child-9'], 'the good receipt is still credited');
  } finally { h.cleanup(); }
});

test('receipts are only consulted for a command that plausibly IS a devswarm send', () => {
  const h = makeHome();
  try {
    writeReceipt(h.home, goodReceipt());
    const r = run(h.home, postToolUseBashPayload('ls -la', { stdout: UNPARSEABLE_STDOUT }));
    assert.strictEqual(r.status, 0);
    assert.ok(!readReplyState(REPO_KEY, h.home)['child-1'],
      'the anti-spoof command gate still runs first — an unrelated Bash call credits nothing');
  } finally { h.cleanup(); }
});

test('a CHILD workspace never writes the parent\'s reply state, receipts present or not', () => {
  const h = makeHome();
  try {
    writeReceipt(h.home, goodReceipt());
    const r = run(h.home, postToolUseBashPayload(SEND_COMMAND, { stdout: UNPARSEABLE_STDOUT }),
      { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'some-branch' });
    assert.strictEqual(r.status, 0);
    assert.ok(!readReplyState(REPO_KEY, h.home)['child-1'],
      'the child guard runs first and is not weakened by the new path');
  } finally { h.cleanup(); }
});

test('the stdout path still works when there is no receipt at all (the fallback is intact)', () => {
  const h = makeHome();
  try {
    const stdout = JSON.stringify({
      ok: true, action: 'send', from: 'me', to: 'child-1', type: 'direct',
      urgency: 'normal', sent: true, seq: 1, needsReply: false, toId: 'child-1',
    });
    assert.strictEqual(run(h.home, postToolUseBashPayload(SEND_COMMAND, { stdout })).status, 0);
    assert.ok(readReplyState(REPO_KEY, h.home)['child-1'],
      'a CLI build that predates receipts must still credit replies exactly as before');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// ROUND 13 P1 — PER-PROJECT SCOPING + A TIMESTAMP LOWER BOUND
//
// Receipts live in ONE home-scoped directory shared by every project on the
// machine; reply-state is PER PROJECT. Pre-fix the tracker credited EVERY
// receipt in that directory to whatever repoKey the CURRENT payload resolved
// to — so a send in project A silently cleared a pending question in project B.
// cmdSend now stamps `repoKey` on the receipt and this check enforces it.
// ---------------------------------------------------------------------------

test('R13 P1: a receipt from ANOTHER project is NOT credited to this project', () => {
  const h = makeHome();
  try {
    writeReceipt(h.home, goodReceipt({ hash: 'mesh:foreign', repoKey: 'some-other-project-key' }));
    const payload = postToolUseBashPayload(SEND_COMMAND, { stdout: UNPARSEABLE_STDOUT, sessionId: 'sess-foreign' });
    assert.strictEqual(run(h.home, payload).status, 0);
    assert.ok(!readReplyState(REPO_KEY, h.home)['child-1'],
      'THE FIX: a send in project A must never clear a pending question in project B');
  } finally { h.cleanup(); }
});

test('R13 P1: a receipt carrying THIS project\'s repoKey is credited (proves the previous test failed on scoping)', () => {
  const h = makeHome();
  try {
    writeReceipt(h.home, goodReceipt({ hash: 'mesh:mine', repoKey: REPO_KEY }));
    const payload = postToolUseBashPayload(SEND_COMMAND, { stdout: UNPARSEABLE_STDOUT, sessionId: 'sess-mine' });
    assert.strictEqual(run(h.home, payload).status, 0);
    assert.ok(readReplyState(REPO_KEY, h.home)['child-1'], 'a matching repoKey still credits normally');
  } finally { h.cleanup(); }
});

test('R13 P1: a LEGACY receipt with no repoKey at all is still credited (no post-upgrade starvation)', () => {
  const h = makeHome();
  try {
    // goodReceipt() carries no repoKey — exactly the pre-v0.90.1 shape.
    writeReceipt(h.home, goodReceipt({ hash: 'mesh:legacy' }));
    assert.strictEqual(run(h.home, postToolUseBashPayload(SEND_COMMAND, { stdout: UNPARSEABLE_STDOUT })).status, 0);
    assert.ok(readReplyState(REPO_KEY, h.home)['child-1'],
      'refusing legacy receipts would disable the whole receipt path for the 7-day retention window after an upgrade');
  } finally { h.cleanup(); }
});

test('R13 P1: a receipt whose mtime is FAR in the future (a unit mismatch) is refused', () => {
  const h = makeHome();
  try {
    // `payload.timestamp` is read as MILLISECONDS (matching limit-conserve.js's
    // own `parsed.timestamp` vs Date.now() comparison). If a caller ever fed a
    // SECONDS value, every receipt would look ~55 years in the future and the
    // upper-bound-only window would have credited all of them. The lower bound
    // is what catches that; ordinary sub-minute clock skew is still tolerated.
    const future = Date.now() + 10 * 60 * 1000; // 10 minutes ahead: far past the 60s skew tolerance
    const file = writeReceipt(h.home, goodReceipt({ hash: 'mesh:future' }));
    const t = new Date(future);
    fs.utimesSync(file, t, t);
    assert.strictEqual(run(h.home, postToolUseBashPayload(SEND_COMMAND, { stdout: UNPARSEABLE_STDOUT })).status, 0);
    assert.ok(!readReplyState(REPO_KEY, h.home)['child-1'],
      'THE FIX: a receipt with a negative age beyond the skew tolerance is not evidence about this turn');
  } finally { h.cleanup(); }
});

test('R13 P1: ordinary sub-minute clock skew is still tolerated', () => {
  const h = makeHome();
  try {
    const slightlyAhead = Date.now() + 5 * 1000;
    const file = writeReceipt(h.home, goodReceipt({ hash: 'mesh:skew' }));
    const t = new Date(slightlyAhead);
    fs.utimesSync(file, t, t);
    assert.strictEqual(run(h.home, postToolUseBashPayload(SEND_COMMAND, { stdout: UNPARSEABLE_STDOUT })).status, 0);
    assert.ok(readReplyState(REPO_KEY, h.home)['child-1'],
      'a 5-second skew is filesystem/clock noise, not a unit mismatch — it must still credit');
  } finally { h.cleanup(); }
});

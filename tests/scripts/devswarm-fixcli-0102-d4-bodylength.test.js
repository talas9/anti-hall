'use strict';
// D4 (fix-cli-0102) — `inbox read-primary`'s ack is content-blind to anything
// that happens to the JSON payload AFTER it leaves the CLI's stdout.
//
// VERIFIED SCOPE (narrower than first reported — NOT data loss): nothing in
// send/store/read truncates message BODIES anywhere in this file (every cap is
// a ROW-count cap, never a byte cap), and acked mail is still re-servable via
// `inbox messages <id>` (full history, read-only — never cursor-scoped). The
// real gap: read-primary emits AND acks in the same call (`ackTarget =
// ackAnchor + physicalConsumed`), so if a consumer DOWNSTREAM of this CLI's
// stdout clips bytes (a tool-output limit, a hook renderer, `tail -c`), the
// cursor has already moved and the caller has no way to tell from the
// (possibly clipped) output alone.
//
// FIX (scripts/devswarm.js, cmdInboxMessagesInner): additive-only.
//   - per-row `bodyLength` (UTF-8 byte length of `body`) on every message this
//     verb returns.
//   - payload-level `totalBodyBytes` (sum of every row's bodyLength).
//   - `truncatedBodyHint`, always present, naming the recovery path: already-
//     acked mail is still re-readable via `inbox messages <id>` (full store
//     history for that partition — cmdInboxMessagesInner's plain `messages`
//     sub never scopes to the cursor, byte-identical to its pre-fix contract).
// A clipped consumer can compare the bytes it actually received against
// `totalBodyBytes`/the last row's `bodyLength` and detect the clip itself.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fixcli0102-d4-home-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixcli0102-d4-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function addLinkedWorktree(mainDir, tag) {
  const wt = path.join(path.dirname(mainDir), path.basename(mainDir) + '-wt-' + tag);
  cp.spawnSync('git', ['-C', mainDir, 'worktree', 'add', wt, '-b', 'branch-' + tag]);
  return wt;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

test('D4: read-primary emits a correct per-row bodyLength (UTF-8 bytes) and a matching payload-level totalBodyBytes, for a multi-row read with multi-byte content; acked mail stays recoverable', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('d4-bodylen');
  let childWt = null;
  try {
    childWt = addLinkedWorktree(mainRepo, 'd4');
    const id = 'child-d4';
    const inboxPath = path.join(home, 'di', id + '.ndjson');
    const cursorPath = path.join(home, 'dc', id + '.cursor');
    const rReg = cli.run(['register', id, '--worktree', childWt, '--session', 's-' + id,
      '--inbox', inboxPath, '--cursor', cursorPath], ctx(home, { cwd: childWt }));
    assert.ok(rReg.result.ok, 'register failed: ' + JSON.stringify(rReg.result));

    // Bodies deliberately include multi-byte UTF-8 content (an em dash is 3
    // UTF-8 bytes but 1 UTF-16 code unit — the exact ambiguity defect
    // 0960924d28be already hit once for `send`'s own `bytes` field) so a naive
    // `.length` (code units) would silently under-report.
    const bodies = ['ascii only', 'em dash — here', 'ééé café'];
    for (const b of bodies) {
      const rSend = cli.run(['send', '--to', id, '--message', b], ctx(home, { cwd: mainRepo }));
      assert.ok(rSend.result.ok, 'send failed: ' + JSON.stringify(rSend.result));
    }

    const r = cli.run(['inbox', 'read-primary', id], ctx(home, { cwd: childWt })).result;
    assert.equal((r.messages || []).length, 3, 'must deliver all 3 rows: ' + JSON.stringify(r));

    r.messages.forEach((m, i) => {
      const expected = bodies.indexOf(m.body);
      assert.notEqual(expected, -1, 'row body must be one of the seeded bodies: ' + JSON.stringify(m));
      assert.equal(m.bodyLength, Buffer.byteLength(m.body, 'utf8'),
        'row ' + i + ' bodyLength must be the UTF-8 byte length of its own body, not code units');
    });
    // At least one row must carry a multi-byte body whose bodyLength differs
    // from its UTF-16 `.length` — otherwise this test could pass even with a
    // UTF-16-code-unit bug (defect 0960924d28be's exact shape).
    const multiByteRow = r.messages.find((m) => m.bodyLength !== m.body.length);
    assert.ok(multiByteRow, 'at least one seeded body must be multi-byte: ' + JSON.stringify(r.messages));

    const expectedTotal = bodies.reduce((a, b) => a + Buffer.byteLength(b, 'utf8'), 0);
    assert.equal(r.totalBodyBytes, expectedTotal,
      'totalBodyBytes must be the sum of every row\'s bodyLength, matching the byte count a downstream '
      + 'consumer could independently verify against');
    assert.ok(typeof r.truncatedBodyHint === 'string' && r.truncatedBodyHint.indexOf('inbox messages ' + id) !== -1,
      'truncatedBodyHint must name the recovery path (already-acked mail stays re-readable): ' + JSON.stringify(r.truncatedBodyHint));

    // The recovery path itself: after this ack, the same rows are still
    // re-readable (full history, read-only — never cursor-scoped) via
    // `inbox messages <id>`, exactly as truncatedBodyHint claims.
    const rAfter = cli.run(['inbox', 'messages', id], ctx(home, { cwd: childWt })).result;
    const afterBodies = (rAfter.messages || []).map((m) => m.body).sort();
    assert.deepEqual(afterBodies, bodies.slice().sort(),
      'already-acked mail must remain re-servable via `inbox messages <id>` — the ack never deletes anything');
  } finally {
    rm(home);
    if (childWt) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', childWt]);
    rm(mainRepo);
  }
});

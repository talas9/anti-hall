'use strict';
// D1 (fix-cli-0102) — ndjson cursor NAMESPACE SPLIT between `inbox count/read/
// ack/tick` and `inbox read-primary`/`peek-primary` (cmdInboxMessagesInner).
//
// ROOT CAUSE (verified against scripts/devswarm.js before this fix):
//   - `inbox count`/`read`/`ack`/`tick` resolve the ndjson cursor through
//     `resolveNdCursorPath(home, id, callerInstanceShort, descCursorPath)` ->
//     `cursors/<id>#nd-<short6>.json`, a PER-INSTANCE file seeded ONCE from the
//     descriptor's cursor at first creation.
//   - `inbox read-primary` (cmdInboxMessagesInner) instead read AND acked the
//     RAW descriptor path (`desc.cursorPath`) directly, never going through
//     `resolveNdCursorPath` and never calling `projectNdDescriptorCursor`.
//   => whichever per-instance file `tick`/`count` created first was NEVER
//      touched by a `read-primary` ack, so it stayed at its seeded value
//      forever — a PERMANENT phantom-unread `tick` could never clear, even
//      after `read-primary` reported (and acked) every message.
//
// VACUITY CHECK (recorded, not re-asserted here): the repro below, run against
// a scratch copy of `git show HEAD:plugins/anti-hall/scripts/devswarm.js` (the
// pre-fix code — this fix's own edits are uncommitted working-tree changes, so
// HEAD is genuinely pre-fix), printed:
//   REPRO:CONFIRMED unreadTotal=3 (phantom unread persists after ack)
// The identical repro against the fixed working tree printed unreadTotal=0.
// This proves the test below is not vacuous — it fails on the code this fix
// changes and passes on the fix.
//
// FIX (scripts/devswarm.js, cmdInboxMessagesInner): route read-primary's
// ndjson union read AND its post-ack write through the SAME
// resolveNdCursorPath the count/read/ack/tick family already uses, then call
// projectNdDescriptorCursor afterward so the descriptor still gets the MIN
// projection across instances — preserving the invariant that keeps a slower
// SIBLING instance from losing mail.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const inboxCursor = require('../../plugins/anti-hall/companion/lib/devswarm-inbox-cursor.js');
const liveness = require('../../plugins/anti-hall/companion/lib/liveness.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fixcli0102-d1-home-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixcli0102-d1-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function seedNdjson(inboxPath, n, prefix) {
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  for (let i = 0; i < n; i++) {
    fs.appendFileSync(inboxPath, JSON.stringify({
      _h: 'mesh:' + prefix + '-' + i, fromBranch: null, message: prefix + '-' + i, createdAt: 1000 + i, status: null,
    }) + '\n');
  }
}

test('D1: after read-primary acks, `inbox tick` on the SAME id agrees (no phantom unread)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('d1-agree');
  try {
    const id = 'target-row';
    const inboxPath = path.join(home, 'di', id + '.ndjson');
    const cursorPath = path.join(home, 'dc', id + '.cursor');
    const rReg = cli.run(['register', id, '--worktree', repo, '--session', 's-' + id,
      '--inbox', inboxPath, '--cursor', cursorPath], ctx(home, { cwd: repo }));
    assert.ok(rReg.result.ok, 'register failed: ' + JSON.stringify(rReg.result));
    seedNdjson(inboxPath, 3, 'msg');

    // `tick` FIRST — this is what seeds the per-instance ndjson cursor file
    // (resolveNdCursorPath) at the descriptor's then-current (0) value. This
    // ordering is exactly what reproduces the namespace split: read-primary's
    // ack must reach the SAME file this call already created.
    const t0 = cli.run(['inbox', 'tick', id], ctx(home, { cwd: repo })).result;
    assert.equal(t0.unreadTotal, 3, 'precondition: 3 unread before any ack');

    const rRead = cli.run(['inbox', 'read-primary', id], ctx(home, { cwd: repo })).result;
    assert.equal((rRead.messages || []).length, 3, 'read-primary must deliver all 3');
    assert.equal(rRead.messages.map((m) => m.body).sort().join(','), 'msg-0,msg-1,msg-2');

    const t1 = cli.run(['inbox', 'tick', id], ctx(home, { cwd: repo })).result;
    assert.equal(t1.unreadTotal, 0,
      'THE FIX: tick must agree with read-primary\'s own ack — pre-fix this stayed 3 forever '
      + '(the phantom-unread wake loop), got ' + JSON.stringify(t1.unreadTotal));

    // `inbox count` (the other member of the count/read/ack/tick family) must
    // also agree, proving this is not tick-specific.
    const c1 = cli.run(['inbox', 'count', id], ctx(home, { cwd: repo })).result;
    assert.equal(c1.unreadTotal, 0);

    // A second read-primary call must not re-deliver anything already acked.
    const rRead2 = cli.run(['inbox', 'read-primary', id], ctx(home, { cwd: repo })).result;
    assert.equal((rRead2.messages || []).length, 0, 'an already-acked message must not reappear');
  } finally { rm(home); rm(repo); }
});

test('D1: the descriptor cursor still receives the MIN projection after a read-primary ack (sibling invariant preserved)', () => {
  // projectNdDescriptorCursor's whole point is that the DESCRIPTOR cursor
  // (every OTHER consumer of desc.cursorPath, and a slower sibling instance
  // reading through it) only ever advances to the MIN across per-instance
  // files, never to this one caller's own position. This proves read-primary's
  // ack still respects that after being routed through the resolved path.
  const home = tmpHome();
  const repo = makeGitRepo('d1-min');
  try {
    const id = 'target-row-2';
    const inboxPath = path.join(home, 'di', id + '.ndjson');
    const cursorPath = path.join(home, 'dc', id + '.cursor');
    const rReg = cli.run(['register', id, '--worktree', repo, '--session', 's-' + id,
      '--inbox', inboxPath, '--cursor', cursorPath], ctx(home, { cwd: repo }));
    assert.ok(rReg.result.ok, 'register failed: ' + JSON.stringify(rReg.result));
    seedNdjson(inboxPath, 5, 'm');

    // A SECOND (slower) instance's per-instance cursor file, seeded at 0 and
    // left there — simulating a sibling process that has not caught up yet.
    // Naming/location must match ndInstanceCursorPath exactly: <devswarmRoot>/
    // cursors/<id>#nd-<6-hex-char nonce>.json (listNdInstanceCursors only picks
    // up files matching that shape).
    const slowerInstancePath = path.join(liveness.devswarmRoot(home), 'cursors', id + '#nd-abcdef.json');
    fs.mkdirSync(path.dirname(slowerInstancePath), { recursive: true });
    inboxCursor.ackTo(slowerInstancePath, 0);

    // This caller's read-primary acks all 5 through its OWN per-instance file.
    const rRead = cli.run(['inbox', 'read-primary', id], ctx(home, { cwd: repo })).result;
    assert.equal((rRead.messages || []).length, 5);

    // The descriptor cursor must NOT jump to 5 (this caller's position) — it
    // must stay at the MIN across instances, which the still-0 slower sibling
    // file holds at 0. A caller-position jump would let a DIFFERENT consumer
    // of the raw descriptor (or the slower sibling, if it were ever re-pointed
    // at the descriptor) silently skip mail it has not actually seen yet.
    const descCursor = inboxCursor.readCursor(cursorPath);
    assert.equal(descCursor, 0,
      'THE FIX must preserve MIN semantics: the descriptor cursor stays at the slower sibling\'s '
      + 'position (0), not jump to this caller\'s own (5) — got ' + descCursor);
  } finally { rm(home); rm(repo); }
});

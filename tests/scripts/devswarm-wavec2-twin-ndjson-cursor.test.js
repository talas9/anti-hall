'use strict';
// Wave C2 — item 7. TWIN NDJSON CURSOR (defect 56ba248504d0).
//
// FIELD REPORT: "`inbox read <id>` on a same-worktree twin row never advances
// its NDJSON cursor: re-delivers the head row on every call (401 rows
// unreachable)" — ten consecutive `inbox read <twinId>` calls, `unreadNdjson`
// still 401 afterwards, concluding the twin's NDJSON rows are "unreachable by
// every read path".
//
// WHAT THE CODE AND THESE TESTS ACTUALLY SHOW — two halves, and they differ:
//
//   CONFIRMED: `inbox read` advances NO cursor. That is DELIBERATE, not a bug.
//   `read` is the read-only half of the count/read/ack family; `ack` is the
//   mutating half. That split is what lets `read` be safe to run from ANY
//   project — the ack path refuses a cross-project call and its own refusal
//   text says "`inbox read <id>` is read-only and works from anywhere".
//   Making `read` ack would silently consume another project's mail.
//
//   DISPROVEN: "unreachable by every read path". The twin's durable NDJSON
//   channel IS reachable and IS drainable — `inbox ack <twinId>` advances that
//   row's own descriptor cursor and the next read correctly returns zero. The
//   full N-delivered -> cursor-advanced -> 0 drain loop is asserted below.
//
// SO THE REAL DEFECT IS THE SILENCE, and that is what is fixed: `read` never
// said it had advanced nothing, and never named the command that would. An
// operator watching `unreadNdjson` sit at 401 across ten reads had no way to
// see that one `inbox ack` would drain it. `read` now reports
// `cursorAdvanced: false` plus an `ackHint` naming the exact command, and
// naming the read-primary scoping rule that makes a TWIN's channel need an
// explicit per-id ack in the first place.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DEVSWARM_PATH = path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js');
const cli = require(DEVSWARM_PATH);

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wavec2-twin-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wavec2-twinrepo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

// A same-worktree UUID TWIN of the caller: a second registry row whose
// worktreePath is byte-identical to the caller's, which is what makes the two
// an identity family in the first place.
const TWIN_ID = '11111111-2222-3333-4444-555555555555';
const CALLER_ID = 'primary-caller';

function register(home, repoDir, id) {
  const inboxPath = path.join(home, 'ib', id + '.ndjson');
  const cursorPath = path.join(home, 'cu', id + '.cursor');
  const r = cli.run(['register', id, '--worktree', repoDir, '--session', 's-' + id,
    '--inbox', inboxPath, '--cursor', cursorPath], ctx(home, { cwd: repoDir }));
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  return { inboxPath, cursorPath };
}

// N durable-NDJSON rows in `id`'s own descriptor inbox, cursor at 0.
function seedNdjson(paths, n) {
  fs.mkdirSync(path.dirname(paths.inboxPath), { recursive: true });
  fs.writeFileSync(paths.inboxPath, Array.from({ length: n },
    (_, i) => JSON.stringify({ _h: 'native:t' + i, message: 'twin-msg-' + i, createdAt: 1000 + i })).join('\n') + '\n');
  fs.mkdirSync(path.dirname(paths.cursorPath), { recursive: true });
  fs.writeFileSync(paths.cursorPath, '0');
}
const readCursorFile = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return 'ABSENT'; } };

// ---------------------------------------------------------------------------
// THE DRAIN LOOP — the loss-free version of the run the field report made.
// ---------------------------------------------------------------------------

test('item 7: a twin\'s NDJSON rows ARE reachable and drainable — read delivers N, ack advances, next read 0', () => {
  const home = tmpHome();
  const repo = makeGitRepo('drain');
  try {
    register(home, repo, CALLER_ID);
    const twin = register(home, repo, TWIN_ID);
    const N = 5;
    seedNdjson(twin, N);

    const r1 = cli.run(['inbox', 'read', TWIN_ID], ctx(home, { cwd: repo })).result;
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r1.lines.length, N, 'ALL N unread NDJSON rows are delivered — not one, and not the head row alone');
    assert.equal(r1.unreadNdjson, N);

    const a = cli.run(['inbox', 'ack', TWIN_ID], ctx(home, { cwd: repo })).result;
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.cursor, N, 'THE ACK ADVANCES THE TWIN\'S OWN DESCRIPTOR NDJSON CURSOR');
    assert.equal(readCursorFile(twin.cursorPath), String(N), 'and it is persisted to that row\'s own cursorPath');

    const r2 = cli.run(['inbox', 'read', TWIN_ID], ctx(home, { cwd: repo })).result;
    assert.equal(r2.lines.length, 0, 'the second read returns ZERO — the channel really did drain');
    assert.equal(r2.unreadNdjson, 0);
  } finally { rm(home); rm(repo); }
});

test('item 7: repeated reads are non-destructive and idempotent — same rows, cursor untouched (this is BY DESIGN)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('repeat');
  try {
    register(home, repo, CALLER_ID);
    const twin = register(home, repo, TWIN_ID);
    seedNdjson(twin, 4);
    let last = null;
    for (let i = 0; i < 10; i++) { // the field report's ten consecutive calls
      const r = cli.run(['inbox', 'read', TWIN_ID], ctx(home, { cwd: repo })).result;
      assert.equal(r.lines.length, 4, 'every call delivers the FULL unread slice');
      assert.equal(r.unreadNdjson, 4, 'and unreadNdjson stays pinned — the observation behind the report');
      if (last) assert.deepEqual(r.lines, last, 'byte-identical across calls: read is pure');
      last = r.lines;
    }
    assert.equal(readCursorFile(twin.cursorPath), '0',
      'ten reads move NO cursor — `read` is the read-only half of the family, `ack` is the mutating half');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// THE FIX — read now SAYS it advanced nothing, and names the command that will.
// ---------------------------------------------------------------------------

test('item 7 FIX: a read with outstanding rows reports cursorAdvanced:false and an ackHint naming the exact command', () => {
  const home = tmpHome();
  const repo = makeGitRepo('hint');
  try {
    register(home, repo, CALLER_ID);
    const twin = register(home, repo, TWIN_ID);
    seedNdjson(twin, 7);

    const r = cli.run(['inbox', 'read', TWIN_ID], ctx(home, { cwd: repo })).result;
    assert.equal(r.cursorAdvanced, false, 'the read states plainly that it advanced no cursor');
    assert.ok(typeof r.ackHint === 'string' && r.ackHint, 'and carries a hint');
    assert.match(r.ackHint, new RegExp('inbox ack ' + TWIN_ID),
      'THE FIX: the hint names the EXACT command that drains this row — the thing the operator could not find');
    assert.match(r.ackHint, /READ-ONLY/, 'and says why nothing moved');
    assert.match(r.ackHint, /7 unread row\(s\)/, 'and how much is outstanding');
    assert.match(r.ackHint, /read-primary/,
      'and names the read-primary scoping rule that makes a TWIN need an explicit per-id ack');
  } finally { rm(home); rm(repo); }
});

test('item 7 FIX: a fully drained read keeps its previous shape — no hint, no cursorAdvanced field', () => {
  const home = tmpHome();
  const repo = makeGitRepo('drained');
  try {
    register(home, repo, CALLER_ID);
    const twin = register(home, repo, TWIN_ID);
    seedNdjson(twin, 2);
    cli.run(['inbox', 'ack', TWIN_ID], ctx(home, { cwd: repo }));

    const r = cli.run(['inbox', 'read', TWIN_ID], ctx(home, { cwd: repo })).result;
    assert.equal(r.unreadTotal, 0, 'precondition: nothing outstanding');
    assert.equal(r.cursorAdvanced, undefined, 'the field is present ONLY when something is outstanding');
    assert.equal(r.ackHint, undefined, 'so an already-drained read is byte-compatible with every existing parser');
  } finally { rm(home); rm(repo); }
});

test('item 7 MUTATION: dropping the hint block restores the silence the field report is made of', () => {
  const src = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  // Pin the guard that makes the hint conditional AND the command it names. If
  // either is edited away, this test fails rather than the silence returning
  // unnoticed.
  assert.ok(src.includes('cursorAdvanced: false,'),
    'the read path must state that it advanced no cursor');
  assert.ok(src.includes("+ '` consumes them. NOTE: a Primary\\'s own `inbox read-primary` folds ONLY its OWN '"),
    'the hint must keep naming the read-primary scoping rule');
  const hintCount = (src.match(/ackHint:/g) || []).length;
  assert.equal(hintCount, 1, 'exactly one ackHint site — a second copy would be a drifting duplicate');
});

// ---------------------------------------------------------------------------
// THE SCOPING RULE the hint documents — asserted, not just described.
// ---------------------------------------------------------------------------

test('item 7: read-primary folds ONLY the caller\'s own descriptor NDJSON channel, never a twin\'s', () => {
  const home = tmpHome();
  const repo = makeGitRepo('scope');
  try {
    const caller = register(home, repo, CALLER_ID);
    const twin = register(home, repo, TWIN_ID);
    seedNdjson(twin, 6);   // ONLY the twin has durable NDJSON mail
    seedNdjson(caller, 0); // the caller's own channel is empty
    fs.writeFileSync(caller.inboxPath, '');

    const r = cli.run(['inbox', 'read-primary', CALLER_ID, '--ack-as-owner'], ctx(home, { cwd: repo })).result;
    assert.equal(r.ok, true, JSON.stringify(r));
    const bodies = (r.messages || []).map((m) => m.body || m.message || '');
    assert.ok(!bodies.some((b) => String(b).includes('twin-msg-')),
      'the twin\'s durable NDJSON rows are NOT folded into the caller\'s read-primary — this is the scoping rule');
    assert.equal(readCursorFile(twin.cursorPath), '0',
      'and critically read-primary NEVER advances another row\'s cursor: it cannot consume mail it did not deliver');

    // ...and the twin's mail is still fully there, drainable by its own id.
    const t = cli.run(['inbox', 'read', TWIN_ID], ctx(home, { cwd: repo })).result;
    assert.equal(t.lines.length, 6, 'NOTHING WAS LOST — the twin\'s 6 rows are intact and reachable');
  } finally { rm(home); rm(repo); }
});

test('item 7: `inbox read` stays usable from ANOTHER project (read-only is what makes that safe)', () => {
  const home = tmpHome();
  const repoA = makeGitRepo('proj-a');
  const repoB = makeGitRepo('proj-b');
  try {
    const twin = register(home, repoB, TWIN_ID);
    seedNdjson(twin, 3);
    const r = cli.run(['inbox', 'read', TWIN_ID], ctx(home, { cwd: repoA })).result;
    assert.equal(r.ok, true, 'a cross-project READ is allowed — the NDJSON channel is id-derived');
    assert.equal(r.lines.length, 3);
    assert.equal(readCursorFile(twin.cursorPath), '0',
      'and it consumed nothing — which is exactly why making `read` ack would be wrong');
  } finally { rm(home); rm(repoA); rm(repoB); }
});

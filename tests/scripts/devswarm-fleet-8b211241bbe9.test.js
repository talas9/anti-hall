'use strict';
// 8b211241bbe9 (P0) — ONE cursor per row id is shared by every process reading
// under that id, so whichever instance acks first consumes the mail for all of
// them: a second instance's `read-primary` returns 0 while the cursor has
// already advanced past rows it was never shown.
//
// Fix under test: per-instance cursors `cursors/<id>.inst-<short6>.json`, with
// the shared pair driven by the MIN across instances (never one reader's own
// position), plus the cursor write journal that makes every advance
// attributable.
//
// RED/GREEN: ANTIHALL_TEST_PLUGIN_ROOT points at a plugins/anti-hall-shaped
// tree — the `git archive HEAD` mirror (RED) or the working tree (GREEN).
//
// HERMETIC: HOME/USERPROFILE isolated per file; never touches the real
// ~/.anti-hall.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const inboxCursor = require(path.join(ROOT, 'companion', 'lib', 'devswarm-inbox-cursor.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-8b21-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-8b21-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function backend() { return (storeLib.sqliteAvailable && storeLib.sqliteAvailable()) ? 'sqlite' : 'journal'; }
function repoKeyOf(repo) {
  const rk = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
  return rk.repoKeyForWorktree(repo);
}
// Seed `n` direct messages addressed to `id` into that repo's store partition.
function seed(home, repo, id, n, tagBase) {
  const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
  try {
    for (let i = 0; i < n; i++) {
      const fields = {
        from: 'peer-sender', to: id, type: 'direct',
        message: (tagBase || 'msg') + '-' + i, timestamp: 1700000000000 + i, urgency: 'normal',
      };
      const hash = storeLib.meshMessageHash(fields);
      storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash }));
    }
  } finally { s.close(); }
}
// Register/ensure DECLARES the calling instance as a reader (defect
// 8b211241bbe9, R1): a process holds its own cursor file from its first turn
// onward. `ensure` routes through cmdRegister on every turn via `inbox pull`,
// so in production every live instance is declared. Tests must therefore
// register PER INSTANCE to model two concurrent processes; an instance that
// never registers is a NEWCOMER and inherits the fleet's floor instead.
function register(home, repo, id, sessionId, nonce) {
  return cli.cmdRegister(id, {
    worktree: [repo], session: [sessionId || ('sess-' + id)],
  }, { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: nonce });
}
const A_NONCE = 'anc:1001:1';
const B_NONCE = 'anc:2002:2';
// One `read-primary` as a named instance. `instanceNonce` is the in-process
// seam that stands in for "a different OS process identity".
function readPrimary(home, repo, id, nonce) {
  return cli.cmdInboxMessages(id, { unread: [true] }, {
    home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: nonce,
  }, { ack: true });
}
function cursorsDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'cursors'); }
function sharedCursor(home, id) {
  try { return inboxCursor.readCursor(path.join(cursorsDir(home), id + '.json')); } catch (_) { return 0; }
}
function instFiles(home, id) {
  try {
    return fs.readdirSync(cursorsDir(home)).filter((n) => n.startsWith(id + '#inst-'));
  } catch (_) { return []; }
}

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
test.before(() => {
  const iso = tmpHome();
  process.env.HOME = iso;
  process.env.USERPROFILE = iso;
});
test.after(() => {
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME; else delete process.env.HOME;
  if (REAL_USERPROFILE !== undefined) process.env.USERPROFILE = REAL_USERPROFILE; else delete process.env.USERPROFILE;
});

test('8b211241bbe9: two instances on one id each receive the full unread set', () => {
  const home = tmpHome(); const repo = makeGitRepo('core');
  try {
    const id = 'primary-core';
    register(home, repo, id, undefined, A_NONCE);
    register(home, repo, id, undefined, B_NONCE);
    seed(home, repo, id, 3, 'core');

    const a = readPrimary(home, repo, id, A_NONCE);
    assert.strictEqual(a.ok, true, 'instance A read must succeed: ' + JSON.stringify(a.error || a.reason || ''));
    assert.strictEqual(a.messages.length, 3, 'instance A must receive all 3');

    const b = readPrimary(home, repo, id, B_NONCE);
    assert.strictEqual(b.ok, true, 'instance B read must succeed');
    assert.strictEqual(b.messages.length, 3,
      'instance B must ALSO receive all 3 — the defect is that A\'s ack consumed them for B');
  } finally { rm(home); rm(repo); }
});

test('8b211241bbe9: one instance acking does not move the floor past a lagging peer', () => {
  const home = tmpHome(); const repo = makeGitRepo('floor');
  try {
    const id = 'primary-floor';
    register(home, repo, id, undefined, A_NONCE);
    register(home, repo, id, undefined, B_NONCE);
    seed(home, repo, id, 3, 'floor');
    // Both instances are DECLARED (each registered), so both hold a cursor file.
    // A reads and acks; B has not read yet and still sits at 0.
    readPrimary(home, repo, id, A_NONCE);
    assert.strictEqual(sharedCursor(home, id), 0,
      'the shared pair follows the MIN across instances — it may not run ahead of B, which has read nothing');
    const b = readPrimary(home, repo, id, B_NONCE);
    assert.strictEqual(b.messages.length, 3, 'B must see all 3 despite A having acked');
    assert.ok(sharedCursor(home, id) > 0,
      'once BOTH have consumed, the floor is free to advance — the min rule is not a permanent pin');
  } finally { rm(home); rm(repo); }
});

test('8b211241bbe9: the floor advances once every instance has consumed through N', () => {
  const home = tmpHome(); const repo = makeGitRepo('adv');
  try {
    const id = 'primary-adv';
    register(home, repo, id, undefined, A_NONCE);
    register(home, repo, id, undefined, B_NONCE);
    seed(home, repo, id, 2, 'adv');
    readPrimary(home, repo, id, A_NONCE);
    readPrimary(home, repo, id, B_NONCE);
    assert.strictEqual(instFiles(home, id).length, 2, 'both instances must hold their own cursor file');
    assert.ok(sharedCursor(home, id) >= 2,
      'once BOTH instances have consumed through 2 the shared floor must advance (min rule is not a permanent pin)');
    // And neither instance re-reads.
    const again = readPrimary(home, repo, id, A_NONCE);
    assert.strictEqual(again.messages.length, 0, 'a caught-up instance must not be re-delivered its own consumed rows');
  } finally { rm(home); rm(repo); }
});

test('8b211241bbe9: a cursor never advances when no rows were delivered', () => {
  const home = tmpHome(); const repo = makeGitRepo('zero');
  try {
    const id = 'primary-zero';
    register(home, repo, id);
    seed(home, repo, id, 2, 'zero');
    readPrimary(home, repo, id, A_NONCE);
    const before = sharedCursor(home, id);
    const empty = readPrimary(home, repo, id, A_NONCE); // nothing left for THIS instance
    assert.strictEqual(empty.messages.length, 0, 'second read delivers nothing');
    assert.strictEqual(sharedCursor(home, id), before,
      'a read that delivered 0 rows must not advance any cursor (report item 3 fingerprint)');
  } finally { rm(home); rm(repo); }
});

test('8b211241bbe9: an instance cursor file is created and is parseable', () => {
  const home = tmpHome(); const repo = makeGitRepo('file');
  try {
    const id = 'primary-file';
    register(home, repo, id, undefined, A_NONCE);
    seed(home, repo, id, 1, 'file');
    readPrimary(home, repo, id, A_NONCE);
    const files = instFiles(home, id);
    assert.strictEqual(files.length, 1,
      'exactly one instance cursor file must exist — registration DECLARED this instance and its read reused that same file');
    assert.match(files[0], /#inst-[0-9a-f]{6}\.json$/,
      'the instance file name must carry a six-hex short nonce');
  } finally { rm(home); rm(repo); }
});

test('8b211241bbe9: every cursor advance is journaled with from, to and delivered', () => {
  const home = tmpHome(); const repo = makeGitRepo('jrnl');
  try {
    const id = 'primary-jrnl';
    register(home, repo, id);
    seed(home, repo, id, 2, 'jrnl');
    readPrimary(home, repo, id, A_NONCE);
    const dir = path.join(home, '.anti-hall', 'devswarm', 'cursor-log');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.ok(files.length > 0, 'a cursor-log file must exist after an ack');
    const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').split('\n').filter((l) => l.trim());
    assert.ok(lines.length > 0, 'the journal must hold at least one record');
    const rec = JSON.parse(lines[0]);
    for (const k of ['ts', 'id', 'ns', 'from', 'to', 'delivered', 'pid', 'verb']) {
      assert.ok(Object.prototype.hasOwnProperty.call(rec, k), 'journal record must carry ' + k);
    }
    assert.strictEqual(rec.id, id, 'the record must name the partition that moved');
    assert.ok(rec.to > rec.from, 'the record must show a real from -> to advance');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// R1 fix wave — the per-instance base must reach the UNION path, a NEWCOMER must
// not replay the backlog, and the shared namespaces must stay in lockstep.
// ---------------------------------------------------------------------------

// Register a workspace WITH an inboxPath — the shape every real workspace has,
// and the one that routes reads through `unionUnread` rather than store-only.
function registerWithInbox(home, repo, id, nonce) {
  const inbox = path.join(repo, id + '.inbox.ndjson');
  fs.writeFileSync(inbox, '');
  return cli.cmdRegister(id, {
    worktree: [repo], session: ['sess-' + id], inbox: [inbox],
  }, { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: nonce });
}
function countFor(home, repo, id, nonce) {
  return cli.cmdInbox('count', id, {}, {
    home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: nonce,
  });
}

test('8b211241bbe9 R1: the per-instance base reaches the UNION path (workspace has an inboxPath)', () => {
  const home = tmpHome(); const repo = makeGitRepo('union');
  try {
    const id = 'primary-union';
    registerWithInbox(home, repo, id, A_NONCE);
    registerWithInbox(home, repo, id, B_NONCE);
    seed(home, repo, id, 3, 'union');
    const a = readPrimary(home, repo, id, A_NONCE);
    assert.strictEqual(a.messages.length, 3, 'A receives all 3 on the union path');
    const b = readPrimary(home, repo, id, B_NONCE);
    assert.strictEqual(b.messages.length, 3,
      'B must ALSO receive all 3 — `unionUnread` sized its store side from the SHARED cursor, which made the '
      + 'whole per-instance fix inert on every workspace that has an inboxPath');
  } finally { rm(home); rm(repo); }
});

test('8b211241bbe9 R1: `inbox count` agrees with `read-primary` per instance', () => {
  const home = tmpHome(); const repo = makeGitRepo('count');
  try {
    const id = 'primary-count';
    registerWithInbox(home, repo, id, A_NONCE);
    registerWithInbox(home, repo, id, B_NONCE);
    seed(home, repo, id, 3, 'count');
    readPrimary(home, repo, id, A_NONCE);
    const cb = countFor(home, repo, id, B_NONCE);
    assert.strictEqual(cb.unread, 3,
      'count for B must still report 3 after A consumed — count and read must agree PER INSTANCE');
    readPrimary(home, repo, id, B_NONCE);
    assert.strictEqual(countFor(home, repo, id, B_NONCE).unread, 0, 'and 0 once B has consumed them');
  } finally { rm(home); rm(repo); }
});

test('8b211241bbe9 R1: a NEWCOMER instance does not replay what the fleet consumed', () => {
  const home = tmpHome(); const repo = makeGitRepo('newcomer');
  try {
    const id = 'primary-new';
    register(home, repo, id, undefined, A_NONCE); // A is the only declared instance
    seed(home, repo, id, 3, 'new');
    assert.strictEqual(readPrimary(home, repo, id, A_NONCE).messages.length, 3);
    assert.strictEqual(readPrimary(home, repo, id, A_NONCE).messages.length, 0, 'A does not re-read its own');
    const c = readPrimary(home, repo, id, 'anc:3003:3');
    assert.strictEqual(c.messages.length, 0,
      'a brand-new nonce starts at the instance FLOOR, not the baseline — starting at the baseline replayed the entire backlog to every fresh instance');
    const d = readPrimary(home, repo, id, 'anc:4004:4');
    assert.strictEqual(d.messages.length, 0, 'and so does the next one');
  } finally { rm(home); rm(repo); }
});

test('8b211241bbe9 R1: a newcomer starts at the SLOWEST declared instance, not the fastest', () => {
  const home = tmpHome(); const repo = makeGitRepo('slowest');
  try {
    const id = 'primary-slow';
    register(home, repo, id, undefined, A_NONCE);
    register(home, repo, id, undefined, B_NONCE);
    seed(home, repo, id, 3, 'slow');
    readPrimary(home, repo, id, A_NONCE);                    // A consumes all 3
    cli.cmdInboxMessages(id, { unread: [true], limit: ['1'] }, {
      home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: B_NONCE,
    }, { ack: true });                                        // B consumes only 1
    const c = readPrimary(home, repo, id, 'anc:5005:5');
    assert.ok(c.messages.length >= 2,
      'the newcomer inherits the FLOOR (the slowest declared reader), so nothing any live instance still needs is skipped; got ' + c.messages.length);
  } finally { rm(home); rm(repo); }
});

test('8b211241bbe9 R1: the two shared namespaces stay in lockstep after a sibling ack', () => {
  const home = tmpHome(); const repo = makeGitRepo('lockstep');
  try {
    const id = 'primary-lock';
    register(home, repo, id, undefined, A_NONCE);
    seed(home, repo, id, 2, 'lock');
    readPrimary(home, repo, id, A_NONCE);
    const jsonVal = sharedCursor(home, id);
    const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
    let storeVal;
    try { storeVal = s.cursorValue(id); } finally { s.close(); }
    assert.strictEqual(jsonVal, storeVal,
      'the JSON cursor and the store cursor are two namespaces for ONE fact and must never diverge; a stray '
      + 'ackTo(part.cursorPath, ackTarget) used to write one of them past the min the other held');
  } finally { rm(home); rm(repo); }
});

test('8b211241bbe9 R1: reconcile journals its rewind — the one legal from > to', () => {
  const home = tmpHome(); const repo = makeGitRepo('rewind');
  try {
    const id = 'primary-rw';
    register(home, repo, id, undefined, A_NONCE);
    seed(home, repo, id, 3, 'rw');
    readPrimary(home, repo, id, A_NONCE);
    // Push ONE namespace above the others so reconcile has something to lower.
    // `reconcileOrphanCursor` is reached from the orphan-healing path, not from
    // `cmdReconcile`, so it is exercised directly here.
    inboxCursor.ackTo(path.join(cursorsDir(home), id + '.json'), 99);
    const s2 = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
    try {
      const desc = cli.readDescriptorFile(home, id);
      cli.reconcileOrphanCursor(home, s2, id, desc, false);
    } finally { s2.close(); }
    const recs = cli.readCursorLog(home, repoKeyOf(repo), 200)
      .concat(cli.readCursorLog(home, 'unknown', 200));
    const rewind = recs.find((r) => r.verb === 'reconcile' && r.gate === 'allowRewind');
    assert.ok(rewind, 'the rewind must be journaled, else it looks like a corrupt record: ' + JSON.stringify(recs.slice(-3)));
    assert.ok(rewind.from > rewind.to, 'and it is the ONE legal from > to in the design');
  } finally { rm(home); rm(repo); }
});

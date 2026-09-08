'use strict';
// 8b211241bbe9 (task #6) — the cursor write journal.
//
// The field defect was diagnosed twice from symptoms alone because no cursor
// writer left a trace. Every mutation must now be attributable: which partition
// moved, from where to where, how many rows were actually delivered to justify
// it, which process/instance did it, under which verb and gate.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cjrnl-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

test('cursor journal: a record carries the full attribution contract', () => {
  const home = tmpHome();
  try {
    cli.logCursorWrite(home, {
      id: 'w', partition: 'w', callerId: 'caller', ns: 'inst', from: 3, to: 7,
      delivered: 4, nonce: 'abc123', gate: 'owner', verb: 'read-primary',
      cwd: '/tmp/x', repoKey: 'rk',
    });
    const recs = cli.readCursorLog(home, 'rk', 10);
    assert.strictEqual(recs.length, 1);
    const r = recs[0];
    for (const k of ['ts', 'id', 'partition', 'callerId', 'ns', 'from', 'to', 'delivered', 'pid', 'nonce', 'gate', 'verb', 'cwd', 'ok']) {
      assert.ok(Object.prototype.hasOwnProperty.call(r, k), 'missing field: ' + k);
    }
    assert.strictEqual(r.from, 3);
    assert.strictEqual(r.to, 7);
    assert.strictEqual(r.delivered, 4);
    assert.strictEqual(r.pid, process.pid, 'the writing process must be identified');
  } finally { rm(home); }
});

test('cursor journal: a foreign-instance advance is identifiable from the record alone', () => {
  const home = tmpHome();
  try {
    cli.logCursorWrite(home, {
      id: 'twin-uuid', partition: 'twin-uuid', callerId: 'primary-mesh', ns: 'store',
      from: 30, to: 31, delivered: 0, nonce: 'aaaaaa', gate: 'self-crosslink',
      verb: 'read-primary', repoKey: 'rk',
    });
    const r = cli.readCursorLog(home, 'rk', 10)[0];
    assert.notStrictEqual(r.callerId, r.partition,
      'callerId !== partition is the outside-the-turn signature that names the eater');
    assert.strictEqual(r.delivered, 0,
      'delivered:0 on an advance is the 8b211241bbe9 fingerprint — mechanically detectable, no re-derivation needed');
    assert.strictEqual(r.gate, 'self-crosslink', 'the gate field says WHY the write was permitted');
  } finally { rm(home); }
});

test('cursor journal: rotation is bounded and preserves the newest records', () => {
  const home = tmpHome();
  try {
    for (let i = 0; i < 2100; i++) {
      cli.logCursorWrite(home, { id: 'w', ns: 'inst', from: i, to: i + 1, verb: 'read-primary', repoKey: 'rk' });
    }
    const p = cli.cursorLogPath(home, 'rk');
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    assert.ok(lines.length <= 2000, 'the live log must stay at or under the cap, got ' + lines.length);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(last.to, 2100, 'the NEWEST record must survive rotation');
    assert.ok(fs.existsSync(p + '.1'), 'the rotated-out generation is kept, not discarded');
  } finally { rm(home); }
});

test('cursor journal: a write failure leaves the caller unaffected (fail-open)', () => {
  const home = tmpHome();
  try {
    // Make the log path un-writable by planting a directory where the file goes.
    const p = cli.cursorLogPath(home, 'rk');
    fs.mkdirSync(p, { recursive: true });
    const ok = cli.logCursorWrite(home, { id: 'w', ns: 'inst', from: 0, to: 1, verb: 'read-primary', repoKey: 'rk' });
    assert.strictEqual(ok, false, 'the helper reports the failure');
    // and crucially it did not throw — instrumentation never breaks an ack.
  } finally { rm(home); }
});

test('cursor journal: an unsafe repoKey cannot escape the log directory', () => {
  const home = tmpHome();
  try {
    const p = cli.cursorLogPath(home, '../../etc/passwd');
    assert.ok(p.includes('cursor-log'), 'a traversal-shaped repoKey must fall back inside the log dir: ' + p);
    assert.ok(!p.includes('..'), 'no traversal segment may survive: ' + p);
  } finally { rm(home); }
});

test('cursor journal: a torn line is skipped, never thrown on', () => {
  const home = tmpHome();
  try {
    cli.logCursorWrite(home, { id: 'w', ns: 'inst', from: 0, to: 1, verb: 'read-primary', repoKey: 'rk' });
    fs.appendFileSync(cli.cursorLogPath(home, 'rk'), '{not json\n');
    cli.logCursorWrite(home, { id: 'w', ns: 'inst', from: 1, to: 2, verb: 'read-primary', repoKey: 'rk' });
    const recs = cli.readCursorLog(home, 'rk', 10);
    assert.strictEqual(recs.length, 2, 'both good records survive a torn line between them');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// R3 item 4 (G) — `delivered` must be TRUE on a store-only read.
// ---------------------------------------------------------------------------

const cp3 = require('node:child_process');
const storeLib3 = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const repokey3 = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const cli3 = require(path.join(ROOT, 'scripts', 'devswarm.js'));
function be3() { return (storeLib3.sqliteAvailable && storeLib3.sqliteAvailable()) ? 'sqlite' : 'journal'; }
function repo3(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cj3-' + tag + '-'));
  cp3.spawnSync('git', ['init', '-q', dir]);
  cp3.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp3.spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp3.spawnSync('git', ['-C', dir, 'add', '.']);
  cp3.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

test('cursor journal: `delivered` is the REAL row count on a store-only read', () => {
  const home = tmpHome(); const repo = repo3('delivered');
  try {
    const id = 'primary-deliv';
    const ctx = { home, cwd: repo, env: {}, backend: be3(), now: Date.now(), instanceNonce: 'anc:1:1' };
    cli3.cmdRegister(id, { worktree: [repo], session: ['s'] }, ctx);
    const s = storeLib3.openStore({ home, hash: repokey3.repoKeyForWorktree(repo), backend: be3() });
    try {
      for (let i = 0; i < 3; i++) {
        const f = { from: 'p', to: id, type: 'direct', message: 'd-' + i, timestamp: 1700000000000 + i, urgency: 'normal' };
        storeLib3.appendMeshMessage(s, Object.assign({}, f, { hash: storeLib3.meshMessageHash(f) }));
      }
    } finally { s.close(); }

    const r = cli3.cmdInboxMessages(id, { unread: [true] }, ctx, { ack: true });
    assert.strictEqual((r.messages || []).length, 3, 'precondition: a store-only read delivering 3');

    const rk = repokey3.repoKeyForWorktree(repo);
    const recs = cli3.readCursorLog(home, rk, 50).filter((x) => x && x.id === id && x.to > x.from);
    assert.ok(recs.length, 'the advance must be journaled: ' + JSON.stringify(cli3.readCursorLog(home, rk, 5)));
    for (const rec of recs) {
      assert.strictEqual(rec.delivered, 3,
        'delivered must be the rows ACTUALLY returned. The `__srcId` tags are only stamped on the union/mesh '
        + 'paths, so counting tagged rows reported 0 here — a false positive of the very `delivered:0` signature '
        + 'this journal exists to make trustworthy.');
    }
  } finally { rm(home); rm(repo); }
});

'use strict';
// 8b211241bbe9 — the per-instance cursor hygiene pass (GC) and its persisted
// shape. Two predicates under test:
//   (1) floor-preserving delete: never remove the file PINNING the floor, or GC
//       itself advances the floor past that instance (a third cursor eater);
//   (2) bounded staleness eviction: a file older than the window may go even
//       when it pins the floor, else a dead instance pins the shared cursor
//       forever. Every eviction is journaled.
// Plus the filename parser's six-hex requirement and all prior cursor forms.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const doctorDevswarm = require(path.join(ROOT, 'companion', 'lib', 'doctor-devswarm.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-8b21gc-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'cursors'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function cursorsDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'cursors'); }
function writeInst(home, id, short, value, ageMs) {
  const p = path.join(cursorsDir(home), id + '#inst-' + short + '.json');
  fs.writeFileSync(p, String(value));
  if (Number.isFinite(ageMs)) {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(p, t, t);
  }
  return p;
}
function writeBaseline(home, id, value) {
  fs.writeFileSync(path.join(cursorsDir(home), id + '#base.json'), String(value));
}
function listInst(home, id) {
  return fs.readdirSync(cursorsDir(home)).filter((n) => n.startsWith(id + '#inst-'));
}
const DAY = 24 * 60 * 60 * 1000;

test('8b211241bbe9 GC: never deletes the file pinning the floor', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w1', 0);
    writeInst(home, 'w1', 'aaaaaa', 10, 1000);
    writeInst(home, 'w1', 'bbbbbb', 20, 1000);
    const r = cli.gcInstanceCursors(null, home, {});
    assert.strictEqual(r.scanned, 2);
    const left = listInst(home, 'w1');
    assert.ok(left.includes('w1#inst-aaaaaa.json'),
      'the file holding the MIN pins the floor and must survive — deleting it would advance the floor past that instance');
    assert.strictEqual(r.evicted, 0, 'nothing is stale here, so nothing may be evicted');
    assert.strictEqual(r.deleted, 0, 'a FRESH file is never a GC candidate: it is a live reader\'s position');
    assert.strictEqual(left.length, 2, 'both fresh files survive untouched');
  } finally { rm(home); }
});

test('8b211241bbe9 GC: deletes a file whose removal does not raise the floor', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w2', 0);
    writeInst(home, 'w2', 'aaaaaa', 10, 8 * DAY);
    writeInst(home, 'w2', 'bbbbbb', 10, 8 * DAY); // duplicate min, both stale
    const r = cli.gcInstanceCursors(null, home, {});
    assert.strictEqual(r.deleted, 2, 'neither removal ADVANCES the floor past anyone, so both are plain deletes');
    assert.strictEqual(r.evicted, 0, 'an eviction is only when the floor moves FORWARD past an instance');
    assert.strictEqual(listInst(home, 'w2').length, 0, 'both were stale, so both are gone');
  } finally { rm(home); }
});

test('8b211241bbe9 GC: evicts a stale file even when it pins the floor', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w3', 0);
    writeInst(home, 'w3', 'aaaaaa', 10, 8 * DAY); // older than the 7-day window
    writeInst(home, 'w3', 'bbbbbb', 20, 1000);
    const r = cli.gcInstanceCursors(null, home, {});
    assert.strictEqual(r.evicted, 1, 'the stale floor-pinning file must be evicted');
    assert.ok(!listInst(home, 'w3').includes('w3#inst-aaaaaa.json'));
  } finally { rm(home); }
});

test('8b211241bbe9 GC: a file inside the staleness window is never evicted', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w4', 0);
    writeInst(home, 'w4', 'aaaaaa', 10, 60 * 60 * 1000); // one hour old
    writeInst(home, 'w4', 'bbbbbb', 20, 1000);
    const r = cli.gcInstanceCursors(null, home, {});
    assert.strictEqual(r.evicted, 0, 'the window is a real bound, not a rounding of "stale enough"');
    assert.strictEqual(listInst(home, 'w4').length, 2);
  } finally { rm(home); }
});

test('8b211241bbe9 GC: an eviction is journaled with the floor movement', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w5', 0);
    writeInst(home, 'w5', 'aaaaaa', 10, 8 * DAY);
    writeInst(home, 'w5', 'bbbbbb', 20, 1000);
    cli.gcInstanceCursors(null, home, {});
    const recs = cli.readCursorLog(home, 'unknown', 50);
    const evict = recs.find((r) => r.gate === 'gc-evict');
    assert.ok(evict, 'an eviction must leave a journal record: ' + JSON.stringify(recs));
    assert.strictEqual(evict.verb, 'gc-evict');
    assert.strictEqual(evict.from, 10, 'the record must show the floor before');
    assert.strictEqual(evict.to, 20, 'and the floor after — the bounded cost is attributable');
  } finally { rm(home); }
});

test('8b211241bbe9 GC: the pass is idempotent', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w6', 0);
    writeInst(home, 'w6', 'aaaaaa', 10, 1000);
    writeInst(home, 'w6', 'bbbbbb', 20, 1000);
    cli.gcInstanceCursors(null, home, {});
    const after1 = listInst(home, 'w6').sort();
    cli.gcInstanceCursors(null, home, {});
    const after2 = listInst(home, 'w6').sort();
    assert.deepStrictEqual(after2, after1, 'running the hygiene pass twice must leave the tree identical');
  } finally { rm(home); }
});

test('8b211241bbe9 GC: unparseable and non-instance filenames are left untouched', () => {
  const home = tmpHome();
  try {
    // Names this code could NEVER have written: no six-hex nonce, a plain
    // shared cursor, a `.seen-` watermark, and a baseline file.
    const decoys = ['w7.json', 'w7#inst-nothex.json', 'w7#inst-ABCDEF.json',
      'w7.seen-other.json', 'w7.base.json', 'w7#base.json', 'random.txt'];
    for (const n of decoys) fs.writeFileSync(path.join(cursorsDir(home), n), '5');
    const r = cli.gcInstanceCursors(null, home, {});
    assert.strictEqual(r.scanned, 0, 'none of these are instance cursor files');
    for (const n of decoys) {
      assert.ok(fs.existsSync(path.join(cursorsDir(home), n)), n + ' must be left strictly alone (never guess-delete)');
    }
  } finally { rm(home); }
});

test('8b211241bbe9: parseInstCursorName requires a six-hex nonce', () => {
  assert.deepStrictEqual(cli.parseInstCursorName('abc#inst-a1b2c3.json'), { id: 'abc', shortNonce: 'a1b2c3' });
  assert.strictEqual(cli.parseInstCursorName('abc#inst-ABCDEF.json'), null, 'uppercase is not a sha1 prefix this code writes');
  assert.strictEqual(cli.parseInstCursorName('abc#inst-nothex.json'), null);
  assert.strictEqual(cli.parseInstCursorName('abc#inst-a1b2c.json'), null, 'five hex is not six');
  assert.strictEqual(cli.parseInstCursorName('abc.json'), null);
  assert.strictEqual(cli.parseInstCursorName('abc#inst-a1b2c3.txt'), null);
  // An id that itself contains the separator must not be mis-parsed.
  assert.deepStrictEqual(cli.parseInstCursorName('a#inst-b#inst-a1b2c3.json'), null,
    'an id containing the separator is not instCursorSafeId and must never be swept');
});

test('8b211241bbe9: all prior cursor forms are readable (bare int and {line:n})', () => {
  const home = tmpHome();
  try {
    fs.writeFileSync(path.join(cursorsDir(home), 'w8#inst-aaaaaa.json'), '7');
    fs.writeFileSync(path.join(cursorsDir(home), 'w8#inst-bbbbbb.json'), JSON.stringify({ line: 3 }));
    const files = cli.listInstanceCursors(home, 'w8');
    const byNonce = {};
    for (const f of files) byNonce[f.shortNonce] = f.value;
    assert.strictEqual(byNonce.aaaaaa, 7, 'a bare integer must read back');
    assert.strictEqual(byNonce.bbbbbb, 3, 'the {line:n} form must read back too');
  } finally { rm(home); }
});

test('8b211241bbe9 GC: fails open on an unreadable cursors directory', () => {
  const home = tmpHome();
  try {
    rm(path.join(home, '.anti-hall', 'devswarm', 'cursors'));
    const r = cli.gcInstanceCursors(null, home, {});
    assert.strictEqual(r.scanned, 0, 'a missing cursors dir is a no-op, never a throw');
    assert.strictEqual(r.deleted, 0);
  } finally { rm(home); }
});

test('8b211241bbe9: doctor runs the SAME hygiene pass and is report-only by default', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w9', 0);
    writeInst(home, 'w9', 'aaaaaa', 10, 8 * DAY);
    writeInst(home, 'w9', 'bbbbbb', 20, 1000);
    const res = doctorDevswarm.cursorHygieneCheck({ home });
    assert.match(res.message, /cursor hygiene/i);
    assert.match(res.message, /would remove/, 'a plain doctor run must be report-only');
    assert.strictEqual(listInst(home, 'w9').length, 2, 'report-only must not delete anything');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// R2 item 13 — reserved-token ids, and the collision they used to create.
// ---------------------------------------------------------------------------

const cp2 = require('node:child_process');
function gitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-8b21r2-' + tag + '-'));
  cp2.spawnSync('git', ['init', '-q', dir]);
  cp2.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp2.spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp2.spawnSync('git', ['-C', dir, 'add', '.']);
  cp2.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
const storeLib2 = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
function be2() { return (storeLib2.sqliteAvailable && storeLib2.sqliteAvailable()) ? 'sqlite' : 'journal'; }

test('8b211241bbe9 R2: a fresh register REFUSES an id carrying a reserved cursor token', () => {
  const home = tmpHome(); const repo = gitRepo('reserved');
  try {
    const ctx = { home, cwd: repo, env: {}, backend: be2(), now: Date.now(), instanceNonce: 'anc:1:1' };
    for (const bad of ['w.base', 'w.inst-abcdef', 'w.nd-abcdef', 'w.seen-other']) {
      const r = cli.cmdRegister(bad, { worktree: [repo], session: ['s'] }, ctx);
      assert.strictEqual(r.ok, false, 'id ' + JSON.stringify(bad) + ' must be refused: ' + JSON.stringify(r).slice(0, 160));
      assert.strictEqual(r.reason, 'reserved-id-token', 'and refused with a NAMED reason, not a generic failure');
      assert.match(r.error, /reserved token/, 'the error must say which token is the problem');
    }
  } finally { rm(home); rm(repo); }
});

test('8b211241bbe9 R2: a legitimate dotted id still registers', () => {
  const home = tmpHome(); const repo = gitRepo('dotted');
  try {
    const ctx = { home, cwd: repo, env: {}, backend: be2(), now: Date.now(), instanceNonce: 'anc:1:1' };
    for (const good of ['a.b', 'primary-abc.def', 'w.baseline']) {
      const r = cli.cmdRegister(good, { worktree: [repo], session: ['s'] }, ctx);
      assert.notStrictEqual(r.ok, false,
        'id ' + JSON.stringify(good) + ' is legitimate and must still register: ' + JSON.stringify(r).slice(0, 160));
    }
  } finally { rm(home); rm(repo); }
});

test('8b211241bbe9 R2: a pre-existing cursors/<id>.base.json is NEVER read as another id\'s baseline', () => {
  const home = tmpHome();
  try {
    // The pre-0.99 shape this defect produced: a workspace literally named
    // `w.base`, whose legacy cursor file is `cursors/w.base.json`. Under the
    // old `.base` suffix that file WAS workspace `w`'s baseline path, so acking
    // it to 42 made `w` skip 42 rows. The `#` separator makes the two names
    // structurally distinct.
    fs.writeFileSync(path.join(cursorsDir(home), 'w.base.json'), '42');
    const s = storeLib2.openStore({ home, hash: 'rk-collide', backend: be2() });
    try {
      assert.strictEqual(cli.readInstanceBaseline(s, home, 'w'), 0,
        'workspace w has consumed nothing; the file belonging to workspace `w.base` must not be read as its baseline');
      assert.strictEqual(cli.instanceFloor(s, home, 'w'), 0, 'and the floor must not inherit it either');
    } finally { s.close(); }
    // The distinct baseline path is what w actually uses.
    assert.ok(cli.instanceBaselinePath(home, 'w').endsWith('w#base.json'));
    assert.ok(fs.existsSync(path.join(cursorsDir(home), 'w.base.json')),
      'and the other workspace\'s own cursor file is left untouched — no-delete');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// R2 item 2 — the `#nd-` namespace is swept too.
// ---------------------------------------------------------------------------

function writeNd(home, id, short, value, ageMs) {
  const p = path.join(cursorsDir(home), id + '#nd-' + short + '.json');
  fs.writeFileSync(p, String(value));
  if (Number.isFinite(ageMs)) { const t = (Date.now() - ageMs) / 1000; fs.utimesSync(p, t, t); }
  return p;
}
function listNd(home, id) {
  return fs.readdirSync(cursorsDir(home)).filter((n) => n.startsWith(id + '#nd-'));
}

test('8b211241bbe9 R2 GC: a stale `#nd-` cursor pinning the descriptor floor is evicted', () => {
  const home = tmpHome();
  try {
    writeNd(home, 'n1', 'aaaaaa', 10, 8 * DAY);
    writeNd(home, 'n1', 'bbbbbb', 20, 1000);
    const r = cli.gcInstanceCursors(null, home, {});
    assert.strictEqual(r.evicted, 1,
      'without this, a dead instance pins the descriptor cursor forever via projectNdDescriptorCursor');
    assert.ok(!listNd(home, 'n1').includes('n1#nd-aaaaaa.json'));
  } finally { rm(home); }
});

test('8b211241bbe9 R2 GC: a FRESH `#nd-` cursor is never a candidate', () => {
  const home = tmpHome();
  try {
    writeNd(home, 'n2', 'aaaaaa', 10, 60 * 60 * 1000);
    writeNd(home, 'n2', 'bbbbbb', 20, 1000);
    const r = cli.gcInstanceCursors(null, home, {});
    assert.strictEqual(r.deleted + r.evicted, 0, 'a fresh NDJSON cursor is a live reader\'s position');
    assert.strictEqual(listNd(home, 'n2').length, 2);
  } finally { rm(home); }
});

test('8b211241bbe9 R2 GC: an `#nd-` eviction is journaled with its namespace', () => {
  const home = tmpHome();
  try {
    writeNd(home, 'n3', 'aaaaaa', 10, 8 * DAY);
    writeNd(home, 'n3', 'bbbbbb', 20, 1000);
    cli.gcInstanceCursors(null, home, {});
    const rec = cli.readCursorLog(home, 'unknown', 50).find((x) => x.gate === 'gc-evict' && x.id === 'n3');
    assert.ok(rec, 'the eviction must be journaled');
    assert.strictEqual(rec.ns, 'nd', 'and must name WHICH namespace moved — the two count in different index spaces');
    assert.strictEqual(rec.from, 10);
    assert.strictEqual(rec.to, 20);
  } finally { rm(home); }
});

test('8b211241bbe9 R2 GC: the two namespaces never mix in one floor computation', () => {
  const home = tmpHome();
  try {
    // `#inst-` counts store rows, `#nd-` counts NDJSON lines. If they were
    // grouped together the low value from one would wrongly pin the other.
    writeInst(home, 'n4', 'aaaaaa', 100, 8 * DAY);
    writeNd(home, 'n4', 'bbbbbb', 1, 8 * DAY);
    const r = cli.gcInstanceCursors(null, home, {});
    assert.strictEqual(r.scanned, 2, 'both namespaces are scanned');
    const recs = cli.readCursorLog(home, 'unknown', 50).filter((x) => x.gate === 'gc-evict' && x.id === 'n4');
    for (const rec of recs) {
      assert.ok(rec.ns === 'inst' || rec.ns === 'nd');
      assert.notStrictEqual(rec.from, undefined);
    }
  } finally { rm(home); }
});

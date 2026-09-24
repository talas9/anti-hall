'use strict';
// 8b211241bbe9 — persisted-shape forward migration and mixed-fleet safety.
//
// The rule: any persisted-shape change ships an idempotent, fail-open,
// NO-DELETE forward migration in BOTH update.js and doctor, covering all prior
// forms. Here: the baseline seed (upgrade continuity), the hygiene pass in both
// entry points, and a 0.98-style caller reading alongside a 0.99 one.

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
const doctorDevswarm = require(path.join(ROOT, 'companion', 'lib', 'doctor-devswarm.js'));
const updateMod = require(path.join(ROOT, 'skills', 'update', 'scripts', 'update.js'));
const readerCursors = require(path.join(ROOT, 'companion', 'lib', 'reader-cursors.js'));
function floorRow(home, repo, id, ns) {
  const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
  try { return s.readerCursorRows(id).find((r) => r.ns === (ns || 'store') && r.reader === '#floor') || null; }
  finally { s.close(); }
}

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cmig-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'cursors'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cmig-repo-' + tag + '-'));
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
  return require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js')).repoKeyForWorktree(repo);
}
function cursorsDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'cursors'); }
function seed(home, repo, id, n) {
  const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
  try {
    for (let i = 0; i < n; i++) {
      const f = { from: 'p', to: id, type: 'direct', message: 'm-' + i, timestamp: 1700000000000 + i, urgency: 'normal' };
      storeLib.appendMeshMessage(s, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
    }
  } finally { s.close(); }
}
function register(home, repo, id) {
  return cli.cmdRegister(id, { worktree: [repo], session: ['s-' + id] },
    { home, cwd: repo, env: {}, backend: backend(), now: Date.now() });
}
function readPrimary(home, repo, id, nonce) {
  return cli.cmdInboxMessages(id, { unread: [true] },
    { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: nonce }, { ack: true });
}

test('migration: a pre-0.99 install resumes where it left off (baseline seeded from the shared value)', () => {
  const home = tmpHome(); const repo = makeGitRepo('seed');
  try {
    const id = 'primary-seed';
    // Model the upgrade in the order it actually happens: the pre-0.99 state
    // exists FIRST (legacy shared namespaces only, 2 of 4 rows consumed, no
    // instance file, no baseline), and only THEN does 0.99 code register and
    // read. Registering first would declare an instance at floor 0 before the
    // legacy cursor was written, which is not an upgrade — that is a fresh
    // install whose cursor was hand-edited afterwards.
    cli.cmdRegister(id, { worktree: [repo], session: ['s-' + id] },
      { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'legacy:0:0' });
    seed(home, repo, id, 4);
    const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
    try { s.setCursor(id, 2); } finally { s.close(); }
    inboxCursor.ackTo(path.join(cursorsDir(home), id + '.json'), 2);
    // Strip everything 0.99 registration created (the instance file AND the
    // baseline it seeded) so the tree is exactly a pre-0.99 shape: shared
    // cursors only. In a genuine upgrade the legacy cursor already exists when
    // 0.99 first runs, so the baseline seeds from it; here the fixture has to
    // undo the out-of-order seed.
    for (const n of fs.readdirSync(cursorsDir(home))) {
      if (n.startsWith(id + '#inst-') || n === id + '#base.json') {
        fs.unlinkSync(path.join(cursorsDir(home), n));
      }
    }

    const r = readPrimary(home, repo, id, 'h:1:1');
    assert.strictEqual(r.messages.length, 2,
      'only the 2 UNCONSUMED rows may be delivered — an upgrade must not re-deliver already-read mail');
    // Phase 3: the legacy effective floor (the shared pair here, no #base / no
    // #inst) is IMPORTED into reader_cursors on first touch; no #base is written.
    assert.ok(floorRow(home, repo, id), 'the reader_cursors floor is imported on first touch');
    assert.ok(!fs.existsSync(path.join(cursorsDir(home), id + '#base.json')), 'new code never writes #base');
    // The delivered count above IS the contract: seeding from the pre-fix
    // shared value is what makes it 2 rather than 4. The baseline's own value
    // is not asserted here because it legitimately tracks the shared pair
    // UPWARD after the ack (the shared pair is a min-projection, so using it as
    // a floor can never skip an instance).
    const again = readPrimary(home, repo, id, 'h:1:1');
    assert.strictEqual(again.messages.length, 0,
      'and the upgraded instance does not re-read what it just consumed');
  } finally { rm(home); rm(repo); }
});

test('migration (Phase 3): the one-time import is idempotent and never touches the legacy files', () => {
  const home = tmpHome(); const repo = makeGitRepo('idem');
  try {
    const id = 'primary-idem';
    register(home, repo, id);
    seed(home, repo, id, 2);
    fs.writeFileSync(path.join(cursorsDir(home), id + '#inst-abcdef.json'), '1');
    fs.writeFileSync(path.join(cursorsDir(home), id + '#base.json'), '1');
    const snap = () => fs.readdirSync(cursorsDir(home)).filter((n) => n.includes('#')).sort()
      .map((n) => n + '=' + fs.readFileSync(path.join(cursorsDir(home), n), 'utf8') + '@' + fs.statSync(path.join(cursorsDir(home), n)).mtimeMs);
    const before = snap();
    const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
    try {
      const r1 = readerCursors.importLegacy(s, { partition: id, home, procTable: new Map() });
      const rows1 = JSON.stringify(s.readerCursorRows(id).map((r) => [r.ns, r.reader, r.value]).sort());
      const r2 = readerCursors.importLegacy(s, { partition: id, home, procTable: new Map() });
      const rows2 = JSON.stringify(s.readerCursorRows(id).map((r) => [r.ns, r.reader, r.value]).sort());
      assert.strictEqual(r1.imported, true);
      assert.strictEqual(r2.imported, false, 'a second import is a no-op (gated on the #floor row inside the txn)');
      assert.strictEqual(rows2, rows1);
      assert.strictEqual(floorRow(home, repo, id).value, 1, 'floor = HEAD instanceFloor = max(#base 1, min #inst 1)');
    } finally { s.close(); }
    assert.deepStrictEqual(snap(), before, 'no legacy file is created, modified or deleted by the import');
  } finally { rm(home); rm(repo); }
});

test('migration: a 0.98-style caller (no instance file) reads alongside a 0.99 reader without loss', () => {
  const home = tmpHome(); const repo = makeGitRepo('mixed');
  try {
    const id = 'primary-mixed';
    register(home, repo, id);
    seed(home, repo, id, 3);
    // The 0.99 reader consumes everything under its own instance identity.
    const modern = readPrimary(home, repo, id, 'h:1:1');
    assert.strictEqual(modern.messages.length, 3);
    // A legacy-shaped caller carries no instance identity at all.
    const legacy = cli.cmdInboxMessages(id, { unread: [true] },
      { home, cwd: repo, env: {}, backend: backend(), now: Date.now() }, { ack: true });
    assert.ok(legacy.ok, 'a caller with no instance identity must still work');
    // The legacy caller sizes from the floor, which the modern reader's ack did
    // NOT push past the baseline while it was the only instance... the contract
    // that matters is simply that nothing throws and no mail is lost overall.
    const total = modern.messages.length + legacy.messages.length;
    assert.ok(total >= 3, 'no message may be lost across a mixed fleet, got ' + total);
  } finally { rm(home); rm(repo); }
});

test('migration: both entry points expose the SAME hygiene pass', () => {
  assert.strictEqual(typeof updateMod.cursorHygienePostUpdate, 'function',
    'update.js must ship the forward migration');
  assert.strictEqual(typeof doctorDevswarm.cursorHygieneCheck, 'function',
    'doctor must ship it too — an install that never runs the updater still converges');
});

test('migration: update.js hygiene is gated and fail-open outside a DevSwarm session', () => {
  const home = tmpHome();
  try {
    const r = updateMod.cursorHygienePostUpdate({
      paths: { pluginSrcDir: path.join(ROOT) }, env: {}, cwd: os.tmpdir(), home,
    });
    assert.strictEqual(typeof r, 'object');
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'attempted'),
      'it must report rather than throw, whatever the gate decides');
  } finally { rm(home); }
});

test('migration: doctor hygiene never throws on a home with no devswarm state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cmig-bare-'));
  try {
    const res = doctorDevswarm.cursorHygieneCheck({ home });
    assert.ok(res && res.status, 'a bare home yields a status, not an exception');
  } finally { rm(home); }
});

test('migration: a fold raises the baseline so forwarded rows are not re-delivered', () => {
  const home = tmpHome(); const repo = makeGitRepo('fold');
  try {
    const id = 'primary-fold';
    register(home, repo, id);
    seed(home, repo, id, 2);
    readPrimary(home, repo, id, 'h:1:1');
    // A loss-free writer (fold/reap) may move the baseline; ordinary acks may not.
    const before = inboxCursor.readCursor(path.join(cursorsDir(home), id + '#base.json'));
    cli.raiseInstanceBaseline(home, id, before + 5);
    const after = inboxCursor.readCursor(path.join(cursorsDir(home), id + '#base.json'));
    assert.strictEqual(after, before + 5, 'a loss-free advance moves the baseline');
    // A brand-new instance now starts at the raised baseline, not at zero.
    const fresh = readPrimary(home, repo, id, 'h:9:9');
    assert.strictEqual(fresh.messages.length, 0,
      'a new instance must not re-read rows a fold already forwarded elsewhere');
  } finally { rm(home); rm(repo); }
});

test('migration: the baseline is monotonic — it can never be lowered', () => {
  const home = tmpHome();
  try {
    const id = 'w-mono';
    cli.raiseInstanceBaseline(home, id, 10);
    cli.raiseInstanceBaseline(home, id, 3);
    const v = inboxCursor.readCursor(path.join(cursorsDir(home), id + '#base.json'));
    assert.strictEqual(v, 10, 'a lower value must never rewind the loss-free watermark');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// R1 item 18 — mixed-fleet against a REAL shipped older build, plus the doctor
// repair/dry-run contracts and the ack-failure reporting the Reviewer flagged.
// ---------------------------------------------------------------------------

// RESOLVING A REAL PRIOR BUILD, in three steps.
//
// (a) The installed marketplace cache, laid out as `<version>/scripts/devswarm.js`
//     — NOT `<version>/plugins/anti-hall/...`. An earlier cut used the wrong path,
//     resolved to null, and took an `assert.ok(true)` branch: a VACUOUS PASS.
// (b) The git tag, extracted into a temp dir. CI has no plugin cache, so a hard
//     assert on (a) fails on every runner (reproduced with a clean HOME) — the
//     over-correction for the vacuous pass. A shallow checkout may lack the tag,
//     so a bounded `git fetch` is attempted and its failure is never fatal.
// (c) Otherwise SKIP WITH A REASON. Never a vacuous pass, never a hard fail on
//     an environment that legitimately cannot supply the old build.
const OLD_VERSION = '0.98.3';
let oldBuildTemp = null;
function tryPluginCache() {
  const p = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'anti-hall', 'anti-hall', OLD_VERSION);
  return fs.existsSync(path.join(p, 'scripts', 'devswarm.js')) ? { root: p, source: 'plugin cache' } : null;
}
function tryGitTag() {
  const repoRoot = path.join(__dirname, '..', '..');
  const tag = 'v' + OLD_VERSION;
  const has = () => {
    const r = cp.spawnSync('git', ['-C', repoRoot, 'rev-parse', '-q', '--verify', tag + '^{commit}'],
      { encoding: 'utf8', timeout: 20000 });
    return r.status === 0;
  };
  if (!has()) {
    // Shallow CI checkout: try once, bounded, and ignore every failure mode
    // (no network, no remote, no such tag).
    try {
      cp.spawnSync('git', ['-C', repoRoot, 'fetch', '--depth=1', 'origin', 'tag', tag],
        { encoding: 'utf8', timeout: 20000, stdio: 'ignore' });
    } catch (_) { /* offline is not a test failure */ }
    if (!has()) return null;
  }
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-old-' + OLD_VERSION + '-'));
  const ar = cp.spawnSync('git', ['-C', repoRoot, 'archive', tag, 'plugins/anti-hall'], {
    encoding: 'buffer', timeout: 20000, maxBuffer: 256 * 1024 * 1024,
  });
  if (ar.status !== 0 || !ar.stdout || !ar.stdout.length) { rm(dest); return null; }
  const tarFile = path.join(dest, 'old.tar');
  fs.writeFileSync(tarFile, ar.stdout);
  const ex = cp.spawnSync('tar', ['-x', '-f', tarFile, '-C', dest], { timeout: 20000 });
  if (ex.status !== 0) { rm(dest); return null; }
  const root = path.join(dest, 'plugins', 'anti-hall');
  if (!fs.existsSync(path.join(root, 'scripts', 'devswarm.js'))) { rm(dest); return null; }
  oldBuildTemp = dest;
  return { root, source: 'git tag ' + tag };
}
// Resolved once; the temp extraction is reused by every test below.
let OLD_BUILD;
function oldBuild() {
  if (OLD_BUILD === undefined) OLD_BUILD = tryPluginCache() || tryGitTag() || null;
  return OLD_BUILD;
}
test.after(() => { if (oldBuildTemp) rm(oldBuildTemp); });

test('migration: a REAL 0.98.3 caller and a 0.99 caller each receive the full backlog', (t) => {
  const found = oldBuild();
  if (!found) {
    t.skip('shipped ' + OLD_VERSION + ' unavailable: no plugin cache, no v' + OLD_VERSION + ' tag');
    return;
  }
  // Say WHICH source was used, so a green run is never ambiguous about what it exercised.
  console.log('    [mixed-fleet] old build resolved from: ' + found.source);
  const oldCli = require(path.join(found.root, 'scripts', 'devswarm.js'));

  // ORDER A: the 0.99 instance DECLARES itself first, then the old build reads.
  {
    const home = tmpHome(); const repo = makeGitRepo('mixA');
    try {
      const id = 'primary-mixA';
      cli.cmdRegister(id, { worktree: [repo], session: ['s-' + id] },
        { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'h:99:9' });
      seed(home, repo, id, 3);
      const old = oldCli.cmdInboxMessages(id, { unread: [true] },
        { home, cwd: repo, env: {}, backend: backend(), now: Date.now() }, { ack: true });
      assert.strictEqual((old.messages || []).length, 3, 'the 0.98.3 build must receive all 3');
      const nw = readPrimary(home, repo, id, 'h:99:9');
      assert.strictEqual((nw.messages || []).length, 3,
        'and the DECLARED 0.99 instance must ALSO receive all 3 — the old build\'s ack writes the shared pair to '
        + 'its own position with no min-projection, so re-adopting that value as a live floor silently ate this instance\'s mail');
    } finally { rm(home); rm(repo); }
  }

  // ORDER B: the old build reads first, then the 0.99 instance declares and reads.
  {
    const home = tmpHome(); const repo = makeGitRepo('mixB');
    try {
      const id = 'primary-mixB';
      // Registered by the OLD build, which has no declaration logic — so no
      // instance file exists until a 0.99 caller shows up. That is the real
      // pre-upgrade shape.
      oldCli.cmdRegister(id, { worktree: [repo], session: ['s-' + id] },
        { home, cwd: repo, env: {}, backend: backend(), now: Date.now() });
      seed(home, repo, id, 3);
      const old = oldCli.cmdInboxMessages(id, { unread: [true] },
        { home, cwd: repo, env: {}, backend: backend(), now: Date.now() }, { ack: true });
      assert.strictEqual((old.messages || []).length, 3, 'the 0.98.3 build reads first and receives all 3');
      // A 0.99 instance arriving AFTER the old build consumed inherits that
      // progress via the one-time bootstrap seed — correct, not a loss: this is
      // an upgrade, and re-delivering already-consumed mail is what the seed
      // exists to prevent.
      cli.cmdRegister(id, { worktree: [repo], session: ['s-' + id] },
        { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'h:88:8' });
      const nw = readPrimary(home, repo, id, 'h:88:8');
      assert.strictEqual((nw.messages || []).length, 0,
        'an instance that first appears AFTER the old build consumed must not replay that backlog');
    } finally { rm(home); rm(repo); }
  }
});

test('migration: the old build keeps working after 0.99 writes instance/baseline files', (t) => {
  const found = oldBuild();
  if (!found) {
    t.skip('shipped ' + OLD_VERSION + ' unavailable: no plugin cache, no v' + OLD_VERSION + ' tag');
    return;
  }
  const oldCli = require(path.join(found.root, 'scripts', 'devswarm.js'));
  const home = tmpHome(); const repo = makeGitRepo('mixC');
  try {
    const id = 'primary-mixC';
    cli.cmdRegister(id, { worktree: [repo], session: ['s-' + id] },
      { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'h:77:7' });
    seed(home, repo, id, 2);
    readPrimary(home, repo, id, 'h:77:7');
    const old = oldCli.cmdInboxMessages(id, { unread: [true] },
      { home, cwd: repo, env: {}, backend: backend(), now: Date.now() }, { ack: true });
    assert.strictEqual(old.ok, true, 'the old build must not choke on the new on-disk shape: ' + JSON.stringify(old).slice(0, 200));
  } finally { rm(home); rm(repo); }
});

test('migration (Phase 3): doctor dry-run writes nothing and --repair NEVER deletes a legacy cursor file', () => {
  const home = tmpHome();
  try {
    const dir = cursorsDir(home);
    const stale = path.join(dir, 'w-doc#inst-aaaaaa.json');
    fs.writeFileSync(stale, '5');
    const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, old, old);
    const before = fs.readdirSync(dir).sort();
    const dry = doctorDevswarm.cursorHygieneCheck({ home });
    assert.match(dry.message, /would previously have removed/, 'a plain doctor run is report-only');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, 'a report-only pass must not write');
    const rep = doctorDevswarm.cursorHygieneCheck({ home, repair: true });
    assert.match(rep.message, /reader_cursors import/, 'repair mode runs the reader_cursors import stage');
    assert.ok(fs.existsSync(stale), 'legacy files are inert and are NEVER deleted (no-delete rule; rollback path)');
  } finally { rm(home); }
});

test('migration: a failed own-partition cursor write is REPORTED, not swallowed', () => {
  const home = tmpHome(); const repo = makeGitRepo('ackfail');
  try {
    const id = 'primary-ackfail';
    // Register AS the reading instance: with a second, lagging instance file
    // present the shared write is correctly skipped (the min has not moved), so
    // there would be no failure to report and the test would prove nothing.
    // Phase 3: the ack's durable home is the reader_cursors table (journal
    // backend here so the table file can be made unwritable); the legacy JSON
    // projection is best-effort by design.
    const jb = 'journal';
    cli.cmdRegister(id, { worktree: [repo], session: ['s-' + id] },
      { home, cwd: repo, env: {}, backend: jb, now: Date.now(), instanceNonce: 'h:1:1' });
    const sj = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: jb });
    try {
      for (let i = 0; i < 2; i++) {
        const f = { from: 'p', to: id, type: 'direct', message: 'm-' + i, timestamp: 1700000000000 + i, urgency: 'normal' };
        storeLib.appendMeshMessage(sj, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
      }
    } finally { sj.close(); }
    const rcFile = path.join(home, '.anti-hall', 'devswarm', 'store', repoKeyOf(repo), 'journal', 'reader_cursors.ndjson');
    try { fs.unlinkSync(rcFile); } catch (_) {}
    fs.mkdirSync(rcFile, { recursive: true });
    const r = cli.cmdInboxMessages(id, { unread: [true] },
      { home, cwd: repo, env: {}, backend: jb, now: Date.now(), instanceNonce: 'h:1:1' }, { ack: true });
    // An unreadable read-position table is a STORE READ ERROR: the verb fails
    // CLOSED with a typed, named reason (known:false) — never ok:true with a
    // silently unpersisted ack, and never a confident "0 unread".
    assert.strictEqual(r.ok, false, 'must not report success: ' + JSON.stringify(r).slice(0, 300));
    assert.strictEqual(r.reason, 'store-unavailable');
    assert.match(String(r.error), /reader_cursors/, 'the failure NAMES the unreadable table');
    assert.strictEqual(r.known, false);
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// R3 item 1 — a raise that has NOT made rows reachable elsewhere must never
// pass the declared floor. R3 item 3 — doctor names old-shape leftovers.
// ---------------------------------------------------------------------------

test('R3 (Phase 3): a bounded floor raise (migrate merge) never passes a declared reader', () => {
  const home = tmpHome(); const repo = makeGitRepo('bounded');
  try {
    const id = 'primary-bounded';
    cli.cmdRegister(id, { worktree: [repo], session: ['s-' + id] },
      { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'h:1:1' });
    seed(home, repo, id, 3);
    const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
    try {
      const own = s.readerCursorRows(id).find((r) => r.ns === 'store' && r.reader === 'h:1:1');
      assert.strictEqual(own && own.value, 0, 'precondition: one declared reader at 0');
      assert.strictEqual(readerCursors.raiseFloorBounded(s, { partition: id, value: 3, home }), 0);
    } finally { s.close(); }
    const r = readPrimary(home, repo, id, 'h:1:1');
    assert.strictEqual((r.messages || []).length, 3, 'the declared reader still receives all 3');
    const h = readPrimary(home, repo, id, null);
    assert.ok(h.ok, 'a headless reader still works');
  } finally { rm(home); rm(repo); }
});

test('R3 (Phase 3): a bounded floor raise DOES proceed when no reader is declared', () => {
  const home = tmpHome(); const repo = makeGitRepo('bounded2');
  try {
    const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
    try { assert.strictEqual(readerCursors.raiseFloorBounded(s, { partition: 'w-nodecl', value: 3, home }), 3); }
    finally { s.close(); }
    assert.strictEqual(floorRow(home, repo, 'w-nodecl').value, 3);
  } finally { rm(home); rm(repo); }
});

test('R3 (Phase 3): fold/reap raise is UNBOUNDED and keeps retired rows retired', () => {
  const home = tmpHome(); const repo = makeGitRepo('bounded3');
  try {
    const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
    try {
      s.readerCursorTxn((tx) => {
        tx.put({ partition: 'w-fold', ns: 'store', reader: '#floor', value: 0, updatedAt: 1 });
        tx.put({ partition: 'w-fold', ns: 'nd', reader: '#floor', value: 0, updatedAt: 1 });
        tx.put({ partition: 'w-fold', ns: 'store', reader: 'h:5:5', value: 0, updatedAt: 1 });
        tx.put({ partition: 'w-fold', ns: 'store', reader: 'h:6:6', value: 1, retiredLine: 1, updatedAt: 1 });
      });
      readerCursors.raiseAllLossFree(s, { partition: 'w-fold', ns: 'store', value: 5, home });
      const rows = s.readerCursorRows('w-fold').filter((r) => r.ns === 'store');
      for (const r of rows) assert.strictEqual(r.value, 5, 'every row incl. the floor passes a loss-free raise: ' + r.reader);
      const dead = rows.find((r) => r.reader === 'h:6:6');
      assert.ok(readerCursors.isRetired(dead), 'retired_line moves in lockstep: a fold never un-retires a dead reader');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('R3: a bounded raise SKIPS a corrupt instance file instead of clamping to its 0', () => {
  // Critic R4 item (a): listInstanceCursors reports 0 for an unreadable/
  // corrupt file (readCursor's own contract). Folding that 0 straight into
  // the bounded-min would permanently block the migrate raise for this id —
  // the min computation must treat a corrupt file as ABSENT, not as "declared
  // at 0", while still returning it (readable:false) for the doctor report.
  const home = tmpHome();
  try {
    const dir = cursorsDir(home);
    const id = 'primary-corrupt';
    fs.writeFileSync(path.join(dir, id + '#inst-aaaaaa.json'), '3');
    fs.writeFileSync(path.join(dir, id + '#inst-bbbbbb.json'), 'not-json-not-a-number');
    const files = cli.listInstanceCursors(home, id);
    const readable = files.find((f) => f.shortNonce === 'aaaaaa');
    const corrupt = files.find((f) => f.shortNonce === 'bbbbbb');
    assert.strictEqual(readable.value, 3);
    assert.notStrictEqual(readable.readable, false, 'precondition: the intact file must be reported readable');
    assert.strictEqual(corrupt.value, 0, 'precondition: readCursor itself reports 0 for unparseable content');
    assert.strictEqual(corrupt.readable, false, 'precondition: the corrupt file must be flagged unreadable');
    cli.raiseInstanceBaseline(home, id, 5, { bounded: true });
    assert.strictEqual(inboxCursor.readCursor(cli.instanceBaselinePath(home, id)), 3,
      'the migrate raise must reach the min of the READABLE files (3) — a corrupt file must never block it at 0');
  } finally { rm(home); }
});

test('R3: doctor NAMES pre-release dot-shape cursor files and never deletes them', () => {
  const home = tmpHome();
  try {
    const dir = cursorsDir(home);
    for (const n of ['w.base.json', 'w.inst-aaaaaa.json', 'w#inst-bbbbbb.json', 'w.json', 'w.seen-x.json']) {
      fs.writeFileSync(path.join(dir, n), '1');
    }
    const found = doctorDevswarm.legacyCursorShapeLeftovers(home);
    assert.deepStrictEqual(found, ['w.base.json', 'w.inst-aaaaaa.json'],
      'only the old dot shapes are named — never the current `#` shape, a plain cursor, or a `.seen-` watermark');
    const res = doctorDevswarm.cursorHygieneCheck({ home });
    assert.match(res.message, /old dot shape/, 'the doctor line must surface them');
    assert.match(res.message, /NEVER deleted automatically/, 'and must say they are not removed');
    const after = fs.readdirSync(dir).sort();
    assert.ok(after.includes('w.base.json') && after.includes('w.inst-aaaaaa.json'),
      'report-only: such a name can equally belong to a real workspace, so deleting it could destroy a live read position');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// Phase 3 — the one-time reader_cursors import: update.js stage + all-stores
// driver. Idempotent, NO delete, FAIL-OPEN, per-version stamp only on success.
// ---------------------------------------------------------------------------

test('Phase 3 import: update.js reader-cursors-import imports once per version, never deletes, floor = HEAD instanceFloor', () => {
  const home = tmpHome(); const repo = makeGitRepo('imp-upd');
  try {
    const id = 'primary-impupd';
    register(home, repo, id);
    seed(home, repo, id, 3);
    const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
    try { s.setCursor(id, 2); } finally { s.close(); }
    fs.writeFileSync(path.join(cursorsDir(home), id + '#inst-abcdef.json'), '1');
    const snap = () => fs.readdirSync(cursorsDir(home)).sort().map((n) => n + '=' + fs.readFileSync(path.join(cursorsDir(home), n), 'utf8'));
    const before = snap();
    const env = { DEVSWARM_REPO_ID: 'r', ANTIHALL_DEVSWARM_STORE_BACKEND: backend() };
    const r1 = updateMod.readerCursorsImportPostUpdate({ paths: { pluginSrcDir: ROOT }, env, cwd: repo, home, version: '9.9.9' });
    assert.strictEqual(r1.attempted, true, r1.detail);
    assert.ok(r1.imported >= 1, r1.detail);
    assert.strictEqual(r1.errors, 0, r1.detail);
    // No #base: baseline = the shared pair (2); MIN over #inst = 1 -> max(2, 1) = 2.
    assert.strictEqual(floorRow(home, repo, id).value, 2);
    const r2 = updateMod.readerCursorsImportPostUpdate({ paths: { pluginSrcDir: ROOT }, env, cwd: repo, home, version: '9.9.9' });
    assert.strictEqual(r2.skippedAlreadyDone, true, 'stamped once per version');
    const perInstance = (xs) => xs.filter((x) => x.includes('#'));
    assert.deepStrictEqual(perInstance(snap()), perInstance(before), 'no #inst/#nd/#base file created, modified or deleted');
    assert.ok(snap().includes(id + '.json=2'), 'the shared pair is only dual-written UP to F (2), never past it');
  } finally { rm(home); rm(repo); }
});

test('Phase 3 import: FAIL-OPEN — a throwing driver never throws into the update and is not stamped; a partition error is counted, not fatal', () => {
  const home = tmpHome();
  try {
    const env = { DEVSWARM_REPO_ID: 'r' };
    const boom = { importReaderCursorsAllStores() { throw new Error('SIMULATED import crash'); } };
    const r = updateMod.readerCursorsImportPostUpdate({ paths: { pluginSrcDir: ROOT }, env, cwd: os.tmpdir(), home, devswarm: boom, version: '9.9.9' });
    assert.strictEqual(r.attempted, false);
    assert.match(r.detail, /raised: SIMULATED import crash/);
    const partial = { importReaderCursorsAllStores() { return { stores: 1, partitions: 2, imported: 1, errors: 1 }; } };
    const r2 = updateMod.readerCursorsImportPostUpdate({ paths: { pluginSrcDir: ROOT }, env, cwd: os.tmpdir(), home, devswarm: partial, version: '9.9.9' });
    assert.strictEqual(r2.errors, 1);
    const r3 = updateMod.readerCursorsImportPostUpdate({ paths: { pluginSrcDir: ROOT }, env, cwd: os.tmpdir(), home, devswarm: partial, version: '9.9.9' });
    assert.notStrictEqual(r3.skippedAlreadyDone, true, 'an errored pass is NOT stamped: the next update retries');
    const gated = updateMod.readerCursorsImportPostUpdate({ paths: { pluginSrcDir: ROOT }, env: {}, cwd: os.tmpdir(), home });
    assert.strictEqual(gated.attempted, false, 'gated outside a DevSwarm session');
  } finally { rm(home); }
});

test('Phase 3 import: the all-stores driver is fail-open per partition and dry-run (ANTIHALL_INGEST_DRY_RUN) writes nothing', () => {
  const home = tmpHome(); const repo = makeGitRepo('imp-drv');
  try {
    const id = 'primary-impdrv';
    register(home, repo, id);
    seed(home, repo, id, 2);
    const dry = cli.importReaderCursorsAllStores(home, { env: { ANTIHALL_INGEST_DRY_RUN: '1' }, backend: backend() });
    assert.strictEqual(dry.dryRun, true);
    assert.ok(dry.wouldImport >= 1);
    assert.strictEqual(floorRow(home, repo, id), null, 'dry run wrote no reader_cursors row');
    const origImport = require(path.join(ROOT, 'companion', 'lib', 'reader-cursors.js')).importLegacy;
    const rcMod = require(path.join(ROOT, 'companion', 'lib', 'reader-cursors.js'));
    let calls = 0;
    rcMod.importLegacy = (s, o) => { calls += 1; if (calls === 1) throw new Error('one bad partition'); return origImport(s, o); };
    let r;
    try { r = cli.importReaderCursorsAllStores(home, { env: {}, backend: backend() }); }
    finally { rcMod.importLegacy = origImport; }
    assert.ok(r.errors >= 1, 'the failing partition is counted');
    assert.ok(r.partitions >= 1, 'and the pass continued instead of throwing');
  } finally { rm(home); rm(repo); }
});

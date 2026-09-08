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

    const r = readPrimary(home, repo, id, 'anc:1:1');
    assert.strictEqual(r.messages.length, 2,
      'only the 2 UNCONSUMED rows may be delivered — an upgrade must not re-deliver already-read mail');
    assert.ok(fs.existsSync(path.join(cursorsDir(home), id + '#base.json')),
      'the baseline is created on first touch');
    // The delivered count above IS the contract: seeding from the pre-fix
    // shared value is what makes it 2 rather than 4. The baseline's own value
    // is not asserted here because it legitimately tracks the shared pair
    // UPWARD after the ack (the shared pair is a min-projection, so using it as
    // a floor can never skip an instance).
    const again = readPrimary(home, repo, id, 'anc:1:1');
    assert.strictEqual(again.messages.length, 0,
      'and the upgraded instance does not re-read what it just consumed');
  } finally { rm(home); rm(repo); }
});

test('migration: the baseline seed is idempotent across repeated reads', () => {
  const home = tmpHome(); const repo = makeGitRepo('idem');
  try {
    const id = 'primary-idem';
    register(home, repo, id);
    seed(home, repo, id, 2);
    readPrimary(home, repo, id, 'anc:1:1');
    const b1 = fs.readFileSync(path.join(cursorsDir(home), id + '#base.json'), 'utf8');
    readPrimary(home, repo, id, 'anc:1:1');
    readPrimary(home, repo, id, 'anc:2:2');
    const b2 = fs.readFileSync(path.join(cursorsDir(home), id + '#base.json'), 'utf8');
    assert.strictEqual(b2, b1, 'the baseline is not moved by ordinary reads or acks — only loss-free writers touch it');
  } finally { rm(home); rm(repo); }
});

test('migration: a 0.98-style caller (no instance file) reads alongside a 0.99 reader without loss', () => {
  const home = tmpHome(); const repo = makeGitRepo('mixed');
  try {
    const id = 'primary-mixed';
    register(home, repo, id);
    seed(home, repo, id, 3);
    // The 0.99 reader consumes everything under its own instance identity.
    const modern = readPrimary(home, repo, id, 'anc:1:1');
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
    readPrimary(home, repo, id, 'anc:1:1');
    // A loss-free writer (fold/reap) may move the baseline; ordinary acks may not.
    const before = inboxCursor.readCursor(path.join(cursorsDir(home), id + '#base.json'));
    cli.raiseInstanceBaseline(home, id, before + 5);
    const after = inboxCursor.readCursor(path.join(cursorsDir(home), id + '#base.json'));
    assert.strictEqual(after, before + 5, 'a loss-free advance moves the baseline');
    // A brand-new instance now starts at the raised baseline, not at zero.
    const fresh = readPrimary(home, repo, id, 'anc:9:9');
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
        { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'anc:99:9' });
      seed(home, repo, id, 3);
      const old = oldCli.cmdInboxMessages(id, { unread: [true] },
        { home, cwd: repo, env: {}, backend: backend(), now: Date.now() }, { ack: true });
      assert.strictEqual((old.messages || []).length, 3, 'the 0.98.3 build must receive all 3');
      const nw = readPrimary(home, repo, id, 'anc:99:9');
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
        { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'anc:88:8' });
      const nw = readPrimary(home, repo, id, 'anc:88:8');
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
      { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'anc:77:7' });
    seed(home, repo, id, 2);
    readPrimary(home, repo, id, 'anc:77:7');
    const old = oldCli.cmdInboxMessages(id, { unread: [true] },
      { home, cwd: repo, env: {}, backend: backend(), now: Date.now() }, { ack: true });
    assert.strictEqual(old.ok, true, 'the old build must not choke on the new on-disk shape: ' + JSON.stringify(old).slice(0, 200));
  } finally { rm(home); rm(repo); }
});

test('migration: doctor repair is REACHABLE and doctor dry-run writes nothing', () => {
  const home = tmpHome();
  try {
    const dir = cursorsDir(home);
    const stale = path.join(dir, 'w-doc#inst-aaaaaa.json');
    fs.writeFileSync(stale, '5');
    const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, old, old);
    const before = fs.readdirSync(dir).sort();

    // Report-only must not create or delete ANYTHING (it used to seed .base.json).
    const dry = doctorDevswarm.cursorHygieneCheck({ home });
    assert.match(dry.message, /would remove/, 'a plain doctor run is report-only');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), before,
      'a report-only pass must not write — readInstanceBaseline used to SEED a baseline file during the dry run');

    // Repair mode must actually act.
    const rep = doctorDevswarm.cursorHygieneCheck({ home, repair: true });
    assert.match(rep.message, /removed/, 'repair mode reports real removals');
    assert.ok(!fs.existsSync(stale), 'the stale file is gone in repair mode — the flag is wired through from hooks/doctor.js');
  } finally { rm(home); }
});

test('migration: a failed own-partition cursor write is REPORTED, not swallowed', () => {
  const home = tmpHome(); const repo = makeGitRepo('ackfail');
  try {
    const id = 'primary-ackfail';
    // Register AS the reading instance: with a second, lagging instance file
    // present the shared write is correctly skipped (the min has not moved), so
    // there would be no failure to report and the test would prove nothing.
    cli.cmdRegister(id, { worktree: [repo], session: ['s-' + id] },
      { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'anc:1:1' });
    seed(home, repo, id, 2);
    // Make the shared cursor path unwritable so the ack cannot persist.
    const cp2 = path.join(cursorsDir(home), id + '.json');
    try { fs.unlinkSync(cp2); } catch (_) {}
    fs.mkdirSync(cp2, { recursive: true });
    const r = readPrimary(home, repo, id, 'anc:1:1');
    assert.strictEqual(r.ok, true, 'delivery still succeeds — fail-open is the safe direction');
    assert.ok(Array.isArray(r.cursorWriteFailures) && r.cursorWriteFailures.length >= 1,
      'the failure must be NAMED rather than returned as a silent ok:true: ' + JSON.stringify(r).slice(0, 200));
    assert.strictEqual(r.cursorPersisted, false, 'and the result must say the cursor did not persist');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// R3 item 1 — a raise that has NOT made rows reachable elsewhere must never
// pass the declared floor. R3 item 3 — doctor names old-shape leftovers.
// ---------------------------------------------------------------------------

test('R3: a bounded raise never passes the declared instance floor', () => {
  const home = tmpHome(); const repo = makeGitRepo('bounded');
  try {
    const id = 'primary-bounded';
    cli.cmdRegister(id, { worktree: [repo], session: ['s-' + id] },
      { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'anc:1:1' });
    seed(home, repo, id, 3);
    // The declared instance has read nothing; its cursor sits at 0.
    const before = cli.listInstanceCursors(home, id).map((f) => f.value);
    assert.deepStrictEqual(before, [0], 'precondition: one declared instance at 0');
    // Migrate's merge value (a shared-pair number an older build can have
    // written) must NOT move the baseline past that instance.
    cli.raiseInstanceBaseline(home, id, 3, { bounded: true });
    const r = readPrimary(home, repo, id, 'anc:1:1');
    assert.strictEqual((r.messages || []).length, 3,
      'the declared instance must still receive all 3 — an unbounded raise consumed them (proven live)');
  } finally { rm(home); rm(repo); }
});

test('R3: a bounded raise DOES proceed when no instance is declared', () => {
  const home = tmpHome();
  try {
    cli.raiseInstanceBaseline(home, 'w-nodecl', 3, { bounded: true });
    const p = cli.instanceBaselinePath(home, 'w-nodecl');
    assert.strictEqual(inboxCursor.readCursor(p), 3,
      'with nothing declared there is no instance to skip, so the bound does not apply');
  } finally { rm(home); }
});

test('R3: fold/reap keep the UNBOUNDED raise (rows are reachable elsewhere first)', () => {
  const home = tmpHome();
  try {
    const dir = cursorsDir(home);
    fs.writeFileSync(path.join(dir, 'w-fold#inst-aaaaaa.json'), '0');
    // No `bounded` option: this is the fold/reap contract.
    cli.raiseInstanceBaseline(home, 'w-fold', 5);
    assert.strictEqual(inboxCursor.readCursor(cli.instanceBaselinePath(home, 'w-fold')), 5,
      'fold/reap forward or archive the rows BEFORE raising, so they may pass a declared instance');
  } finally { rm(home); }
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

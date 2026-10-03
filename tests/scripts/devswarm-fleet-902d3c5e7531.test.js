'use strict';
// Regression test for defect 902d3c5e7531 (P1, field-reported): a child's
// `inbox read-primary` reported unread count 0 while a real message sat
// unreachable — the read looked complete (`ok:true`, `known` absent/true)
// with no signal that mesh-group enumeration had failed or the store side
// was unreadable. Root cause: `count`/`read`'s own `known` formula was
// `union.known && !storeUnavailable` alone (never folded in
// meshGroupUnresolved), and `messages`/`read-primary`/`peek-primary` carried
// NO known/repoKey/storePath/withheld-state fields at all.
//
// Fix under test (scripts/devswarm.js):
//   - readSideMeta(ctx, home, storeHandle, id) -> {repoKey, storePath, cwd},
//     threaded into count/read/messages/read-primary/peek-primary output.
//   - readSideKnown(rawKnown, withheld) -> known is false whenever
//     storeUnavailable OR meshGroupUnresolved OR meshGroupError OR
//     totalsPartial — folded into count/read/messages' own `known`.
//   - emitKnownWarning(argv, result) -> one stderr WARNING line whenever a
//     CLI `inbox` result reports known:false, naming the reason.
//
// Points at ANTIHALL_TEST_PLUGIN_ROOT (a `plugins/anti-hall`-shaped tree) so
// this SAME file proves RED against HEAD (pre-fix) and GREEN against the
// live, already-fixed working tree without duplication. Defaults to the
// real repo tree (the current, already-patched working copy).

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

const cliPath = path.join(ROOT, 'scripts', 'devswarm.js');
if (!fs.existsSync(cliPath)) {
  throw new Error('ANTIHALL_TEST_PLUGIN_ROOT=' + JSON.stringify(ROOT) + ' is not a plugins/anti-hall-shaped tree — expected to find ' + cliPath);
}
const cli = require(cliPath);
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-902d3c5e7531-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-902d3c5e7531-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function register(home, repoDir, id, sessionId) {
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const r = cli.run(
    ['register', id, '--worktree', repoDir, '--session', sessionId || ('s-' + id), '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, { cwd: repoDir })
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
  return { inboxPath, cursorPath };
}

function seedPartition(home, repoDir, toId, rows) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  assert.ok(repoKey, 'repoKey must resolve for a real git repo');
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    for (const row of rows) {
      const fields = { from: row.from || 'sender', to: toId, type: 'direct', urgency: 'normal', message: row.body, timestamp: row.ts };
      const hash = storeLib.meshMessageHash(fields);
      storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash }));
    }
  } finally { s.close(); }
  return repoKey;
}

// ---- B1: repoKey/storePath/cwd present on the ordinary, healthy path -----

test('B1: inbox count/read/messages/read-primary/peek-primary all carry repoKey/storePath/cwd/known', () => {
  const home = tmpHome();
  const repo = makeGitRepo('healthy');
  try {
    register(home, repo, 'solo-id');
    seedPartition(home, repo, 'solo-id', [{ body: 'm1', ts: 1000 }]);

    for (const args of [
      ['inbox', 'count', 'solo-id'],
      ['inbox', 'read', 'solo-id'],
      ['inbox', 'messages', 'solo-id'],
      ['inbox', 'peek-primary', 'solo-id'],
    ]) {
      const r = cli.run(args, ctx(home, { cwd: repo })).result;
      assert.equal(r.ok, true, args.join(' ') + ' -> ' + JSON.stringify(r));
      assert.equal(typeof r.repoKey, 'string', args.join(' ') + ' missing repoKey');
      assert.equal(typeof r.storePath, 'string', args.join(' ') + ' missing storePath');
      assert.equal(typeof r.cwd, 'string', args.join(' ') + ' missing cwd');
      assert.equal(r.known, true, args.join(' ') + ' should be known:true on a healthy read');
      assert.equal(r.storeUnavailable, false);
      assert.equal(r.meshGroupUnresolved, false);
      assert.equal(r.meshGroupError, null);
      assert.ok(Array.isArray(r.meshPartitionIds), args.join(' ') + ' missing meshPartitionIds');
    }

    // read-primary acks — run it last so it does not consume the mail the
    // other (non-acking) verbs above still need to see.
    const rp = cli.run(['inbox', 'read-primary', 'solo-id'], ctx(home, { cwd: repo })).result;
    assert.equal(rp.ok, true, JSON.stringify(rp));
    assert.equal(typeof rp.repoKey, 'string');
    assert.equal(typeof rp.storePath, 'string');
    assert.equal(rp.known, true);
  } finally { rm(home); rm(repo); }
});

// ---- B1: known:false when the store side is genuinely unreadable ---------

test('B1: a cross-project store-unavailable read reports known:false, repoKey/storePath/cwd still present, and the CLI emits one stderr WARNING', () => {
  const home = tmpHome();
  const repoA = makeGitRepo('a');
  const repoB = makeGitRepo('b');
  try {
    // Register under repoA's project, then read from repoB's cwd — a
    // positive cross-project mismatch (project-context-mismatch), the
    // documented storeUnavailable shape.
    register(home, repoA, 'cross-id');
    seedPartition(home, repoA, 'cross-id', [{ body: 'm1', ts: 1000 }]);

    const r = cli.run(['inbox', 'read-primary', 'cross-id', '--ack-as-owner'], ctx(home, { cwd: repoB })).result;
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.known, false, 'known must be false when the read cannot be trusted');
    assert.equal(r.reason, 'project-context-mismatch', 'reason must be the REAL, specific refusal reason');
    assert.equal(typeof r.repoKey, 'string', 'B1 meta must be present even on a refusal');
    // fl-wave3 fix (item 4): a refusal never opened any real store on this
    // call's behalf — `storePath` must be null, never a misleading path this
    // call did not actually read. `registeredRepoKey` names the project the
    // workspace IS registered under instead.
    assert.strictEqual(r.storePath, null, 'a refused open must report storePath:null, not a store this call never opened');
    const repoKeyA = repokey.repoKeyForWorktree(repoA);
    assert.equal(r.registeredRepoKey, repoKeyA, 'the refusal must name the project the workspace is REALLY registered under');
    assert.equal(typeof r.cwd, 'string');
    assert.ok(Array.isArray(r.meshPartitionIds));
    // fl-wave3 fix (item 2): storeUnavailable must be true ONLY for the
    // literal 'store-unavailable' reason — a project-context-mismatch
    // refusal is a different, more specific reason and must NOT be folded
    // into the generic storeUnavailable bucket (which would otherwise
    // swallow the real reason in the WARNING line below).
    assert.strictEqual(r.storeUnavailable, false,
      'storeUnavailable must be false for a project-context-mismatch refusal — the WARNING must name the real reason instead');

    // emitKnownWarning: the CLI's own stderr warning line for known:false.
    const originalWrite = process.stderr.write;
    let captured = '';
    process.stderr.write = (chunk) => { captured += String(chunk); return true; };
    let line = null;
    try {
      line = cli.emitKnownWarning(['inbox', 'read-primary', 'cross-id'], r);
    } finally { process.stderr.write = originalWrite; }
    assert.equal(typeof line, 'string', 'emitKnownWarning must return the line it wrote');
    assert.match(line, /WARNING/);
    assert.match(line, /known:false/);
    // fl-wave3 fix (item 2): the WARNING must name the REAL reason
    // ('project-context-mismatch'), not the generic 'storeUnavailable'
    // bucket a truthy storeUnavailable used to force it into.
    assert.match(line, /project-context-mismatch/, 'the WARNING must name the real, specific refusal reason');
    assert.doesNotMatch(line, /storeUnavailable/, 'the WARNING must not fall back to the generic storeUnavailable bucket when a specific reason is known');
    assert.equal(captured.trim(), line, 'the exact line must have been written to stderr');

    // A healthy call must NOT emit a warning.
    const healthy = cli.run(['inbox', 'count', 'cross-id'], ctx(home, { cwd: repoA })).result;
    assert.equal(cli.emitKnownWarning(['inbox', 'count', 'cross-id'], healthy), null, 'no warning on a known:true result');
  } finally { rm(home); rm(repoA); rm(repoB); }
});

// ---------------------------------------------------------------------------
// fl-wave6 fix (P1, item 1): `count`/`read` (unlike `read-primary`) never
// return `ok:false` on a project-context-mismatch — they fail OPEN (the
// NDJSON side is still reported) and report the store side as
// `storeUnavailable:false` (project-context-mismatch is NOT a genuine
// store-unavailable reason — storeUnavailableOut's isGenuineStoreUnavailable-
// Reason gate) with the real reason living ONLY under
// `storeUnavailableDetail.reason` — no top-level `result.reason` at all on
// this ok:true path. Pre-fix, `emitKnownWarning`'s whole reason-detection
// block was gated on the `storeUnavailable` BOOLEAN, so this exact shape
// fell through every branch and printed the useless
// "known:false (unknown)" line. This test captures stderr for BOTH `count`
// and `read` (not just `read-primary`, which already had a top-level
// `result.reason` and never hit the bug) on a foreign cwd.
// ---------------------------------------------------------------------------
test('B1/P1: `inbox count` and `inbox read` (not just read-primary) on a foreign cwd emit a WARNING naming project-context-mismatch, never "unknown"', () => {
  const home = tmpHome();
  const repoA = makeGitRepo('countread-a');
  const repoB = makeGitRepo('countread-b');
  try {
    register(home, repoA, 'countread-id');
    seedPartition(home, repoA, 'countread-id', [{ body: 'm1', ts: 1000 }]);

    for (const sub of ['count', 'read']) {
      const r = cli.run(['inbox', sub, 'countread-id'], ctx(home, { cwd: repoB })).result;
      // count/read fail OPEN on a project-context-mismatch (unlike
      // read-primary, which refuses with ok:false) — assert the actual,
      // verified shape rather than assuming symmetry with read-primary.
      assert.equal(r.ok, true, ['inbox', sub, 'countread-id'].join(' ') + ' -> ' + JSON.stringify(r));
      assert.equal(r.known, false, sub + ': known must be false — the store side could not be trusted');
      assert.equal(r.storeUnavailable, false, sub + ': storeUnavailable must stay false for a non-genuine (project-context-mismatch) refusal');
      assert.equal(typeof r.reason, 'undefined', sub + ': count/read carry no top-level `reason` on this ok:true path — only storeUnavailableDetail.reason');
      assert.ok(r.storeUnavailableDetail, sub + ': storeUnavailableDetail must be present');
      assert.equal(r.storeUnavailableDetail.reason, 'project-context-mismatch', sub + ': storeUnavailableDetail.reason must name the real refusal');

      const originalWrite = process.stderr.write;
      let captured = '';
      process.stderr.write = (chunk) => { captured += String(chunk); return true; };
      let line = null;
      try {
        line = cli.emitKnownWarning(['inbox', sub, 'countread-id'], r);
      } finally { process.stderr.write = originalWrite; }
      assert.equal(typeof line, 'string', sub + ': a known:false result must emit a WARNING line');
      assert.match(line, /known:false/, sub);
      assert.match(line, /project-context-mismatch/, sub + ': the WARNING must name the real reason, not fall through to "unknown"; line=' + line);
      assert.doesNotMatch(line, /\(unknown\)/, sub + ': must never print the useless "(unknown)" fallback when the real reason is known; line=' + line);
      assert.equal(captured.trim(), line, sub + ': the exact line must have been written to stderr');
    }
  } finally { rm(home); rm(repoA); rm(repoB); }
});

// ---------------------------------------------------------------------------
// fl-wave4 fix (item 2, "silent zero on a broken store"): a store that
// EXISTS but cannot be READ (EACCES on the store dir, ENOTDIR on a journal
// path replaced by a regular file, an unparseable sqlite header) used to be
// silently indistinguishable from a genuinely empty/never-written store —
// readAll() (devswarm-store.js, journal backend) swallowed EVERY fs error
// identically, and the sqlite backend's own open failure was an unwrapped
// raw exception the CLI's cmdInbox `count`/`read` mapped to the generic
// 'store-open-failed' reason with no fs-error detail at all.
//
// Fix under test:
//   - devswarm-store.js readAll(): ENOENT stays fail-open ([]); any OTHER fs
//     error is recorded (getReadError()) instead of silently swallowed.
//   - devswarm-store.js openSqlite(): a genuine open failure is wrapped into
//     a typed ESTOREUNAVAILABLE error carrying storeUnavailableReason.
//   - scripts/devswarm.js resolveWorkspaceStoreForRead(): probes
//     getReadError() unconditionally right after opening, and catches an
//     openStore() throw — both map to reason:'store-unavailable' +
//     storeUnavailableReason.
//   - emitKnownWarning names 'store-unavailable (<code>)' instead of the
//     tautological 'storeUnavailable (store-unavailable)'.
// ---------------------------------------------------------------------------

const isWindows = process.platform === 'win32';
// process.getuid is POSIX-only (undefined on win32); uid 0 is root, where
// chmod 000 does not actually deny access to the process itself.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const canChmodTest = !isWindows && !isRoot;

function chmodChecked(p, mode) {
  try { fs.chmodSync(p, mode); return true; } catch (_) { return false; }
}

for (const backend of ['journal', 'sqlite']) {
  (canChmodTest ? test : test.skip)(`B4 (${backend}): a chmod-000 store dir reports known:false / storeUnavailable, with a WARNING naming the real fs error — never a silent empty read`, () => {
    if (backend === 'sqlite' && !storeLib.sqliteAvailable()) return; // feature-detect, same as the rest of this suite's implicit assumptions
    const home = tmpHome();
    const repo = makeGitRepo('chmod000-' + backend);
    let storeDir = null;
    try {
      register(home, repo, 'chmod-id-' + backend);
      seedPartition(home, repo, 'chmod-id-' + backend, [{ body: 'm1', ts: 1000 }]);

      const repoKey = repokey.repoKeyForWorktree(repo);
      storeDir = storeLib.storeDirForHash(home, repoKey);
      assert.ok(fs.existsSync(storeDir), 'the store dir must actually exist before this test locks it down');

      assert.ok(chmodChecked(storeDir, 0o000), 'chmod 000 must succeed as a non-root, non-Windows test user');

      const r = cli.run(['inbox', 'count', 'chmod-id-' + backend], ctx(home, { cwd: repo, backend })).result;
      assert.equal(r.known, false, 'a genuinely unreadable store must report known:false, never look like an empty mailbox: ' + JSON.stringify(r));
      assert.ok(r.storeUnavailable, 'must report storeUnavailable (object or true), not a silent ok read: ' + JSON.stringify(r));

      const line = cli.emitKnownWarning(['inbox', 'count', 'chmod-id-' + backend], r);
      assert.equal(typeof line, 'string', 'a known:false chmod-000 result must emit a WARNING line');
      assert.match(line, /known:false/);
      // fs error codes are plain uppercase (EACCES); node:sqlite's own open
      // failure carries an ERR_-prefixed code with underscores
      // (ERR_SQLITE_ERROR) instead — accept either shape, just never the
      // tautological literal "store-unavailable" itself.
      assert.match(line, /store-unavailable \([A-Z_]+\)/, 'the WARNING must name the real error code, not the tautological "storeUnavailable (store-unavailable)"; line=' + line);
      assert.doesNotMatch(line, /store-unavailable \(store-unavailable\)/, line);
    } finally {
      if (storeDir) chmodChecked(storeDir, 0o755);
      rm(home); rm(repo);
    }
  });
}

test('B4 (journal): the journal dir REPLACED BY A REGULAR FILE (ENOTDIR) reports known:false / storeUnavailable with the real fs error, never a silent empty read', () => {
  const home = tmpHome();
  const repo = makeGitRepo('enotdir-journal');
  try {
    register(home, repo, 'enotdir-id');
    seedPartition(home, repo, 'enotdir-id', [{ body: 'm1', ts: 1000 }]);

    const repoKey = repokey.repoKeyForWorktree(repo);
    const journalDir = storeLib.journalDirForHash(home, repoKey);
    assert.ok(fs.existsSync(journalDir) && fs.statSync(journalDir).isDirectory(), 'the journal dir must exist as a real directory before this test replaces it');

    // Replace the journal DIRECTORY with a plain file — every readAll() call
    // inside it now hits ENOTDIR (a path component that should be a
    // directory is a regular file), not ENOENT.
    fs.rmSync(journalDir, { recursive: true, force: true });
    fs.writeFileSync(journalDir, 'not a directory');

    try {
      const r = cli.run(['inbox', 'count', 'enotdir-id'], ctx(home, { cwd: repo, backend: 'journal' })).result;
      assert.equal(r.known, false, 'ENOTDIR must report known:false, never look like an empty mailbox: ' + JSON.stringify(r));
      assert.ok(r.storeUnavailable, 'must report storeUnavailable: ' + JSON.stringify(r));

      const line = cli.emitKnownWarning(['inbox', 'count', 'enotdir-id'], r);
      assert.equal(typeof line, 'string');
      assert.match(line, /store-unavailable \(ENOTDIR\)/, 'the WARNING must name ENOTDIR specifically; line=' + line);
    } finally {
      fs.rmSync(journalDir, { force: true });
    }
  } finally { rm(home); rm(repo); }
});

test('B4: `read-primary`/`messages`/`peek-primary` (cmdInboxMessages, not just count/read) also report known:false / storeUnavailable on a broken store, not the pre-fix hardcoded storeUnavailable:false', () => {
  const home = tmpHome();
  const repo = makeGitRepo('enotdir-messages');
  try {
    register(home, repo, 'enotdir-msg-id');
    seedPartition(home, repo, 'enotdir-msg-id', [{ body: 'm1', ts: 1000 }]);

    const repoKey = repokey.repoKeyForWorktree(repo);
    const journalDir = storeLib.journalDirForHash(home, repoKey);
    fs.rmSync(journalDir, { recursive: true, force: true });
    fs.writeFileSync(journalDir, 'not a directory');

    try {
      for (const args of [['inbox', 'messages', 'enotdir-msg-id'], ['inbox', 'peek-primary', 'enotdir-msg-id']]) {
        const r = cli.run(args, ctx(home, { cwd: repo, backend: 'journal' })).result;
        assert.equal(r.known, false, args.join(' ') + ' must report known:false on a broken store: ' + JSON.stringify(r));
        assert.ok(r.storeUnavailable, args.join(' ') + ' must report storeUnavailable, not the pre-fix hardcoded false: ' + JSON.stringify(r));
        // fl-wave5 addendum fix (item 9, P2, R4 Reviewer): this call carries
        // no `storeUnavailableDetail`/top-level `reason` (only
        // `storeUnavailableReason`) on this deferred-read-error path — the
        // WARNING must still name the real fs error code instead of the
        // bare, codeless "storeUnavailable".
        const line = cli.emitKnownWarning(args, r);
        assert.equal(typeof line, 'string', args.join(' ') + ' known:false result must emit a WARNING line');
        assert.match(line, /store-unavailable \(ENOTDIR\)/, args.join(' ') + ' WARNING must name the real error code; line=' + line);
      }
    } finally {
      fs.rmSync(journalDir, { force: true });
    }
  } finally { rm(home); rm(repo); }
});

test('B4: a MISSING store dir (never written) stays fail-open — ok/empty, known:true, no WARNING (ENOENT is not a failure)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('missing-store-dir');
  try {
    // No register(), no seedPartition() — the store dir for this repo's
    // repoKey was never created at all. This is the ENOENT case: reading an
    // id that has genuinely never been registered must NOT be conflated with
    // a genuinely broken (unreadable) store.
    const r = cli.run(['inbox', 'count', 'never-registered-id'], ctx(home, { cwd: repo })).result;
    // An id with no descriptor, no registry row, and no messages is refused
    // as 'unregistered-workspace' (FIX 5's existence guard) — a DIFFERENT,
    // pre-existing refusal reason, not the new 'store-unavailable' this fix
    // adds. The key assertion is what it must NEVER be: 'store-unavailable'.
    assert.notEqual(r.reason, 'store-unavailable', 'a never-written store dir (ENOENT) must never be reported as store-unavailable: ' + JSON.stringify(r));
    if (r.storeUnavailable && typeof r.storeUnavailable === 'object') {
      assert.notEqual(r.storeUnavailable.reason, 'store-unavailable', JSON.stringify(r));
    }
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// fl-wave5 fix (item 2): the "no descriptor for this literal id" branch in
// cmdInbox's count/read/ack path (scripts/devswarm.js, ~line 8028) probes
// the store with a bare `try { store.openStore(...) } catch (_) {}` to
// decide between 'unregistered-workspace' (genuinely nothing backs this id)
// and 'no-inbox-path' (a registry-only row). When the probe OPEN ITSELF
// THROWS (EACCES/ENOTDIR/ESTOREUNAVAILABLE — the store could not be
// consulted AT ALL), the catch swallowed it and kept the DEFAULT
// 'unregistered-workspace' reason — telling the operator to "register it
// first" when the real blocker is a store the probe could not even open,
// and neither branch's evidence (hasRegistryRow/hasMessages) was actually
// gathered. Fix: report reason:'store-unavailable', storeUnavailable:true,
// storeUnavailableReason:<code>, known:false instead.
//
// Repro: sqlite backend only — its open is EAGER (openSqlite does
// `fs.mkdirSync(dir, {recursive:true}); new DatabaseSync(...)` synchronously
// at open time, wrapping any failure into a typed ESTOREUNAVAILABLE — see
// this file's own header comment above openSqlite). The journal backend's
// open is LAZY (openJournal creates nothing until an append; every read
// fail-opens via readAll(), observable only through the DEFERRED
// getReadError() probe, never a throw) — so it structurally cannot exercise
// this catch via a bare `try { store.openStore(...) } catch` at open time,
// and is not a valid repro backend for this specific defect. Chmod the
// store ROOT dir (parent of every per-repoKey store dir,
// devswarmRoot(home)/store) to 000 BEFORE any store dir for this repo's
// repoKey exists, so sqlite's own mkdirSync(recursive:true) throws EACCES
// trying to create a brand-new subdir under an inaccessible parent —
// exercising the throw path with NO registered id at all (the
// no-descriptor branch, not resolveWorkspaceStoreForRead's own openStore
// try/catch, which a registered id would hit instead).
// ---------------------------------------------------------------------------
(canChmodTest && storeLib.sqliteAvailable() ? test : test.skip)('item2: a probe-open THROW in the no-descriptor branch reports store-unavailable, never the misleading unregistered-workspace "register it first"', () => {
  const home = tmpHome();
  const repo = makeGitRepo('probe-throw-store-unavailable');
  let storeRoot = null;
  try {
    storeRoot = storeLib.storeRootDir(home);
    fs.mkdirSync(storeRoot, { recursive: true });
    assert.ok(chmodChecked(storeRoot, 0o000), 'chmod 000 on the store root must succeed as a non-root, non-Windows test user');

    // No register() at all — `never-probed-id` has no descriptor, no
    // registry row, and its per-repoKey store dir has never been created
    // (it would be created fresh, under the now-inaccessible parent).
    const r = cli.run(['inbox', 'count', 'never-probed-id'], ctx(home, { cwd: repo, backend: 'sqlite' })).result;
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.known, false, 'a store the probe could not even open must report known:false: ' + JSON.stringify(r));
    assert.equal(r.reason, 'store-unavailable',
      'a probe-open THROW must report store-unavailable, never the misleading unregistered-workspace ("register it first"): ' + JSON.stringify(r));
    assert.equal(r.storeUnavailable, true, JSON.stringify(r));
    assert.equal(typeof r.storeUnavailableReason, 'string', 'storeUnavailableReason must name the real fs error code: ' + JSON.stringify(r));
    assert.doesNotMatch(String(r.error || ''), /register it first/, 'the error text must not tell the operator to register an id whose real blocker is an unopenable store: ' + JSON.stringify(r));
  } finally {
    if (storeRoot) chmodChecked(storeRoot, 0o755);
    rm(home); rm(repo);
  }
});

// ---------------------------------------------------------------------------
// fl-wave6 fix (P2, item 6): the item2 test above only exercises the SQLITE
// backend, whose open is EAGER (openSqlite does `mkdirSync` + `new
// DatabaseSync(...)` synchronously at open time, so a genuinely-unopenable
// store THROWS at open, which the no-descriptor probe's catch block already
// handles). The JOURNAL backend's open is LAZY (openJournal creates nothing
// until an append) — its failures surface only through the DEFERRED
// `getReadError()` probe (readAll() fail-opens a real fs error to `[]`
// rather than throwing), which the probe's try block never consulted. A
// chmod-000 journal dir therefore still fell through to the default
// 'unregistered-workspace' reason ("register it first") — the exact
// misleading outcome item2 already fixed for sqlite, just not for journal.
// ---------------------------------------------------------------------------
(canChmodTest ? test : test.skip)('item6: a chmod-000 JOURNAL store dir in the no-descriptor probe branch reports store-unavailable, never the misleading unregistered-workspace "register it first"', () => {
  const home = tmpHome();
  const repo = makeGitRepo('journal-probe-store-unavailable');
  let storeDir = null;
  try {
    // Register a DIFFERENT id first so this repo's per-repoKey journal store
    // dir actually exists (the probe's own `store.openStore` call keys on
    // `repoKeyForCwd(ctx)` — the whole project, not the literal probed id —
    // so any registered id in this repo creates the SAME bucket the probe
    // for a never-registered id below will open).
    register(home, repo, 'journal-probe-other-id');
    seedPartition(home, repo, 'journal-probe-other-id', [{ body: 'm1', ts: 1000 }]);

    const repoKey = repokey.repoKeyForWorktree(repo);
    storeDir = storeLib.storeDirForHash(home, repoKey);
    assert.ok(fs.existsSync(storeDir), 'the store dir must exist before this test locks it down');
    assert.ok(chmodChecked(storeDir, 0o000), 'chmod 000 on the store dir must succeed as a non-root, non-Windows test user');

    // No register() for THIS id — its own descriptor, registry row, and
    // messages are all genuinely absent; the real blocker is the unreadable
    // store dir the probe hits while trying to gather that evidence.
    const r = cli.run(['inbox', 'count', 'never-probed-journal-id'], ctx(home, { cwd: repo, backend: 'journal' })).result;
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.known, false, 'a store the probe could not read must report known:false: ' + JSON.stringify(r));
    assert.equal(r.reason, 'store-unavailable',
      'a chmod-000 journal store dir must report store-unavailable, never the misleading unregistered-workspace ("register it first"): ' + JSON.stringify(r));
    assert.equal(r.storeUnavailable, true, JSON.stringify(r));
    assert.equal(typeof r.storeUnavailableReason, 'string', 'storeUnavailableReason must name the real fs error code: ' + JSON.stringify(r));
    assert.doesNotMatch(String(r.error || ''), /register it first/, 'the error text must not tell the operator to register an id whose real blocker is an unreadable store: ' + JSON.stringify(r));

    const line = cli.emitKnownWarning(['inbox', 'count', 'never-probed-journal-id'], r);
    assert.equal(typeof line, 'string', 'a known:false result must emit a WARNING line');
    assert.match(line, /store-unavailable \([A-Z_]+\)/, 'the WARNING must name the real error code; line=' + line);
  } finally {
    if (storeDir) chmodChecked(storeDir, 0o755);
    rm(home); rm(repo);
  }
});

// ---------------------------------------------------------------------------
// fl-wave5 addendum fix (item 8, P1, R4 Reviewer): journal backend,
// `registry.ndjson` unreadable (chmod 000) while `messages.ndjson` stays
// readable. `resolveMeshPartitionIds`'s own `meshCandidateRows` ->
// `listRegistry()` call goes through `readAll()`, which FAIL-OPENS a genuine
// fs error to an EMPTY array rather than throwing — so `count`/`read` used
// to report `known:true` (a real EACCES on the registry channel silently
// read as "no mesh siblings", not as a failure) even though the messages
// channel it actually delivered was fine. Fix: probe `getReadError()` AFTER
// the full pipeline (not just the initial open) and, if set, report
// `known:false` / `storeUnavailable:true` / `storeUnavailableReason` /
// `meshGroupUnresolved:true`, with a WARNING naming the real fs error.
// ---------------------------------------------------------------------------
(canChmodTest ? test : test.skip)('item8: registry.ndjson unreadable (chmod 000) while messages.ndjson stays readable reports known:false + a WARNING naming the real fs error', () => {
  const home = tmpHome();
  const repo = makeGitRepo('registry-unreadable');
  let registryFile = null;
  try {
    register(home, repo, 'registry-broken-id');
    seedPartition(home, repo, 'registry-broken-id', [{ body: 'm1', ts: 1000 }]);

    const repoKey = repokey.repoKeyForWorktree(repo);
    const journalDir = storeLib.journalDirForHash(home, repoKey);
    registryFile = path.join(journalDir, 'registry.ndjson');
    assert.ok(fs.existsSync(registryFile), 'registry.ndjson must exist before this test locks it down');
    // Sanity: messages.ndjson stays readable throughout — only the registry
    // channel is broken, proving `count`/`read`'s own message delivery is
    // NOT what catches this failure (that channel is fine).
    const messagesFile = path.join(journalDir, 'messages.ndjson');
    assert.ok(fs.existsSync(messagesFile), 'messages.ndjson must exist as the readable control channel');

    assert.ok(chmodChecked(registryFile, 0o000), 'chmod 000 on registry.ndjson must succeed as a non-root, non-Windows test user');

    for (const args of [['inbox', 'count', 'registry-broken-id'], ['inbox', 'read', 'registry-broken-id']]) {
      const r = cli.run(args, ctx(home, { cwd: repo, backend: 'journal' })).result;
      assert.equal(r.known, false, args.join(' ') + ' must report known:false when registry.ndjson cannot be read, even though messages.ndjson is fine: ' + JSON.stringify(r));
      assert.equal(r.storeUnavailable, true, args.join(' ') + ' must report storeUnavailable:true: ' + JSON.stringify(r));
      assert.equal(typeof r.storeUnavailableReason, 'string', args.join(' ') + ' must name the real fs error code: ' + JSON.stringify(r));
      assert.equal(r.meshGroupUnresolved, true, args.join(' ') + ' must report meshGroupUnresolved:true: ' + JSON.stringify(r));

      const line = cli.emitKnownWarning(args, r);
      assert.equal(typeof line, 'string', args.join(' ') + ' known:false result must emit a WARNING line');
      assert.match(line, /store-unavailable \([A-Z_]+\)/, args.join(' ') + ' WARNING must name the real error code; line=' + line);
    }
  } finally {
    if (registryFile) chmodChecked(registryFile, 0o644);
    rm(home); rm(repo);
  }
});

// ---------------------------------------------------------------------------
// fl-wave7 fix (P1): devswarm-store.js's readAll() used ONE shared
// `lastReadError` slot across every file a store handle reads — a
// SUCCESSFUL read of messages.ndjson (which count/read/messages/read-primary/
// peek-primary all perform) silently CLEARED a still-live EACCES recorded
// moments earlier for registry.ndjson (a DIFFERENT file, read first while
// resolving mesh siblings). Fixed to be per-file (a Map keyed by path).
//
// item8 (above) proved this for count/read via cmdInbox's own
// postPipelineReadError probe (devswarm.js ~8501). This addendum proves the
// SAME underlying store-level bug via TWO paths item8 did not cover:
//   (a) `inbox peek-primary` — routed through the SEPARATE
//       cmdInboxMessagesInner implementation (devswarm.js ~7649,
//       `msgReadError`/`msgStoreUnavailable`), not cmdInbox's own probe.
//   (b) the no-descriptor probe (cmdInbox, ~devswarm.js:8081) for an
//       UNKNOWN id (`ghost`, no descriptor of its own) sharing the SAME
//       repo's registry/messages files as a registered sibling — pre-fix,
//       this probe's own listRegistry() -> messageCount() call sequence hit
//       the identical clear-on-next-read bug and fell back to the default,
//       misleading 'unregistered-workspace' ("register it first") instead
//       of 'store-unavailable'.
// ---------------------------------------------------------------------------
{
  const isWindows2 = process.platform === 'win32';
  const isRoot2 = typeof process.getuid === 'function' && process.getuid() === 0;
  const canChmodTest2 = !isWindows2 && !isRoot2;
  function chmodChecked2(p, mode) {
    try { fs.chmodSync(p, mode); return true; } catch (_) { return false; }
  }

  (canChmodTest2 ? test : test.skip)('fl-wave7 (a): `inbox peek-primary` on a KNOWN id reports known:false/storeUnavailable/EACCES + a WARNING when registry.ndjson is unreadable but messages.ndjson stays readable (was: reported healthy)', () => {
    const home = tmpHome();
    const repo = makeGitRepo('fl-wave7-peek-primary');
    let registryFile = null;
    try {
      register(home, repo, 'peek-known-id');
      seedPartition(home, repo, 'peek-known-id', [{ body: 'm1', ts: 1000 }]);

      const repoKey = repokey.repoKeyForWorktree(repo);
      const journalDir = storeLib.journalDirForHash(home, repoKey);
      registryFile = path.join(journalDir, 'registry.ndjson');
      const messagesFile = path.join(journalDir, 'messages.ndjson');
      assert.ok(fs.existsSync(registryFile), 'registry.ndjson must exist before this test locks it down');
      assert.ok(fs.existsSync(messagesFile), 'messages.ndjson must exist as the readable control channel');

      assert.ok(chmodChecked2(registryFile, 0o000), 'chmod 000 on registry.ndjson must succeed as a non-root, non-Windows test user');

      const r = cli.run(['inbox', 'peek-primary', 'peek-known-id'], ctx(home, { cwd: repo, backend: 'journal' })).result;
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.known, false,
        'peek-primary must report known:false when registry.ndjson cannot be read, even though messages.ndjson (this call\'s own message history) is fine: ' + JSON.stringify(r));
      assert.equal(r.storeUnavailable, true, 'peek-primary must report storeUnavailable:true: ' + JSON.stringify(r));
      assert.equal(typeof r.storeUnavailableReason, 'string', 'storeUnavailableReason must name the real fs error code: ' + JSON.stringify(r));
      assert.match(String(r.storeUnavailableReason), /EACCES/, JSON.stringify(r));

      const line = cli.emitKnownWarning(['inbox', 'peek-primary', 'peek-known-id'], r);
      assert.equal(typeof line, 'string', 'a known:false peek-primary result must emit a WARNING line');
      assert.match(line, /known:false/, line);
      assert.match(line, /store-unavailable \(EACCES\)/, 'the WARNING must name the real error code; line=' + line);
    } finally {
      if (registryFile) chmodChecked2(registryFile, 0o644);
      rm(home); rm(repo);
    }
  });

  (canChmodTest2 ? test : test.skip)('fl-wave7 (b): the no-descriptor probe for an UNKNOWN id (`ghost`) reports store-unavailable, not the misleading unregistered-workspace, when the shared registry.ndjson is unreadable but messages.ndjson stays readable', () => {
    const home = tmpHome();
    const repo = makeGitRepo('fl-wave7-ghost-probe');
    let registryFile = null;
    try {
      // Register a DIFFERENT, real id first so this repo's per-repoKey
      // journal store dir (registry.ndjson + messages.ndjson) actually
      // exists — the no-descriptor probe for `ghost` below opens the SAME
      // bucket (keyed by repoKeyForCwd(ctx), the whole project) via its own
      // store.openStore call.
      register(home, repo, 'ghost-sibling-id');
      seedPartition(home, repo, 'ghost-sibling-id', [{ body: 'm1', ts: 1000 }]);

      const repoKey = repokey.repoKeyForWorktree(repo);
      const journalDir = storeLib.journalDirForHash(home, repoKey);
      registryFile = path.join(journalDir, 'registry.ndjson');
      const messagesFile = path.join(journalDir, 'messages.ndjson');
      assert.ok(fs.existsSync(registryFile), 'registry.ndjson must exist before this test locks it down');
      assert.ok(fs.existsSync(messagesFile), 'messages.ndjson must exist as the readable control channel');

      assert.ok(chmodChecked2(registryFile, 0o000), 'chmod 000 on registry.ndjson must succeed as a non-root, non-Windows test user');

      // `ghost` has no descriptor, no registry row, and no messages of its
      // own — the probe's listRegistry() call hits registry.ndjson's EACCES
      // FIRST, then its messageCount('ghost') call reads messages.ndjson
      // (readable) and returns 0. Pre-fix, that second SUCCESSFUL read
      // cleared the shared lastReadError, so the probe's getReadError()
      // check saw null and fell back to the default 'unregistered-workspace'.
      const r = cli.run(['inbox', 'count', 'ghost'], ctx(home, { cwd: repo, backend: 'journal' })).result;
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.known, false, 'a store the probe could not fully read must report known:false: ' + JSON.stringify(r));
      assert.equal(r.reason, 'store-unavailable',
        'a registry.ndjson EACCES must report store-unavailable, never the misleading unregistered-workspace ("register it first"): ' + JSON.stringify(r));
      assert.equal(r.storeUnavailable, true, JSON.stringify(r));
      assert.match(String(r.storeUnavailableReason), /EACCES/, 'storeUnavailableReason must name the real fs error code: ' + JSON.stringify(r));
      assert.doesNotMatch(String(r.error || ''), /register it first/,
        'the error text must not tell the operator to register an id whose real blocker is an unreadable registry.ndjson: ' + JSON.stringify(r));

      // The same no-descriptor existence guard (resolveWorkspaceStoreForRead)
      // is shared by messages/read-primary/peek-primary, not just count — the
      // ghost id hits the identical reason:'store-unavailable' path there too.
      for (const args of [['inbox', 'messages', 'ghost'], ['inbox', 'read-primary', 'ghost'], ['inbox', 'peek-primary', 'ghost']]) {
        const rr = cli.run(args, ctx(home, { cwd: repo, backend: 'journal' })).result;
        assert.equal(rr.ok, false, args.join(' ') + ': ' + JSON.stringify(rr));
        assert.equal(rr.reason, 'store-unavailable',
          args.join(' ') + ' must report store-unavailable on a registry.ndjson EACCES, never unregistered-workspace: ' + JSON.stringify(rr));
        assert.match(String(rr.storeUnavailableReason), /EACCES/,
          args.join(' ') + ' storeUnavailableReason must name the real fs error code: ' + JSON.stringify(rr));
      }
    } finally {
      if (registryFile) chmodChecked2(registryFile, 0o644);
      rm(home); rm(repo);
    }
  });

  // fl-wave8 fix (item 1): the read-primary/`inbox messages --ack` OWNERSHIP
  // check (doAck && !ackAsOwner path, devswarm.js ~6828) calls
  // resolveMeshTarget(s, caller, home) BEFORE deciding whether the caller
  // owns `id` — resolveMeshTarget -> meshCandidateRows calls
  // storeHandle.listRegistry(), which SWALLOWS a genuine registry.ndjson
  // EACCES down to [] (same swallow item8/fl-wave7 already document for the
  // no-descriptor probe). Pre-fix, that made `ownEntry` come back null for a
  // REGISTERED caller in ITS OWN worktree purely because the registry could
  // not be read, and the ownership check then reported the misleading
  // 'caller-not-registered' — a security-shaped refusal for what is
  // actually a store outage. Fixed by probing getReadError() right after
  // resolveMeshTarget() and reporting store-unavailable/EACCES instead.
  (canChmodTest2 ? test : test.skip)('fl-wave8 (item 1): `read-primary` and `inbox messages --ack` on a REGISTERED id in its OWN worktree report store-unavailable/EACCES (never caller-not-registered) when registry.ndjson is unreadable, and recover once restored', () => {
    const home = tmpHome();
    const repo = makeGitRepo('wave8-item1');
    let registryFile = null;
    try {
      register(home, repo, 'wave8-owner-id');
      seedPartition(home, repo, 'wave8-owner-id', [{ body: 'm1', ts: 1000 }]);

      const repoKey = repokey.repoKeyForWorktree(repo);
      const journalDir = path.join(storeLib.storeDirForHash(home, repoKey), 'journal');
      registryFile = path.join(journalDir, 'registry.ndjson');
      assert.ok(fs.existsSync(registryFile), 'registry.ndjson must exist before this test locks it down');

      assert.ok(chmodChecked2(registryFile, 0o000), 'chmod 000 on registry.ndjson must succeed as a non-root, non-Windows test user');

      for (const args of [
        ['inbox', 'read-primary', 'wave8-owner-id'],
        ['inbox', 'messages', 'wave8-owner-id', '--ack'],
      ]) {
        const r = cli.run(args, ctx(home, { cwd: repo, backend: 'journal' })).result;
        assert.equal(r.ok, false, args.join(' ') + ' -> ' + JSON.stringify(r));
        assert.equal(r.reason, 'store-unavailable',
          args.join(' ') + ' on an unreadable registry.ndjson must report store-unavailable, never caller-not-registered: ' + JSON.stringify(r));
        assert.equal(r.storeUnavailable, true, args.join(' ') + ' -> ' + JSON.stringify(r));
        assert.match(String(r.storeUnavailableReason), /EACCES/,
          args.join(' ') + ' storeUnavailableReason must name the real fs error code: ' + JSON.stringify(r));
        assert.equal(r.known, false, args.join(' ') + ' -> ' + JSON.stringify(r));

        const line = cli.emitKnownWarning(args, r);
        assert.equal(typeof line, 'string', args.join(' ') + ' known:false must emit a WARNING line');
      }

      chmodChecked2(registryFile, 0o644);
      const restored = cli.run(['inbox', 'read-primary', 'wave8-owner-id'], ctx(home, { cwd: repo, backend: 'journal' })).result;
      assert.equal(restored.ok, true, 'once registry.ndjson recovers, read-primary must succeed again: ' + JSON.stringify(restored));
    } finally {
      if (registryFile) chmodChecked2(registryFile, 0o644);
      rm(home); rm(repo);
    }
  });
}

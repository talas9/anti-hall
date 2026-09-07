'use strict';
// Regression test for defect 1932b53a3ace (P1, Reviewer R3): resolveReadArgToId
// (scripts/devswarm.js) delegated EVERY `arg` — including one that exactly
// equals a LIVE registry row's own id — to resolveSendTarget unconditionally.
//
// Root cause: canonicalMeshId(worktreePath) === inst.primaryWorkspaceId(worktree)
// (the SAME derivation, scripts/devswarm.js:canonicalMeshId ~3384) — so a Primary
// row registered via `register-primary` (id = "primary-<hash>") and ANY other
// row on the SAME worktree (a "twin") both derive to that identical meshId. In
// resolveSendTarget's shadow guard (~10312), when `arg` equals the Primary's own
// id AND resolveMeshTarget's byMesh pass independently resolves to the twin (a
// live sibling on the same worktree), the `sameWorktreeGroup` branch treats this
// as a deliberate non-collision (correct for `send --to`, which wants to route
// to whichever sibling is actually live) and returns the TWIN as the resolved
// target — even though `arg` is the EXACT id of a DIFFERENT, still-registered
// row. A read verb (`inbox ack primary-X`) inherited that redirect and silently
// operated on the twin's own partition instead of refusing or no-op'ing on
// primary-X's own (inbox-path-less) partition.
//
// Fix under test: resolveReadArgToId now checks for an EXACT registry-row id
// match FIRST, before ever calling resolveSendTarget — an exact match always
// wins as a no-op (never redirected, never reported ambiguous). Mesh-id/
// one-hop-redirect resolution (via resolveSendTarget, ambiguity refusal
// included) is unchanged for every non-exact arg.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-1932b53a3ace-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-1932b53a3ace-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

test('B2/R3: `inbox ack <primaryId>` for a Primary row with no inboxPath must NEVER move a same-worktree twin\'s cursor — exact registered id always wins as a no-op on a read', () => {
  const home = tmpHome();
  const repo = makeGitRepo('exact-id-wins');
  try {
    // 1. register-primary — creates a row keyed on the deterministic
    //    "primary-<hash>" id, NO --inbox (matches the repro: register-primary
    //    is called with no --inbox flag anywhere in this test).
    const rp = cli.run(['register-primary', '--worktree', repo, '--session', 's-primary'], ctx(home, { cwd: repo })).result;
    assert.equal(rp.ok, true, 'register-primary failed: ' + JSON.stringify(rp));
    const primaryId = rp.id;
    assert.ok(primaryId, 'register-primary must report its derived id');

    // 2. a "twin" registry row on the SAME worktree, with a REAL --inbox NDJSON
    //    holding exactly 1 unread row and its own cursor file starting at 0.
    const twinId = 'twin-11111111-2222-4333-8444-555555555555';
    const twinInbox = path.join(home, 'twin-inbox.ndjson');
    const twinCursor = path.join(home, 'twin-cursor.txt');
    fs.writeFileSync(twinInbox, JSON.stringify({ from: 'someone', to: twinId, message: 'm1', timestamp: 1000 }) + '\n');
    const reg = cli.run(
      ['register', twinId, '--worktree', repo, '--session', 's-twin', '--inbox', twinInbox, '--cursor', twinCursor],
      ctx(home, { cwd: repo })
    ).result;
    assert.equal(reg.ok, true, 'twin register failed: ' + JSON.stringify(reg));

    // Sanity: the twin's own `inbox count` sees the 1 unread row before the ack.
    const preCount = cli.run(['inbox', 'count', twinId], ctx(home, { cwd: repo })).result;
    assert.equal(preCount.ok, true, JSON.stringify(preCount));
    assert.equal(preCount.total, 1, 'twin must start with exactly 1 unread row (repro precondition)');

    // 3. `inbox ack primary-X` from the Primary's own cwd — the arg is the
    //    EXACT id of the primary-X row (which has no inboxPath).
    const ackResult = cli.run(['inbox', 'ack', primaryId], ctx(home, { cwd: repo })).result;

    // Post-fix outcome: a refusal on primary-X's OWN partition (no-inbox-path),
    // NEVER a silent success against the twin.
    assert.equal(ackResult.ok, false, 'ack on a Primary row with no inboxPath must refuse, not silently succeed against another row: ' + JSON.stringify(ackResult));
    assert.equal(ackResult.id, primaryId, 'the refusal must name the LITERAL id the caller asked for, never a redirected id');
    assert.equal(ackResult.reason, 'no-inbox-path', JSON.stringify(ackResult));
    assert.equal(ackResult.resolvedFrom, undefined, 'an exact-id match must never report resolvedFrom — it is a no-op, not a resolution');

    // THE CORE ASSERTION: the twin's cursor must be UNTOUCHED — its unread
    // count is still exactly 1 (the ack above must not have consumed it).
    const postCount = cli.run(['inbox', 'count', twinId], ctx(home, { cwd: repo })).result;
    assert.equal(postCount.ok, true, JSON.stringify(postCount));
    assert.equal(postCount.total, 1, 'the twin\'s unread row must survive `inbox ack ' + primaryId + '` untouched — it must never have been the target of that ack');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// fl-wave4 fix (item 5, P2): `storeUnavailable` is a BOOLEAN on every read
// verb (count/read/messages/read-primary/peek-primary/ack); its DETAIL lives
// in the sibling top-level field `storeUnavailableReason` (string|null) —
// never nested only inside the `storeUnavailable` value itself, so every
// caller can check `result.storeUnavailableReason` uniformly regardless of
// which verb/refusal shape produced it.
// ---------------------------------------------------------------------------
test('B5/P2: storeUnavailable is a boolean, storeUnavailableReason is string|null, on every read verb — healthy read', () => {
  const home = tmpHome();
  const repo = makeGitRepo('storeunavailablereason-healthy');
  try {
    const healthyInbox = path.join(home, 'healthy-inbox.ndjson');
    const healthyCursor = path.join(home, 'healthy-cursor.txt');
    fs.writeFileSync(healthyInbox, '');
    const reg = cli.run(['register', 'healthy-id', '--worktree', repo, '--session', 's-healthy', '--inbox', healthyInbox, '--cursor', healthyCursor], ctx(home, { cwd: repo })).result;
    assert.equal(reg.ok, true, 'register failed: ' + JSON.stringify(reg));
    for (const args of [
      ['inbox', 'count', 'healthy-id'],
      ['inbox', 'read', 'healthy-id'],
      ['inbox', 'messages', 'healthy-id'],
      ['inbox', 'peek-primary', 'healthy-id'],
    ]) {
      const r = cli.run(args, ctx(home, { cwd: repo })).result;
      assert.equal(r.ok, true, args.join(' ') + ' -> ' + JSON.stringify(r));
      assert.equal(typeof r.storeUnavailable, 'boolean', args.join(' ') + ' storeUnavailable must be a boolean, got ' + JSON.stringify(r.storeUnavailable));
      assert.equal(r.storeUnavailable, false, args.join(' ') + ' must be false on a healthy read');
    }
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// fl-wave5 fix (item 1, B1 shape unification): `storeUnavailable` used to be
// an OBJECT (count/read/ack's own merge shape — reason/error/
// registeredRepoKey/callerRepoKey/storeUnavailableReason embedded directly
// as the field's value, overriding the boolean set earlier in the same
// object literal) on count/read/ack, with NO top-level
// `storeUnavailableReason` at all on those three verbs — while
// messages/read-primary/peek-primary carried a similarly-shaped object.
// Fix: EVERY read verb now reports `storeUnavailable` as a plain boolean,
// `storeUnavailableReason` as a top-level string|null, and (count/read/ack
// only) the full detail object under the separate `storeUnavailableDetail`
// key. Exercised here on a genuinely broken (chmod-000) store, across ALL
// SIX read verbs, so the shape is proven on the failure path where the
// pre-fix code diverged — not just the healthy path above.
// ---------------------------------------------------------------------------
const isWindows = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const canChmodTest = !isWindows && !isRoot;
function chmodChecked(p, mode) {
  try { fs.chmodSync(p, mode); return true; } catch (_) { return false; }
}

(canChmodTest ? test : test.skip)('B1/item1: storeUnavailable is a boolean + storeUnavailableReason is a top-level string, on ALL SIX read verbs (count/read/ack/read-primary/peek-primary/messages) against a chmod-000 store', () => {
  const home = tmpHome();
  const repo = makeGitRepo('storeunavailablereason-broken');
  let storeDir = null;
  try {
    const inboxPath = path.join(home, 'broken-inbox.ndjson');
    const cursorPath = path.join(home, 'broken-cursor.txt');
    fs.writeFileSync(inboxPath, '');
    const reg = cli.run(['register', 'broken-id', '--worktree', repo, '--session', 's-broken', '--inbox', inboxPath, '--cursor', cursorPath], ctx(home, { cwd: repo })).result;
    assert.equal(reg.ok, true, 'register failed: ' + JSON.stringify(reg));

    const repoKey = repokey.repoKeyForWorktree(repo);
    storeDir = storeLib.storeDirForHash(home, repoKey);
    assert.ok(fs.existsSync(storeDir), 'the store dir must exist before this test locks it down');
    assert.ok(chmodChecked(storeDir, 0o000), 'chmod 000 must succeed as a non-root, non-Windows test user');

    // count/read/ack (share the same `storeUnavailable` local + detail shape)
    for (const args of [['inbox', 'count', 'broken-id'], ['inbox', 'read', 'broken-id'], ['inbox', 'ack', 'broken-id']]) {
      const r = cli.run(args, ctx(home, { cwd: repo, backend: 'journal' })).result;
      assert.equal(typeof r.storeUnavailable, 'boolean', args.join(' ') + ' storeUnavailable must be a boolean, got ' + JSON.stringify(r.storeUnavailable));
      assert.equal(r.storeUnavailable, true, args.join(' ') + ' must report storeUnavailable:true on a broken store');
      assert.equal(typeof r.storeUnavailableReason, 'string', args.join(' ') + ' storeUnavailableReason must be a top-level string, got ' + JSON.stringify(r.storeUnavailableReason));
      assert.equal(typeof r.storeUnavailableDetail, 'object', args.join(' ') + ' must keep the full detail object under storeUnavailableDetail');
      assert.ok(r.storeUnavailableDetail, args.join(' ') + ' storeUnavailableDetail must not be null');
      // fl-wave5 addendum fix (item 10, P2, R4 Reviewer): `ack` used to omit
      // `known` entirely, so emitKnownWarning (gated on `known === false`)
      // never fired for a store-unavailable ack even though the CHANGELOG
      // already documented `known:false` as part of this shape.
      assert.equal(r.known, false, args.join(' ') + ' must report known:false on a broken store');
      const line = cli.emitKnownWarning(args, r);
      assert.equal(typeof line, 'string', args.join(' ') + ' known:false result must emit a WARNING line');
    }

    // read-primary/peek-primary/messages (cmdInboxMessages family — no
    // detail object promised for this family, boolean + reason still are)
    for (const args of [['inbox', 'read-primary', 'broken-id', '--ack-as-owner'], ['inbox', 'peek-primary', 'broken-id'], ['inbox', 'messages', 'broken-id']]) {
      const r = cli.run(args, ctx(home, { cwd: repo, backend: 'journal' })).result;
      assert.equal(typeof r.storeUnavailable, 'boolean', args.join(' ') + ' storeUnavailable must be a boolean, got ' + JSON.stringify(r.storeUnavailable));
      assert.equal(r.storeUnavailable, true, args.join(' ') + ' must report storeUnavailable:true on a broken store');
      assert.equal(typeof r.storeUnavailableReason, 'string', args.join(' ') + ' storeUnavailableReason must be a top-level string, got ' + JSON.stringify(r.storeUnavailableReason));
    }
  } finally {
    if (storeDir) chmodChecked(storeDir, 0o755);
    rm(home); rm(repo);
  }
});

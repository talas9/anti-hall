'use strict';
// v0.64.0 DevSwarm hardening — hermetic coverage for:
//   1. healRegistry FIRST-PASS DETERMINISM (P0 self-heal reliability): a legacy
//      bare-hash stray row with a STALE worktree_path snapshot, while a canonical
//      copy already sits in the fresh named store, must re-home in a SINGLE pass
//      with ZERO message loss (previously it dead-ended on the F2 collision guard
//      and only converged after an unrelated metadata upsert rewrote the path).
//   2. Claim 4 ack-as-owner UX guard: `inbox messages <id> --ack-as-owner`
//      (without --ack) is read-only and must WARN it did NOT ack.
//   3. `logs` CLI subcommand: filterable read of the central JSONL log.
//   4. Claim 2 e2e: a child with a DISTINCT builder-id self-registers via
//      `inbox pull <id>` then acks via `inbox read-primary <id> --ack-as-owner`.
//
// HERMETIC: an isolated tmp HOME + a forced journal backend (deterministic on
// every node version), a dedicated ANTI_HALL_LOG_DIR so the shared logger NEVER
// touches the real ~/.anti-hall, and ctx.env = {} so no ambient DEVSWARM_* leaks
// in. REAL git repos back repoKey/meshId derivation (real `git` spawns).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

// Point the shared central logger at an isolated dir BEFORE requiring anything
// that may log — the CLI logs verb-error outcomes into this stream, and a test
// must never write into the real ~/.anti-hall/logs (a prior release shipped red
// exactly because a test enumerated real ~/.anti-hall state).
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-v064-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const alog = require('../../plugins/anti-hall/companion/lib/anti-hall-log.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-v064-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-v064-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return fs.realpathSync(dir);
}
function writeDescriptor(home, id, desc) {
  const p = cli.descriptorPath(home, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(desc));
}
function seed(home, hash, desc, msgs) {
  const s = storeLib.openStore({ home, hash, backend: 'journal' });
  try {
    if (desc) s.upsertRegistry(desc);
    for (const m of (msgs || [])) s.appendMeshRow(m);
  } finally { s.close(); }
}
function reg(home, hash) {
  const s = storeLib.openStore({ home, hash, backend: 'journal' });
  try { return s.listRegistry(); } finally { s.close(); }
}
function msgs(home, hash, id) {
  const s = storeLib.openStore({ home, hash, backend: 'journal' });
  try { return s.listMessages(id, { sinceCursor: 0 }); } finally { s.close(); }
}

// ============================================================================
// 1. healRegistry first-pass determinism (P0)
// ============================================================================

test('healRegistry: a legacy bare-hash stray with a STALE worktree_path, while a canonical copy already holds the CURRENT path in the named store, re-homes in ONE pass with zero message loss', () => {
  const home = tmpHome();
  const repo = makeGitRepo('heal-stale');
  try {
    const id = 'child-heal-1';
    const sid = 'sess-heal-1';
    const namedKey = repokey.repoKeyForWorktree(repo);
    const bareHash = storeLib.hashFromWorkspaceId(id);
    assert.notEqual(namedKey, bareHash, 'named repoKey and bare-hash bucket differ');

    // The stray in the LEGACY bare-hash bucket carries a STALE path snapshot AND
    // an unread direct message that must NOT be lost by the re-home.
    const stalePath = repo + '-STALE';
    seed(home, bareHash, { id, worktreePath: stalePath, sessionId: sid, ownerKey: bareHash },
      [{ workspaceId: id, ts: 1000, hash: 'H-stray-1', body: 'do not lose me', sender: 'primary', recipient: id, mtype: 'direct', urgency: 'normal', isHeartbeat: false }]);
    // The CANONICAL copy already sits in the fresh named store with the CURRENT path.
    seed(home, namedKey, { id, worktreePath: repo, sessionId: sid, ownerKey: namedKey, repoKey: namedKey }, []);
    // The descriptor (identity ground truth) names the CURRENT worktree + sessionId.
    writeDescriptor(home, id, { id, worktreePath: repo, sessionId: sid, ownerKey: bareHash });

    const r = cli.healRegistry(home, bareHash, ctx(home, { cwd: repo }));
    assert.equal(r.rehomed, 1, 'exactly one row re-homed in a single pass: ' + JSON.stringify(r));
    assert.equal(r.rows[0].rehomed, true, JSON.stringify(r.rows[0]));

    // Source bucket registry row is tombstoned; the row now lives (only) in the named store.
    assert.deepEqual(reg(home, bareHash).map((x) => x.id), [], 'bare-hash registry drained');
    const named = reg(home, namedKey);
    assert.equal(named.length, 1);
    assert.equal(named[0].id, id);
    assert.equal(named[0].worktreePath, repo, 'named row carries the CURRENT path');

    // ZERO message loss: the stray's unread direct was forwarded into the named store.
    const delivered = msgs(home, namedKey, id).map((m) => m.body);
    assert.ok(delivered.includes('do not lose me'), 'forwarded the stray backlog: ' + JSON.stringify(delivered));

    // Idempotent: a second pass is a no-op (nothing left in the source bucket).
    const r2 = cli.healRegistry(home, bareHash, ctx(home, { cwd: repo }));
    assert.equal(r2.checked, 0);
    assert.equal(r2.rehomed, 0);
  } finally { rm(home); rm(repo); rm(repo + '-STALE'); }
});

test('healRegistry: a legacy bare-hash stray with NO canonical yet re-homes in ONE pass (baseline, unchanged)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('heal-basic');
  try {
    const id = 'child-heal-2';
    const sid = 'sess-heal-2';
    const namedKey = repokey.repoKeyForWorktree(repo);
    const bareHash = storeLib.hashFromWorkspaceId(id);
    seed(home, bareHash, { id, worktreePath: repo, sessionId: sid, ownerKey: bareHash }, []);
    writeDescriptor(home, id, { id, worktreePath: repo, sessionId: sid, ownerKey: bareHash });

    const r = cli.healRegistry(home, bareHash, ctx(home, { cwd: repo }));
    assert.equal(r.rehomed, 1, JSON.stringify(r));
    assert.deepEqual(reg(home, bareHash).map((x) => x.id), []);
    assert.deepEqual(reg(home, namedKey).map((x) => x.id), [id]);
  } finally { rm(home); rm(repo); }
});

// ============================================================================
// 2. Claim 4 — ack-as-owner UX guard on the read-only `messages` verb
// ============================================================================

function captureStderr(fn) {
  const orig = process.stderr.write;
  let buf = '';
  process.stderr.write = (chunk) => { buf += String(chunk); return true; };
  try { const out = fn(); return { out, stderr: buf }; }
  finally { process.stderr.write = orig; }
}

test('Claim 4: `inbox messages <id> --ack-as-owner` (no --ack) is read-only, warns it did NOT ack, and does NOT advance the cursor', () => {
  const home = tmpHome();
  const repo = makeGitRepo('claim4');
  try {
    const id = 'child-c4';
    const namedKey = repokey.repoKeyForWorktree(repo);
    // Seed a registered row + one unread direct in the shared repoKey store.
    seed(home, namedKey, { id, worktreePath: repo, sessionId: 'sess-c4', ownerKey: namedKey, repoKey: namedKey },
      [{ workspaceId: id, ts: 1, hash: 'H-c4', body: 'unread', sender: 'p', recipient: id, mtype: 'direct', urgency: 'normal', isHeartbeat: false }]);

    const { out, stderr } = captureStderr(() =>
      cli.run(['inbox', 'messages', id, '--ack-as-owner'], ctx(home, { cwd: repo })));
    assert.equal(out.result.ok, true, JSON.stringify(out.result));
    assert.equal(out.result.action, 'messages', 'stays the read-only verb, NOT read-primary');
    assert.equal(out.result.cursor, 0, 'cursor was NOT advanced (no ack happened)');
    assert.match(stderr, /did NOT ack/, 'emits the ack-as-owner warning: ' + JSON.stringify(stderr));
    assert.match(stderr, /read-primary/, 'points at the verb that actually acks');

    // The message is still unread on a follow-up read (proves nothing was acked).
    const follow = cli.run(['inbox', 'messages', id, '--unread'], ctx(home, { cwd: repo }));
    assert.equal(follow.result.count, 1, 'the direct is still unread');
  } finally { rm(home); rm(repo); }
});

test('Claim 4: plain `inbox messages <id>` (no --ack-as-owner) emits NO warning; `read-primary --ack-as-owner` acks WITHOUT warning', () => {
  const home = tmpHome();
  const repo = makeGitRepo('claim4b');
  try {
    const id = 'child-c4b';
    const namedKey = repokey.repoKeyForWorktree(repo);
    seed(home, namedKey, { id, worktreePath: repo, sessionId: 'sess-c4b', ownerKey: namedKey, repoKey: namedKey },
      [{ workspaceId: id, ts: 1, hash: 'H-c4b', body: 'x', sender: 'p', recipient: id, mtype: 'direct', urgency: 'normal', isHeartbeat: false }]);

    const plain = captureStderr(() => cli.run(['inbox', 'messages', id], ctx(home, { cwd: repo })));
    assert.equal(plain.out.result.ok, true);
    assert.doesNotMatch(plain.stderr, /did NOT ack/, 'no warning without the flag');

    const ackd = captureStderr(() => cli.run(['inbox', 'read-primary', id, '--ack-as-owner'], ctx(home, { cwd: repo })));
    assert.equal(ackd.out.result.ok, true, JSON.stringify(ackd.out.result));
    assert.equal(ackd.out.result.action, 'read-primary');
    assert.equal(ackd.out.result.cursor, 1, 'read-primary --ack-as-owner DID ack (cursor advanced)');
    assert.doesNotMatch(ackd.stderr, /did NOT ack/, 'read-primary is a real ack — no not-acked warning');
  } finally { rm(home); rm(repo); }
});

// ============================================================================
// 3. `logs` CLI subcommand
// ============================================================================

test('logs: reads the central JSONL log, filters by --repo/--component/--min-level, and rolls up by component/level', () => {
  const home = tmpHome();
  const runLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-v064-logsub-'));
  const prev = process.env.ANTI_HALL_LOG_DIR;
  process.env.ANTI_HALL_LOG_DIR = runLogDir;
  try {
    alog.logError('devswarm-cli', 'send', 'boom-A', { repoKey: 'repoA-111111', meshId: 'm1' });
    alog.logError('ingest', 'drain', 'boom-B', { repoKey: 'repoB-222222' });
    alog.logEvent('devswarm-cli', 'register', 'info', 'ok', { repoKey: 'repoA-111111' });

    const all = cli.run(['logs', '--limit', '50'], ctx(home));
    assert.equal(all.result.ok, true);
    assert.equal(all.result.action, 'logs');
    assert.equal(all.result.count, 3, JSON.stringify(all.result.byComponent));
    assert.equal(all.result.byComponent['devswarm-cli'], 2);
    assert.equal(all.result.byComponent['ingest'], 1);
    assert.equal(all.result.byLevel['error'], 2);
    assert.equal(all.result.byLevel['info'], 1);

    const byRepo = cli.run(['logs', '--repo', 'repoA-111111'], ctx(home));
    assert.equal(byRepo.result.count, 2, 'repo filter narrows to repoA');

    const byComp = cli.run(['logs', '--component', 'ingest'], ctx(home));
    assert.equal(byComp.result.count, 1);
    assert.equal(byComp.result.entries[0].op, 'drain');

    const errOnly = cli.run(['logs', '--min-level', 'error'], ctx(home));
    assert.equal(errOnly.result.count, 2, 'min-level error drops the info event');

    const limited = cli.run(['logs', '--limit', '1'], ctx(home));
    assert.equal(limited.result.count, 1, 'limit caps the slice (newest-last)');
  } finally {
    process.env.ANTI_HALL_LOG_DIR = prev;
    rm(runLogDir); rm(home);
  }
});

test('parseSinceDuration parses durations and rejects garbage', () => {
  assert.equal(cli.parseSinceDuration('30m'), 1800000);
  assert.equal(cli.parseSinceDuration('2h'), 7200000);
  assert.equal(cli.parseSinceDuration('1d'), 86400000);
  assert.equal(cli.parseSinceDuration('500'), 500);
  assert.equal(cli.parseSinceDuration('45s'), 45000);
  assert.equal(cli.parseSinceDuration('xyz'), null);
  assert.equal(cli.parseSinceDuration(''), null);
  assert.equal(cli.parseSinceDuration(undefined), null);
});

// ============================================================================
// 4. Claim 2 e2e — distinct builder-id self-register via pull, then ack path
// ============================================================================

test('Claim 2: a child with a DISTINCT builder-id self-registers via `inbox pull <id>`, then `inbox read-primary <id> --ack-as-owner` succeeds', () => {
  const home = tmpHome();
  const childRepo = makeGitRepo('claim2-child');
  try {
    const builderId = 'builder-uuid-abcdef01'; // deliberately NOT the worktree meshId
    const childMesh = inst.primaryWorkspaceId(inst.resolveWorktree(childRepo));
    assert.notEqual(builderId, childMesh, 'builder-id is distinct from the worktree meshId');

    // io injected so no real hivecontrol binary is touched (count 0 → no-op drain);
    // the descriptor is still auto-ensured into the shared repoKey store.
    const io = { run: (s) => (s.args[1] === 'message-count' ? { ok: true, raw: '0' } : { ok: false, error: 'x' }) };
    const pullRes = cli.run(['inbox', 'pull', builderId],
      ctx(home, { cwd: childRepo, env: { DEVSWARM_BUILDER_ID: builderId }, io }));
    assert.equal(pullRes.result.ok, true, 'self-register via pull: ' + JSON.stringify(pullRes.result));

    // A registered row for the builder-id now exists in the shared repoKey store.
    const namedKey = repokey.repoKeyForWorktree(childRepo);
    assert.deepEqual(reg(home, namedKey).map((x) => x.id), [builderId]);

    // Seed one unread direct into the child's own partition, then ack-as-owner.
    seed(home, namedKey, null,
      [{ workspaceId: builderId, ts: 1, hash: 'H-c2', body: 'hello child', sender: 'primary', recipient: builderId, mtype: 'direct', urgency: 'normal', isHeartbeat: false }]);

    const ack = cli.run(['inbox', 'read-primary', builderId, '--ack-as-owner'],
      ctx(home, { cwd: childRepo, env: { DEVSWARM_BUILDER_ID: builderId } }));
    assert.equal(ack.result.ok, true, 'read-primary --ack-as-owner succeeds: ' + JSON.stringify(ack.result));
    assert.equal(ack.result.action, 'read-primary');
    assert.equal(ack.result.total, 1);
    assert.equal(ack.result.cursor, 1, 'ack advanced the cursor to the message total');

    // Idempotent + actually acked: a follow-up unread read now sees nothing.
    const follow = cli.run(['inbox', 'messages', builderId, '--unread'],
      ctx(home, { cwd: childRepo, env: { DEVSWARM_BUILDER_ID: builderId } }));
    assert.equal(follow.result.count, 0, 'the direct is now acked/read');
  } finally { rm(home); rm(childRepo); }
});

// Companion to Claim 2: the SAME distinct-builder-id child can ack its OWN inbox
// WITHOUT --ack-as-owner (provable-ownership path), i.e. the override is not the
// only way in — the ownership resolution itself works for a distinct builder-id.
test('Claim 2 (ownership path): a distinct-builder-id child acks its OWN inbox WITHOUT --ack-as-owner', () => {
  const home = tmpHome();
  const childRepo = makeGitRepo('claim2-own');
  try {
    const builderId = 'builder-uuid-99887766';
    const io = { run: (s) => (s.args[1] === 'message-count' ? { ok: true, raw: '0' } : { ok: false, error: 'x' }) };
    const pullRes = cli.run(['inbox', 'pull', builderId],
      ctx(home, { cwd: childRepo, env: { DEVSWARM_BUILDER_ID: builderId }, io }));
    assert.equal(pullRes.result.ok, true, JSON.stringify(pullRes.result));

    const namedKey = repokey.repoKeyForWorktree(childRepo);
    seed(home, namedKey, null,
      [{ workspaceId: builderId, ts: 1, hash: 'H-own', body: 'yo', sender: 'primary', recipient: builderId, mtype: 'direct', urgency: 'normal', isHeartbeat: false }]);

    const ack = cli.run(['inbox', 'read-primary', builderId],
      ctx(home, { cwd: childRepo, env: { DEVSWARM_BUILDER_ID: builderId } }));
    assert.equal(ack.result.ok, true, 'child owns its own partition without the override: ' + JSON.stringify(ack.result));
    assert.equal(ack.result.cursor, 1);
  } finally { rm(home); rm(childRepo); }
});

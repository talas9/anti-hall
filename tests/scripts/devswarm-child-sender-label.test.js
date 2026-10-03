'use strict';
// CHILD SENDER LABEL (v0.108.0 P0). Before the fix every caller's `from` was
// `primary-<sha256(worktree)[0:8]>`, CHILDREN INCLUDED, so a child's sends and
// broadcasts read as "another Primary" (a resumed Primary stood down), and a
// child's register-primary minted a phantom `primary-<childhash>` row whose
// replies nobody read. Pins: the child label, the Primary label, the fail-open
// fallback, the display alias, and the seeded-bad-state repair migration.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

process.env.ANTI_HALL_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-childlabel-log-'));
const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const inst = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));
const liveness = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));
const aliasLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-sender-alias.js'));
const migrations = require(path.join(ROOT, 'companion', 'lib', 'migrations.js'));
const { testHook } = require('../helpers/spawn-hook.js');

const CHILD = 'c0ffee00-1111-4222-8333-444455556666';

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-childlabel-home-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-childlabel-repo-')));
  const repo = path.join(base, 'main');
  cp.spawnSync('git', ['init', '-q', repo]);
  cp.spawnSync('git', ['-C', repo, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const child = path.join(base, 'fix-child');
  cp.spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', child, '-b', 'fix-child']);
  const repoKey = repokey.repoKeyForWorktree(repo);
  const env = { ANTIHALL_DEVSWARM_APP_DB: 'off' };
  const PRIMARY = inst.primaryWorkspaceId(repo);
  const LABEL = inst.primaryWorkspaceId(child);
  return { home, base, repo, child, repoKey, env, PRIMARY, LABEL };
}
function cleanup(f) { rm(f.home); rm(f.base); }
function withStore(f, fn) {
  const s = storeLib.openStore({ home: f.home, hash: f.repoKey });
  try { return fn(s); } finally { s.close(); }
}
function registerChildRow(f) {
  withStore(f, (s) => s.upsertRegistry({ id: CHILD, worktreePath: f.child, sessionId: 'sess-child' }));
}
function registerPrimary(f) {
  const r = cli.run(['register-primary'], { home: f.home, env: Object.assign({ CLAUDE_CODE_SESSION_ID: 'sess-primary' }, f.env), cwd: f.repo });
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
}

test('child worktree: send carries the registered child id, never primary-<childhash>', () => {
  const f = fixture();
  try {
    assert.notEqual(f.LABEL, f.PRIMARY);
    registerPrimary(f);
    registerChildRow(f);
    const env = Object.assign({ DEVSWARM_BUILDER_ID: CHILD }, f.env);
    const r = cli.run(['send', '--to-primary', '--message', 'status: done'], { home: f.home, env, cwd: f.child });
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.from, CHILD);
    assert.deepEqual(r.result.identity, { id: CHILD, kind: 'child' });
    const rows = withStore(f, (s) => s.listMessages(f.PRIMARY) || []);
    assert.equal(rows[rows.length - 1].sender, CHILD, 'the stored row carries the child id');
    const b = cli.run(['send', '--broadcast', '--message', 'merged'], { home: f.home, env, cwd: f.child });
    assert.equal(b.result.from, CHILD, 'broadcasts too');
    // Declared id not registered: the ONE non-primary row on the worktree wins.
    const r2 = cli.run(['send', '--to-primary', '--message', 'x'], { home: f.home, env: f.env, cwd: f.child });
    assert.equal(r2.result.from, CHILD);
    // The worktree label is still accepted as a redundant --from, and is still "self".
    const r3 = cli.run(['send', '--to-primary', '--from', f.LABEL, '--message', 'y'], { home: f.home, env, cwd: f.child });
    assert.equal(r3.result.ok, true, JSON.stringify(r3.result));
    const self = cli.run(['send', '--to', f.LABEL, '--message', 'z'], { home: f.home, env, cwd: f.child });
    assert.equal(self.result.ok, false);
    assert.match(self.result.error, /cannot address the sender itself/);
    // Display alias recorded for the old label.
    assert.equal(aliasLib.resolveAlias(f.home, f.LABEL), CHILD);
  } finally { cleanup(f); }
});

test('primary checkout keeps primary-<hash>; an unregistered child falls back to its label (never invented)', () => {
  const f = fixture();
  try {
    registerPrimary(f);
    const env = Object.assign({ DEVSWARM_BUILDER_ID: 'hive-primary-uuid' }, f.env);
    withStore(f, (s) => s.upsertRegistry({ id: 'hive-primary-uuid', worktreePath: f.repo, sessionId: null }));
    registerChildRow(f);
    const p = cli.run(['send', '--to', CHILD, '--message', 'go'], { home: f.home, env, cwd: f.repo });
    assert.equal(p.result.ok, true, JSON.stringify(p.result));
    assert.equal(p.result.from, f.PRIMARY, 'the Primary checkout is the only primary-<hash> sender');
    assert.equal(p.result.identity.kind, 'resolved');
  } finally { cleanup(f); }
  const g = fixture();
  try {
    registerPrimary(g);
    const r = cli.run(['send', '--to-primary', '--message', 'x'], { home: g.home, env: g.env, cwd: g.child });
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.from, g.LABEL, 'no child row to name: fail-open to the worktree label');
  } finally { cleanup(g); }
});

test('projection: a pre-fix child broadcast under primary-<childhash> renders as the child (alias), stored row untouched', () => {
  const f = fixture();
  try {
    registerChildRow(f);
    withStore(f, (s) => {
      const fields = { from: f.LABEL, to: null, type: 'broadcast', message: 'old broadcast', timestamp: 1790000000000, urgency: 'normal' };
      storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: storeLib.meshMessageHash(fields) }));
    });
    const before = withStore(f, (s) => storeLib.computeSummary(s, { home: f.home }));
    assert.equal(before.recent[0].from, f.LABEL, 'no alias yet: raw label');
    aliasLib.writeAlias(f.home, f.LABEL, CHILD, f.child);
    const after = withStore(f, (s) => storeLib.computeSummary(s, { home: f.home }));
    assert.equal(after.recent[0].from, CHILD);
    assert.equal(after.recent[0].fromLabel, f.LABEL);
    const raw = withStore(f, (s) => s.listMessages(storeLib.BROADCAST_PARTITION_ID));
    assert.equal(raw[0].sender, f.LABEL, 'history is never rewritten');
  } finally { cleanup(f); }
});

function seedPhantom(f, opts) {
  const o = opts || {};
  withStore(f, (s) => s.upsertRegistry({ id: f.LABEL, worktreePath: f.child, sessionId: null }));
  const d = path.join(f.home, '.anti-hall', 'devswarm', 'workspaces');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, f.LABEL + '.json'), JSON.stringify({ id: f.LABEL, worktreePath: f.child, sessionId: null }));
  withStore(f, (s) => {
    const fields = { from: f.PRIMARY, to: f.LABEL, type: 'direct', message: 'reply nobody read', timestamp: 1790000000001, urgency: 'normal' };
    storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: storeLib.meshMessageHash(fields) }));
  });
  if (o.live) {
    // A RUNNING session holds the label (positive pid proof), not a mere heartbeat file.
    withStore(f, (s) => s.upsertRegistry({ id: f.LABEL, worktreePath: f.child, sessionId: 'sess-label-live' }));
    const dir = path.join(f.home, '.claude', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-label-live.json'), JSON.stringify({ pid: process.pid, sessionId: 'sess-label-live' }));
  }
}

test('repair (seeded bad state): phantom primary-<childhash> -> alias + unread forwarded + tombstone; idempotent; Primary untouched', () => {
  const f = fixture();
  try {
    registerPrimary(f);
    registerChildRow(f);
    seedPhantom(f);
    const dry = cli.repairChildSenderLabelsAllStores(f.home, { env: f.env, dryRun: true });
    assert.equal(dry.labels, 1, JSON.stringify(dry));
    assert.equal(dry.pending, 1);
    assert.ok(withStore(f, (s) => s.listRegistry().some((r) => r.id === f.LABEL)), 'dry run writes nothing');

    const res = cli.repairChildSenderLabelsAllStores(f.home, { env: f.env });
    assert.equal(res.errors, 0, JSON.stringify(res));
    assert.equal(res.retired, 1, JSON.stringify(res));
    assert.equal(res.forwarded, 1);
    const reg = withStore(f, (s) => s.listRegistry().map((r) => r.id));
    assert.ok(!reg.includes(f.LABEL), 'phantom row tombstoned');
    assert.ok(reg.includes(f.PRIMARY) && reg.includes(CHILD), 'Primary anchor and child row untouched');
    const childMail = withStore(f, (s) => s.listMessages(CHILD).map((m) => m.body));
    assert.deepEqual(childMail, ['reply nobody read'], 'unread forwarded to the child partition');
    const phantomMail = withStore(f, (s) => s.listMessages(f.LABEL).map((m) => m.body));
    assert.deepEqual(phantomMail, ['reply nobody read'], 'no delete: the original row stays');
    assert.equal(aliasLib.resolveAlias(f.home, f.LABEL), CHILD);
    const redirect = JSON.parse(fs.readFileSync(path.join(f.home, '.anti-hall', 'devswarm', 'retired', f.LABEL + '.json'), 'utf8'));
    assert.equal(redirect.retiredTo, CHILD, 'routing redirect to the child');

    const again = cli.repairChildSenderLabelsAllStores(f.home, { env: f.env, dryRun: true });
    assert.equal(again.pending, 0, 'idempotent: nothing left');
    const rows = migrations.runMigrations({ home: f.home, env: f.env, version: '0.108.0-test', devswarm: cli });
    const row = rows.find((x) => x.id === 'repair-child-sender-labels');
    assert.equal(row.status, 'skipped', JSON.stringify(row));
    assert.match(row.msg, /nothing to migrate/);
  } finally { cleanup(f); }
});

test('repair: a LIVE phantom label is aliased but never retired (retryable, unstamped)', () => {
  const f = fixture();
  try {
    registerPrimary(f);
    registerChildRow(f);
    seedPhantom(f, { live: true });
    const res = cli.repairChildSenderLabelsAllStores(f.home, { env: f.env });
    assert.equal(res.retired, 0, JSON.stringify(res));
    assert.deepEqual(res.left.map((x) => x.reason), ['child-label-live']);
    assert.ok(withStore(f, (s) => s.listRegistry().some((r) => r.id === f.LABEL)));
    assert.equal(aliasLib.resolveAlias(f.home, f.LABEL), CHILD);
    assert.equal(migrations.recordRun(f.home, 'repairChildSenderLabels', '9.9.9', { errors: 0, left: res.left }), false, 'a live row blocks the stamp');
  } finally { cleanup(f); }
});

test('register-primary from a corroborated DevSwarm CHILD worktree is refused (no new phantom label); --force overrides', () => {
  const f = fixture();
  try {
    registerChildRow(f);
    const d = path.join(f.home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, CHILD + '.json'), JSON.stringify({ id: CHILD, worktreePath: f.child }));
    const env = Object.assign({ DEVSWARM_BUILDER_ID: CHILD, DEVSWARM_SOURCE_BRANCH: 'main' }, f.env);
    const r = cli.run(['register-primary'], { home: f.home, env, cwd: f.child });
    assert.equal(r.result.ok, false, JSON.stringify(r.result));
    assert.equal(r.result.reason, 'not-primary-checkout');
    assert.ok(!withStore(f, (s) => s.listRegistry().some((x) => x.id === f.LABEL)), 'no phantom row minted');
    const forced = cli.run(['register-primary', '--force'], { home: f.home, env, cwd: f.child });
    assert.equal(forced.result.ok, true, JSON.stringify(forced.result));
    // The Primary checkout itself is never refused.
    registerPrimary(f);
  } finally { cleanup(f); }
});

test('field sequence: spawn seeds primary-<childhash>, child registers its id, Primary heartbeats the label -> refused, nothing written; repair folds the seed twin', () => {
  const f = fixture();
  try {
    registerPrimary(f);
    const penv = Object.assign({ ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: '0' }, f.env);
    const io = { run: () => ({ ok: true, raw: JSON.stringify({ branch: 'fix-child', path: f.child }) }) };
    const sp = cli.run(['spawn', 'fix-child'], { home: f.home, env: penv, cwd: f.repo, io });
    assert.equal(sp.result.ok, true, JSON.stringify(sp.result));
    assert.equal(sp.result.meshId, f.LABEL);
    assert.doesNotMatch(String(sp.result.launchHint || ''), /devswarm heartbeat primary-/, 'spawn no longer tells the Primary to heartbeat the label');
    registerChildRow(f); // the child launches and registers under its own id
    // The Primary heartbeats the child's label from its OWN cwd (the field repro).
    const hb = cli.run(['heartbeat', f.LABEL], { home: f.home, env: f.env, cwd: f.repo });
    assert.equal(hb.code, 2);
    assert.equal(hb.result.reason, 'child-label-id');
    assert.equal(hb.result.resolvedTo, CHILD);
    assert.ok(!fs.existsSync(liveness.heartbeatPathFor(f.LABEL, f.home)), 'no heartbeat written under the label');
    // register/ensure under the label are refused the same way; nothing minted.
    const before = withStore(f, (s) => s.listRegistry().length);
    assert.equal(cli.run(['register', f.LABEL, '--worktree', f.child], { home: f.home, env: f.env, cwd: f.repo }).result.reason, 'child-label-id');
    assert.equal(cli.run(['ensure', f.LABEL, '--worktree', f.child], { home: f.home, env: f.env, cwd: f.repo }).result.reason, 'child-label-id');
    assert.equal(withStore(f, (s) => s.listRegistry().length), before, 'no row minted');
    // A child heartbeating its own label from its worktree is also refused, with its real id.
    const own = cli.run(['heartbeat', f.LABEL], { home: f.home, env: Object.assign({ DEVSWARM_BUILDER_ID: CHILD }, f.env), cwd: f.child });
    assert.equal(own.result.resolvedTo, CHILD);
    // The real id and the Primary's own id still heartbeat normally.
    assert.equal(cli.run(['heartbeat', CHILD], { home: f.home, env: f.env, cwd: f.child }).result.ok, true);
    assert.equal(cli.run(['heartbeat', f.PRIMARY], { home: f.home, env: f.env, cwd: f.repo }).result.ok, true);
    // Even a stale forged heartbeat file does not protect the seed: repair folds it into the child.
    const p = liveness.heartbeatPathFor(f.LABEL, f.home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ id: f.LABEL, ts: Date.now(), state_ts: Date.now(), source: 'cli-heartbeat', sessionId: null }));
    const res = cli.repairChildSenderLabelsAllStores(f.home, { env: f.env });
    assert.equal(res.retired, 1, JSON.stringify(res));
    const reg = withStore(f, (s) => s.listRegistry().map((r) => r.id));
    assert.ok(!reg.includes(f.LABEL) && reg.includes(CHILD), 'twin folded into the real child id');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, '.anti-hall', 'devswarm', 'retired', f.LABEL + '.json'), 'utf8')).retiredTo, CHILD);
  } finally { cleanup(f); }
});

// Field report (L8): a child's broadcast stored under sender primary-<childhash>
// with NO registry row of that id (the child registered only its real id, from a
// subdirectory). PROVES what is and is not hidden, then that the repair +
// alias make every reader show it under the child's real id.
test('legacy child sender with no registry row: broadcast body readable by another child and the Primary (mesh read + parent-inbox); its question was dropped until aliased', () => {
  const f = fixture();
  const wtB = path.join(f.base, 'fix-other');
  try {
    cp.spawnSync('git', ['-C', f.repo, 'worktree', 'add', '-q', wtB, '-b', 'fix-other']);
    registerPrimary(f);
    const CHILD_B = 'b0b0b0b0-1111-4222-8333-444455556666';
    fs.mkdirSync(path.join(f.child, 'sub'), { recursive: true });
    withStore(f, (s) => {
      s.upsertRegistry({ id: CHILD, worktreePath: path.join(f.child, 'sub'), sessionId: 'sess-child' }); // registered from a SUBDIR (field shape)
      s.upsertRegistry({ id: CHILD_B, worktreePath: wtB, sessionId: 'sess-b' });
      const bc = { from: f.LABEL, to: null, type: 'broadcast', message: 'L8 LOCAL GATE PASS @abc', timestamp: Date.now() - 60000, urgency: 'normal' };
      storeLib.appendMeshMessage(s, Object.assign({}, bc, { hash: storeLib.meshMessageHash(bc) }));
      const q = { from: f.LABEL, to: f.PRIMARY, type: 'direct', message: 'merge now?', timestamp: 1790000000001, urgency: 'normal', needsReply: true };
      storeLib.appendMeshMessage(s, Object.assign({}, q, { hash: storeLib.meshMessageHash(q) }));
    });
    const bEnv = Object.assign({ DEVSWARM_BUILDER_ID: CHILD_B }, f.env);
    // BEFORE: the broadcast body IS visible (not hidden) — under the raw label.
    const before = cli.run(['mesh', 'read', '--peek'], { home: f.home, env: bEnv, cwd: wtB });
    assert.deepEqual(before.result.broadcasts.map((b) => [b.from, b.message]), [[f.LABEL, 'L8 LOCAL GATE PASS @abc']]);
    // BEFORE: the QUESTION is dropped from the Primary's pendingQuestions (the real hidden part).
    const sum0 = withStore(f, (s) => storeLib.computeSummary(s, { home: f.home }));
    assert.deepEqual((sum0.workspaces[f.PRIMARY].pendingQuestions || []).map((q) => q.from), [], 'unresolvable sender -> question dropped');

    const res = cli.repairChildSenderLabelsAllStores(f.home, { env: f.env });
    assert.equal(res.errors, 0, JSON.stringify(res));
    assert.equal(aliasLib.resolveAlias(f.home, f.LABEL), CHILD);

    // AFTER: another child and the Primary both read it under the child's id.
    const b = cli.run(['mesh', 'read', '--peek'], { home: f.home, env: bEnv, cwd: wtB });
    assert.deepEqual(b.result.broadcasts.map((x) => [x.from, x.message, x.fromLabel]), [[CHILD, 'L8 LOCAL GATE PASS @abc', f.LABEL]]);
    const p = cli.run(['mesh', 'read', '--peek'], { home: f.home, env: f.env, cwd: f.repo });
    assert.equal(p.result.broadcasts[0].from, CHILD);
    const sum1 = withStore(f, (s) => storeLib.computeSummary(s, { home: f.home }));
    assert.equal(sum1.recent[0].from, CHILD);
    assert.deepEqual(sum1.workspaces[f.PRIMARY].pendingQuestions.map((q) => q.from), [CHILD], 'the question now reaches the Primary\'s gate');
    // Projection render (parent-inbox broadcast feed): body shown under the child id.
    withStore(f, (s) => storeLib.deriveSummary(s, { home: f.home }));
    const r = testHook('devswarm-parent-inbox.js', { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: f.repo },
      { home: f.home, env: { DEVSWARM_REPO_ID: 'repo-1', ANTIHALL_DEVSWARM_APP_DB: 'off' }, expectJson: true });
    const ctxText = (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
    assert.match(ctxText, new RegExp(CHILD + ': L8 LOCAL GATE PASS @abc'), ctxText);
    // A NEW child broadcast is stored under the child id directly (no alias needed).
    const n = cli.run(['send', '--broadcast', '--message', 'L8 second'], { home: f.home, env: Object.assign({ DEVSWARM_BUILDER_ID: CHILD }, f.env), cwd: f.child });
    assert.equal(n.result.from, CHILD);
    const b2 = cli.run(['mesh', 'read', '--peek'], { home: f.home, env: bEnv, cwd: wtB });
    assert.deepEqual(b2.result.broadcasts.map((x) => [x.from, x.message]).slice(-1), [[CHILD, 'L8 second']]);
    assert.equal(b2.result.broadcasts.slice(-1)[0].fromLabel, undefined);
  } finally { rm(wtB); cleanup(f); }
});

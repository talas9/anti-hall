'use strict';
// 0.108.3 — the child-facing `devswarm.js done` verb (Fix A). Before it,
// nothing made a child set the `done` gate, so auto-archive's gate (a) never
// passed. Pins: done sets the gate on the caller's OWN id, sends exactly ONE
// [[ANTIHALL_DONE]] message to the Primary, is idempotent, refuses a foreign
// id / the Primary checkout, shows on the roster, and flips the auto-archive
// plan from blocked (a-done) to wouldArchive with a proven merge + c-g passing.
// Isolated HOME; the app DB is a node:sqlite fixture.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

process.env.ANTI_HALL_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-done-log-'));
const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const inst = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));
const L = require(path.join(ROOT, 'companion', 'lib', 'devswarm-lifecycle.js'));
const caps = require(path.join(ROOT, 'companion', 'lib', 'devswarm-capabilities.js'));
const { fakeHivecontrol } = require('../helpers/fake-hivecontrol.js');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';

const CHILD = 'c0ffee00-1111-4222-8333-444455556666';
const FIX = path.join(__dirname, '..', 'fixtures', 'devswarm-capabilities');
const V252 = { version: '2.5.2', workspaceHelp: path.join(FIX, 'hivecontrol-2.5.2-workspace-help.txt') };

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-done-home-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-done-repo-')));
  const repo = path.join(base, 'main');
  cp.spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  cp.spawnSync('git', ['-C', repo, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const child = path.join(base, 'fix-child');
  cp.spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', child, '-b', 'fix-child']);
  const repoKey = repokey.repoKeyForWorktree(repo);
  const env = { ANTIHALL_DEVSWARM_APP_DB: 'off' };
  const PRIMARY = inst.primaryWorkspaceId(repo);
  const f = { home, base, repo, child, repoKey, env, PRIMARY };
  const r = cli.run(['register-primary'], { home, env: Object.assign({ CLAUDE_CODE_SESSION_ID: 'sess-primary' }, env), cwd: repo });
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  withStore(f, (s) => { s.upsertRegistry({ id: CHILD, worktreePath: child, sessionId: 'sess-child' }); storeLib.deriveSummary(s, { home }); });
  return f;
}
function cleanup(f) { rm(f.home); rm(f.base); }
function withStore(f, fn) {
  const s = storeLib.openStore({ home: f.home, hash: f.repoKey });
  try { return fn(s); } finally { s.close(); }
}
function childEnv(f) { return Object.assign({ DEVSWARM_BUILDER_ID: CHILD }, f.env); }
function doneRows(f) {
  return withStore(f, (s) => (s.listMessages(f.PRIMARY) || []).filter((r) => typeof r.body === 'string'
    && r.body.startsWith(storeLib.DONE_REPORT_MARKER)));
}
function gatesOf(f) {
  return withStore(f, (s) => storeLib.computeSummary(s, { home: f.home }).workspaces[CHILD].gates);
}

test('done: sets the done gate on the caller\'s own id and sends ONE structured message; idempotent', () => {
  const f = fixture();
  try {
    assert.notEqual(gatesOf(f).done, true, 'precondition: no done gate yet');
    assert.equal(doneRows(f).length, 0);
    const r = cli.run(['done', '--summary', 'feat merged to main'], { home: f.home, env: childEnv(f), cwd: f.child });
    assert.equal(r.code, 0, JSON.stringify(r.result));
    assert.equal(r.result.id, CHILD);
    assert.equal(r.result.gateSet, true);
    assert.equal(r.result.messaged, true, JSON.stringify(r.result));
    assert.equal(r.result.kind, 'done');
    assert.equal(r.result.duplicate, false);
    const g = gatesOf(f);
    assert.equal(g.done, true);
    assert.notEqual(g.merged, true, 'done never sets merged');
    assert.notEqual(g.tests_passed, true, 'done never sets tests_passed');
    const rows = doneRows(f);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sender, CHILD);
    assert.match(rows[0].body, /feat merged to main/);
    // re-run (same HEAD): no second message, still ok.
    const again = cli.run(['done'], { home: f.home, env: childEnv(f), cwd: f.child });
    assert.equal(again.code, 0, JSON.stringify(again.result));
    assert.equal(again.result.duplicate, true);
    assert.equal(doneRows(f).length, 1, 'idempotent: exactly one done message');
    // explicit own id is accepted.
    assert.equal(cli.run(['done', CHILD], { home: f.home, env: childEnv(f), cwd: f.child }).code, 0);
    assert.equal(doneRows(f).length, 1);
    // roster shows the child as done / archive-pending.
    const roster = cli.run(['roster'], { home: f.home, env: f.env, cwd: f.repo });
    const row = roster.result.workspaces.find((w) => w.id === CHILD);
    assert.ok(row.hints.includes('done') && row.hints.includes('archive-pending'), JSON.stringify(row.hints));
  } finally { cleanup(f); }
});

test('done: refuses a foreign id and the Primary checkout; writes nothing', () => {
  const f = fixture();
  try {
    const foreign = cli.run(['done', 'someone-else'], { home: f.home, env: childEnv(f), cwd: f.child });
    assert.equal(foreign.code, 2);
    assert.equal(foreign.result.reason, 'not-own-workspace');
    const prim = cli.run(['done'], { home: f.home, env: f.env, cwd: f.repo });
    assert.equal(prim.code, 2);
    assert.equal(prim.result.reason, 'primary-checkout');
    assert.notEqual(gatesOf(f).done, true);
    assert.equal(doneRows(f).length, 0);
  } finally { cleanup(f); }
});

test('auto-archive plan: blocked on a-done before `done`, wouldArchive after (proven merge, c-g pass)', { skip }, () => {
  const f = fixture();
  try {
    const dbFile = path.join(f.base, 'devswarm.db');
    const db = new sqlite.DatabaseSync(dbFile);
    db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, sourceBranch TEXT, worktreePath TEXT,'
      + ' builderType TEXT, isActive INTEGER, isHidden INTEGER, lastSelectedAt TEXT, label TEXT, pullRequestId TEXT)');
    const ins = db.prepare('INSERT INTO builders VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    ins.run('p-1', 'r1', 'main', null, f.repo, 'primary', 1, 0, null, 'Primary', null);
    ins.run(CHILD, 'r1', 'fix-child', 'main', f.child, 'standard', 1, 0, null, 'Fix child', null);
    db.close();
    const bin = fakeHivecontrol(path.join(f.base, 'bin'), V252);
    const env = { HOME: f.home, PATH: bin.dir + path.delimiter + process.env.PATH, ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
    caps.resetCache();
    const now = Date.now();
    const deps = {
      descriptors: () => [{ id: CHILD, worktreePath: f.child, sessionId: 'sess-child' }],
      activityTs: () => now - 60 * 60000,
      // The Primary has read the child's done message (gate d counts unread FROM the child).
      unreadFrom: () => 0,
    };
    const plan = () => L.planAutoArchive({ home: f.home, env, now, deps, settings: { mode: 'dry-run', idleMin: 30, maxPerSweep: 3 } });
    const before = plan();
    assert.equal(before.ok, true, JSON.stringify(before));
    const c0 = before.candidates.find((c) => c.id === CHILD);
    assert.deepStrictEqual(c0.blockers.map((b) => b.gate), ['a-done'], JSON.stringify(c0.blockers));
    assert.deepStrictEqual(before.toArchive, []);
    const r = cli.run(['done'], { home: f.home, env: childEnv(f), cwd: f.child });
    assert.equal(r.code, 0, JSON.stringify(r.result));
    const after = plan();
    const c1 = after.candidates.find((c) => c.id === CHILD);
    assert.strictEqual(c1.eligible, true, JSON.stringify(c1.blockers));
    assert.strictEqual(c1.facts.doneVia, 'done-report');
    assert.match(c1.facts.merged.via, /^git:/);
    assert.deepStrictEqual(after.toArchive, [CHILD]);
    assert.deepStrictEqual(L.autoArchiveSweep({ home: f.home, env, now, deps, settings: { mode: 'dry-run', idleMin: 30, maxPerSweep: 3 } }).wouldArchive, [CHILD]);
  } finally { cleanup(f); }
});

// P1-B — the done gate is tied to the HEAD it was reported at. Real git: the
// child's work is squash-merged (main gets an equivalent commit, never the
// child's own), the app shows the PR merged, and the child then REUSES its
// branch with new, unmerged commits. Nothing may auto-archive it.
test('P1-B done records HEAD; squash-merged PR + reused branch with new commits is never auto-archived', { skip }, () => {
  const f = fixture();
  try {
    const git = (cwd, ...a) => {
      const r = cp.spawnSync('git', ['-C', cwd, '-c', 'user.email=a@b.c', '-c', 'user.name=T'].concat(a), { encoding: 'utf8' });
      assert.equal(r.status, 0, a.join(' ') + ': ' + r.stderr);
      return String(r.stdout || '').trim();
    };
    fs.writeFileSync(path.join(f.child, 'feat.txt'), 'v1\n');
    git(f.child, 'add', 'feat.txt'); git(f.child, 'commit', '-q', '-m', 'feat v1');
    // Squash-merge: main gets the same content as a NEW commit.
    fs.writeFileSync(path.join(f.repo, 'feat.txt'), 'v1\n');
    git(f.repo, 'add', 'feat.txt'); git(f.repo, 'commit', '-q', '-m', 'feat (squashed)');
    const dbFile = path.join(f.base, 'devswarm.db');
    const db = new sqlite.DatabaseSync(dbFile);
    db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, sourceBranch TEXT, worktreePath TEXT,'
      + ' builderType TEXT, isActive INTEGER, isHidden INTEGER, lastSelectedAt TEXT, label TEXT, pullRequestId TEXT)');
    db.exec('CREATE TABLE pull_requests (id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, state TEXT, targetBranch TEXT)');
    const ins = db.prepare('INSERT INTO builders VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    ins.run('p-1', 'r1', 'main', null, f.repo, 'primary', 1, 0, null, 'Primary', null);
    ins.run(CHILD, 'r1', 'fix-child', 'main', f.child, 'standard', 1, 0, null, 'Fix child', 'pr-1');
    db.prepare('INSERT INTO pull_requests VALUES (?,?,?,?,?)').run('pr-1', 'r1', 'fix-child', 'merged', 'main');
    db.close();
    const bin = fakeHivecontrol(path.join(f.base, 'bin'), V252);
    const env = { HOME: f.home, PATH: bin.dir + path.delimiter + process.env.PATH, ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
    caps.resetCache();
    const now = Date.now();
    const deps = { descriptors: () => [{ id: CHILD, worktreePath: f.child, sessionId: 'sess-child' }], activityTs: () => now - 60 * 60000, unreadFrom: () => 0 };
    const cand = () => L.planAutoArchive({ home: f.home, env, now, deps, settings: { mode: 'dry-run', idleMin: 30, maxPerSweep: 3 } })
      .candidates.find((c) => c.id === CHILD);

    const head1 = git(f.child, 'rev-parse', 'HEAD');
    const r = cli.run(['done'], { home: f.home, env: childEnv(f), cwd: f.child });
    assert.equal(r.code, 0, JSON.stringify(r.result));
    const sum = withStore(f, (s) => storeLib.computeSummary(s, { home: f.home }).workspaces[CHILD]);
    assert.equal(sum.gates.done, true);
    assert.equal(sum.doneHead, head1, 'done records the HEAD it reported at');
    // Squash merge: git says not-an-ancestor, and the merged PR never overrides it.
    let c = cand();
    assert.deepStrictEqual(c.blockers.map((b) => b.gate), ['b-merged'], JSON.stringify(c.blockers));
    assert.equal(c.facts.merged.via, 'git:not-ancestor');

    // Branch reused: new unmerged commits after the done-report.
    fs.writeFileSync(path.join(f.child, 'feat.txt'), 'v2 unmerged\n');
    git(f.child, 'commit', '-q', '-am', 'feat v2');
    c = cand();
    assert.deepStrictEqual(c.blockers.map((b) => b.gate), ['a-done', 'b-merged'], JSON.stringify(c.blockers));
    assert.equal(c.facts.doneVia, 'stale-head');
    // Re-reporting done at the new HEAD still cannot archive unmerged commits.
    assert.equal(cli.run(['done'], { home: f.home, env: childEnv(f), cwd: f.child }).code, 0);
    c = cand();
    assert.deepStrictEqual(c.blockers.map((b) => b.gate), ['b-merged'], JSON.stringify(c.blockers));
    assert.deepStrictEqual(L.autoArchiveSweep({ home: f.home, env, now, deps, settings: { mode: 'dry-run', idleMin: 30, maxPerSweep: 3 } }).wouldArchive, []);

    // A plain `gate --set done` (no sha) clears doneHead: manual path, git proof only.
    assert.equal(cli.run(['gate', CHILD, '--set', 'done'], { home: f.home, env: f.env, cwd: f.child }).result.ok, true);
    const sum2 = withStore(f, (s) => storeLib.computeSummary(s, { home: f.home }).workspaces[CHILD]);
    assert.equal(sum2.doneHead, undefined);
    c = cand();
    assert.equal(c.facts.doneVia, 'done-gate');
    assert.deepStrictEqual(c.blockers.map((b) => b.gate), ['b-merged']);
  } finally { cleanup(f); }
});

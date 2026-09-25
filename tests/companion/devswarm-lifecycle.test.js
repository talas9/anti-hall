'use strict';
// v0.108.0 — companion/lib/devswarm-lifecycle.js
//   auto-archive: every precondition (a..g) false -> no archive; dry-run writes
//   nothing and spawns no archive; 2.5.2 -> dormant; mode on + 2.5.3 fake ->
//   archive spawned (rate-limited), logged, Primary told with an undo hint.
//   prune: dry run stores a nonce plan; deletion refuses without a valid,
//   fresh, exact plan, refuses an automated caller, re-verifies each row, logs,
//   tombstones. The hivecontrol binary is ALWAYS a PATH-injected fake.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const L = require(path.join(ROOT, 'companion', 'lib', 'devswarm-lifecycle.js'));
const caps = require(path.join(ROOT, 'companion', 'lib', 'devswarm-capabilities.js'));
const dw = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const { fakeHivecontrol, readCalls } = require('../helpers/fake-hivecontrol.js');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';

const FIX = path.join(__dirname, '..', 'fixtures', 'devswarm-capabilities');
const V252 = { version: '2.5.2', workspaceHelp: path.join(FIX, 'hivecontrol-2.5.2-workspace-help.txt') };
const V253 = {
  version: '2.5.3', workspaceHelp: path.join(FIX, 'hivecontrol-2.5.3-workspace-help.txt'),
  verbHelp: {
    archive: path.join(FIX, 'hivecontrol-2.5.3-archive-help.txt'),
    delete: path.join(FIX, 'hivecontrol-2.5.3-delete-help.txt'),
  },
};
const MIN = 60000;
const NOW = Date.parse('2026-09-24T12:00:00Z');

function listTree(dir) {
  const out = [];
  (function walk(d) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) { const p = path.join(d, e.name); out.push(p); if (e.isDirectory()) walk(p); }
  })(dir);
  return out.sort();
}

// fixture: app DB with a Primary + children; per-child fact overrides.
function fixture(fake, children, opts) {
  const o = opts || {};
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-lifecycle-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const bin = fakeHivecontrol(path.join(base, 'bin'), fake);
  const dbFile = path.join(base, 'devswarm.db');
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, sourceBranch TEXT, worktreePath TEXT,'
    + ' builderType TEXT, isActive INTEGER, isHidden INTEGER, lastSelectedAt TEXT, label TEXT, pullRequestId TEXT)');
  // The real DevSwarm pull_requests table has NO head/commit sha column.
  db.exec('CREATE TABLE pull_requests (id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, state TEXT, targetBranch TEXT)');
  const ins = db.prepare('INSERT INTO builders VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const primaryWt = path.join(base, 'primary'); fs.mkdirSync(primaryWt);
  ins.run('p-1', 'r1', 'main', null, primaryWt, 'primary', 1, 0, null, 'Primary', null);
  const facts = {};
  for (const c of children) {
    const wt = path.join(base, 'wt-' + c.id); fs.mkdirSync(wt);
    ins.run(c.id, 'r1', 'feat/' + c.id, 'main', wt, c.builderType || 'standard', c.archived ? 0 : 1, c.archived ? 1 : 0,
      c.lastSelectedAt === undefined ? null : c.lastSelectedAt, 'Task ' + c.id, null);
    if (c.pr) db.prepare('INSERT INTO pull_requests VALUES (?,?,?,?,?)').run('pr-' + c.id, 'r1', 'feat/' + c.id, c.pr, 'main');
    facts[wt] = Object.assign({ id: c.id, ancestor: true, porcelain: '', done: true, unread: 0, broadcastUnread: 0, unreadFrom: 0, activity: NOW - 60 * MIN }, c);
  }
  db.close();
  const env = { HOME: home, PATH: bin.dir, ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
  const byId = {};
  for (const wt of Object.keys(facts)) { facts[wt].wt = wt; byId[facts[wt].id] = facts[wt]; } // shared objects: a test may mutate a fact later
  const notified = [];
  const deps = {
    descriptors: () => Object.values(byId).map((f) => ({ id: f.id, worktreePath: f.wt, sessionId: 's-' + f.id })),
    repoKey: () => 'proj-abc123',
    summary: () => ({ workspaces: Object.fromEntries(Object.values(byId).map((f) => [f.id, { id: f.id, archive_ready: f.done, gates: f.gates || {}, doneHead: f.doneHead, mergedVerified: f.mergedVerified, mergedVerifiedHead: f.mergedVerifiedHead, unread: f.unread, broadcastUnread: f.broadcastUnread || 0, cursor: 0 }])) }),
    unreadFrom: (h, k, ids) => ids.reduce((n, id) => n + ((byId[id] && byId[id].unreadFrom) || 0), 0),
    activityTs: (d) => byId[d.id].activity,
    git: (cwd, args) => {
      const f = facts[cwd];
      if (!f) return { ok: false, status: 128, out: '' };
      if (args[0] === 'status') return f.porcelain === null ? { ok: false, status: 128, out: '' } : { ok: true, status: 0, out: f.porcelain };
      if (args[0] === 'rev-parse' && args[1] === '--verify' && f.refsMissing) return { ok: false, status: 1, out: '' };
      if (args[0] === 'rev-parse') return { ok: true, status: 0, out: (f.head || 'abc') + '\n' };
      if (args[0] === 'merge-base') return { ok: f.ancestor, status: f.ancestor ? 0 : 1, out: '' };
      return { ok: false, status: 1, out: '' };
    },
    notifyPrimary: (home2, cand, text) => { notified.push({ id: cand.id, text }); return 'ok'; },
  };
  if (o.noAppDb) env.ANTIHALL_DEVSWARM_APP_DB = 'off';
  caps.resetCache();
  return { base, home, env, bin, deps, notified, byId };
}

function opts(fx, extra) {
  return Object.assign({ home: fx.home, env: fx.env, now: NOW, deps: fx.deps }, extra || {});
}
const ON = { mode: 'on', idleMin: 30, maxPerSweep: 3 };
const DRY = { mode: 'dry-run', idleMin: 30, maxPerSweep: 3 };

test('baseline: a proven-done child is eligible; Primary never is', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1' }]);
  const plan = L.planAutoArchive(opts(fx, { settings: DRY }));
  assert.deepStrictEqual(plan.toArchive, ['c1']);
  assert.strictEqual(plan.candidates.find((c) => c.id === 'c1').eligible, true);
  assert.strictEqual(plan.candidates.some((c) => c.id === 'p-1'), false, 'Primary has no descriptor here');
});

const PRECONDITIONS = [
  ['a done gate unset', { done: false }, 'a-done'],
  ['b not merged (git) and no PR', { ancestor: false }, 'b-merged'],
  ['b not merged: PR closed', { ancestor: false, pr: 'closed' }, 'b-merged'],
  ['c uncommitted changes', { porcelain: ' M src/x.js\n' }, 'c-clean'],
  ['c git status unreadable', { porcelain: null }, 'c-clean'],
  ['d unread to the child', { unread: 2 }, 'd-unread'],
  ['d unread from the child', { unreadFrom: 1 }, 'd-unread'],
  ['e builderType primary', { builderType: 'primary' }, 'e-primary'],
  ['f viewed 3 min ago', { lastSelectedAt: new Date(NOW - 3 * MIN).toISOString() }, 'f-viewed'],
  ['g active 5 min ago', { activity: NOW - 5 * MIN }, 'g-idle'],
  ['g no activity signal', { activity: null }, 'g-idle'],
];
for (const [name, over, gate] of PRECONDITIONS) {
  test('precondition false -> no archive: ' + name, { skip }, () => {
    const fx = fixture(V253, [Object.assign({ id: 'c1' }, over)]);
    const r = L.autoArchiveSweep(opts(fx, { settings: ON }));
    assert.deepStrictEqual(r.archived, []);
    assert.deepStrictEqual(r.wouldArchive, []);
    const plan = L.planAutoArchive(opts(fx, { settings: ON }));
    assert.ok(plan.candidates[0].blockers.some((b) => b.gate === gate), JSON.stringify(plan.candidates[0].blockers));
    assert.ok(!readCalls(fx.bin.callsFile).some((c) => c.argv[1] === 'archive' && c.argv[2] !== '--help'));
  });
}

// 0.108.3 — gate (d) is DIRECT-only: a broadcast/FYI backlog in the child's
// own inbox must never block auto-archive (field evidence: d-unread(to=197
// from=0) on a finished lane whose "unread" was entirely mesh broadcast).
test('gate (d): broadcast-only backlog does not block auto-archive', { skip }, () => {
  const fx = fixture(V253, [{ id: 'c1', unread: 0, broadcastUnread: 197 }]);
  const plan = L.planAutoArchive(opts(fx, { settings: DRY }));
  const c = plan.candidates[0];
  assert.strictEqual(c.eligible, true, JSON.stringify(c.blockers));
  assert.deepStrictEqual(c.facts.unread, { toChild: 0, toDirect: 0, toBroadcast: 197, fromChild: 0 });
});

test('gate (d): one unread DIRECT message still blocks, split reported', { skip }, () => {
  const fx = fixture(V253, [{ id: 'c1', unread: 1, broadcastUnread: 197 }]);
  const plan = L.planAutoArchive(opts(fx, { settings: DRY }));
  const c = plan.candidates[0];
  assert.strictEqual(c.eligible, false);
  const b = c.blockers.find((x) => x.gate === 'd-unread');
  assert.ok(b, JSON.stringify(c.blockers));
  assert.strictEqual(b.detail, 'to_direct=1 to_broadcast=197 from=0');
});

test('gate (d): unread FROM the child (its done report) still blocks', { skip }, () => {
  const fx = fixture(V253, [{ id: 'c1', unread: 0, broadcastUnread: 197, unreadFrom: 1 }]);
  const plan = L.planAutoArchive(opts(fx, { settings: DRY }));
  const c = plan.candidates[0];
  assert.strictEqual(c.eligible, false);
  const b = c.blockers.find((x) => x.gate === 'd-unread');
  assert.ok(b, JSON.stringify(c.blockers));
  assert.strictEqual(b.detail, 'to_direct=0 to_broadcast=197 from=1');
});

// 0.108.3 — gate (a) accepts the child's structured done-report (the `done`
// gate row alone) when the merge is PROVEN (gate b) and c-g pass.
test('done-report (done gate only) + proven merge + c-g pass -> wouldArchive', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', done: false, gates: { done: true }, doneHead: 'abc' }]);
  const r = L.autoArchiveSweep(opts(fx, { settings: DRY }));
  assert.deepStrictEqual(r.wouldArchive, ['c1']);
  const c = L.planAutoArchive(opts(fx, { settings: DRY })).candidates[0];
  assert.strictEqual(c.eligible, true);
  assert.strictEqual(c.facts.doneVia, 'done-report');
});

test('done-report WITHOUT a proven merge -> blocked on b-merged', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', done: false, gates: { done: true }, doneHead: 'abc', ancestor: false }]);
  const r = L.autoArchiveSweep(opts(fx, { settings: DRY }));
  assert.deepStrictEqual(r.wouldArchive, []);
  const c = L.planAutoArchive(opts(fx, { settings: DRY })).candidates[0];
  assert.deepStrictEqual(c.blockers.map((b) => b.gate), ['b-merged']);
});

test('done-report with c-g failing still blocks (dirty worktree)', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', done: false, gates: { done: true }, porcelain: ' M x\n' }]);
  assert.deepStrictEqual(L.autoArchiveSweep(opts(fx, { settings: DRY })).wouldArchive, []);
});

test('manual all-gates path still works (via gates)', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', done: true, gates: { done: true, merged: true, tests_passed: true } }]);
  const c = L.planAutoArchive(opts(fx, { settings: DRY })).candidates[0];
  assert.strictEqual(c.eligible, true);
  assert.strictEqual(c.facts.doneVia, 'gates');
});

test('chat text "DONE" with no structured report -> blocked on a-done (real store)', { skip }, () => {
  const store = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
  const fx = fixture(V252, [{ id: 'c1', done: false }]);
  const env = { HOME: fx.home };
  const s = store.openStore({ home: fx.home, hash: 'proj-abc123', env });
  s.upsertRegistry({ id: 'c1', worktreePath: fx.byId.c1.wt, sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null });
  s.appendMessage({ workspaceId: 'c1', ts: NOW - 60 * MIN, body: 'DONE: feat/c1 — all merged, archive me', sender: 'c1', mtype: 'broadcast' });
  const summaryNoGate = store.computeSummary(s, { home: fx.home, env, now: NOW });
  s.setGate({ workspaceId: 'c1', name: 'done', value: true, setBy: 'devswarm-cli' });
  const summaryGate = store.computeSummary(s, { home: fx.home, env, now: NOW });
  s.close();
  // unread is irrelevant to gate (a); zero it so only a-done can differ.
  for (const sum of [summaryNoGate, summaryGate]) sum.workspaces.c1.unread = 0;
  const deps = Object.assign({}, fx.deps, { summary: () => summaryNoGate });
  const blocked = L.planAutoArchive(Object.assign(opts(fx, { settings: DRY }), { deps })).candidates[0];
  assert.deepStrictEqual(blocked.blockers.map((b) => b.gate), ['a-done']);
  deps.summary = () => summaryGate;
  const ok = L.planAutoArchive(Object.assign(opts(fx, { settings: DRY }), { deps })).candidates[0];
  assert.strictEqual(ok.eligible, true, JSON.stringify(ok.blockers));
  assert.strictEqual(summaryGate.workspaces.c1.archive_ready, false, 'archive_ready meaning unchanged for other consumers');
});

// P1-B — the done gate is tied to the HEAD it was reported at, and the app's PR
// record never overrides a resolved git "not an ancestor".
const blockersOf = (fx) => L.planAutoArchive(opts(fx, { settings: DRY })).candidates[0].blockers.map((b) => b.gate);

test('P1-B squash-merged PR + branch reused with new commits (done at the old HEAD) -> blocked', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', done: false, gates: { done: true }, doneHead: 'old-sha', head: 'new-sha', ancestor: false, pr: 'merged' }]);
  assert.deepStrictEqual(L.autoArchiveSweep(opts(fx, { settings: DRY })).wouldArchive, []);
  assert.deepStrictEqual(blockersOf(fx), ['a-done', 'b-merged']);
  const c = L.planAutoArchive(opts(fx, { settings: DRY })).candidates[0];
  assert.strictEqual(c.facts.doneVia, 'stale-head');
  assert.match(c.blockers[0].detail, /done reported at old-sha but HEAD is now new-sha/);
  // The child re-reports done at the new HEAD: still blocked, the old merged
  // PR does not prove the new commits.
  fx.byId.c1.doneHead = 'new-sha';
  assert.deepStrictEqual(blockersOf(fx), ['b-merged']);
  assert.strictEqual(L.planAutoArchive(opts(fx, { settings: DRY })).candidates[0].facts.merged.via, 'git:not-ancestor');
});

test('P1-B done at the old HEAD, new HEAD, merge proven by git -> still blocked on a-done', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', done: false, gates: { done: true }, doneHead: 'old-sha', head: 'new-sha' }]);
  assert.deepStrictEqual(blockersOf(fx), ['a-done']);
  fx.byId.c1.doneHead = 'new-sha'; // re-reported at the current HEAD
  assert.strictEqual(L.planAutoArchive(opts(fx, { settings: DRY })).candidates[0].eligible, true);
});

test('P1-B non-ancestor + merged PR -> blocked, even for a HEAD-bound done-report', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', done: false, gates: { done: true }, doneHead: 'abc', ancestor: false, pr: 'merged' }]);
  assert.deepStrictEqual(L.planAutoArchive(opts(fx, { settings: DRY })).toArchive, []);
  assert.deepStrictEqual(blockersOf(fx), ['b-merged']);
  assert.strictEqual(L.planAutoArchive(opts(fx, { settings: DRY })).candidates[0].facts.merged.via, 'git:not-ancestor');
});

// Squash merge: git ancestry says "not an ancestor", and the app DB carries no
// PR head sha to bind a merged PR to HEAD, so a squash-merged lane stays
// blocked (manual archive) — a merged PR row never overrides git.
test('squash-merged PR (not an ancestor) with a done-report at HEAD -> blocked', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', done: false, gates: { done: true }, head: 'sq-sha', doneHead: 'sq-sha', ancestor: false, pr: 'merged' }]);
  assert.deepStrictEqual(blockersOf(fx), ['b-merged']);
  assert.strictEqual(L.planAutoArchive(opts(fx, { settings: DRY })).candidates[0].facts.merged.via, 'git:not-ancestor');
});

// A `merged` gate the gate verb VERIFIED at the current HEAD proves gate (b)
// when git cannot decide; unverified, or verified at an older HEAD, never does.
test('verified merged gate at HEAD proves gate (b) when git is undeterminable', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', done: false, gates: { done: true, merged: true, merged_verified: true }, head: 'h1', refsMissing: true, mergedVerified: true, mergedVerifiedHead: 'h1' }]);
  const c = L.planAutoArchive(opts(fx, { settings: DRY })).candidates[0];
  assert.strictEqual(c.eligible, true, JSON.stringify(c.blockers));
  assert.strictEqual(c.facts.merged.via, 'gate:merged_verified');
  // verified at an OLDER HEAD (new commit since): blocked
  fx.byId.c1.head = 'h2';
  assert.deepStrictEqual(blockersOf(fx), ['b-merged']);
  fx.byId.c1.head = 'h1';
  // merged gate set but NOT verified: blocked
  fx.byId.c1.mergedVerified = false;
  assert.deepStrictEqual(blockersOf(fx), ['b-merged']);
  fx.byId.c1.mergedVerified = true;
  // verified row but the merged gate itself cleared: blocked
  fx.byId.c1.gates = { done: true, merged: false, merged_verified: true };
  assert.deepStrictEqual(blockersOf(fx), ['b-merged']);
  // git resolves "not an ancestor" -> blocked even with a verified gate at HEAD
  fx.byId.c1.gates = { done: true, merged: true, merged_verified: true };
  fx.byId.c1.refsMissing = false; fx.byId.c1.ancestor = false;
  assert.deepStrictEqual(blockersOf(fx), ['b-merged']);
  assert.strictEqual(L.planAutoArchive(opts(fx, { settings: DRY })).candidates[0].facts.merged.via, 'git:not-ancestor');
});

test('squash-merged PR + a new commit on top (re-reported done) -> blocked', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', done: false, gates: { done: true }, head: 'new-sha', doneHead: 'new-sha', ancestor: false, pr: 'merged' }]);
  assert.deepStrictEqual(blockersOf(fx), ['b-merged']);
  assert.strictEqual(L.planAutoArchive(opts(fx, { settings: DRY })).candidates[0].facts.merged.via, 'git:not-ancestor');
});

test('ancestry path unchanged: HEAD an ancestor -> proven by git, PR row irrelevant', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', done: false, gates: { done: true }, head: 'h1', doneHead: 'h1', pr: 'closed' }]);
  const c = L.planAutoArchive(opts(fx, { settings: DRY })).candidates[0];
  assert.strictEqual(c.eligible, true, JSON.stringify(c.blockers));
  assert.match(c.facts.merged.via, /^git:/);
});

test('P1-B PR fallback only when ancestry is undeterminable, and only for a HEAD-bound done-report', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', done: false, gates: { done: true }, doneHead: 'abc', refsMissing: true, pr: 'merged' }]);
  const c = L.planAutoArchive(opts(fx, { settings: DRY })).candidates[0];
  assert.strictEqual(c.eligible, true, JSON.stringify(c.blockers));
  assert.strictEqual(c.facts.merged.via, 'pr');
  // A sha-less (manual) done gets no PR fallback: git proof only.
  fx.byId.c1.doneHead = undefined;
  assert.deepStrictEqual(blockersOf(fx), ['b-merged']);
  // Nor does the all-gates path.
  fx.byId.c1.done = true; fx.byId.c1.gates = { done: true, merged: true, tests_passed: true };
  assert.deepStrictEqual(blockersOf(fx), ['b-merged']);
});

test('P1-B manual `gate --set done` (no sha) still works for the Primary, with git-ancestry proof', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', done: false, gates: { done: true }, pr: 'merged' }]);
  const c = L.planAutoArchive(opts(fx, { settings: DRY })).candidates[0];
  assert.strictEqual(c.eligible, true, JSON.stringify(c.blockers));
  assert.strictEqual(c.facts.doneVia, 'done-gate');
  assert.match(c.facts.merged.via, /^git:/);
  fx.byId.c1.ancestor = false; // the merged PR row is present, git says no
  assert.deepStrictEqual(blockersOf(fx), ['b-merged']);
});

// REAL git + the REAL gate verb + the REAL store (no fake git): gate (b) and
// `gate --set merged` run the SAME proof (gitMergeProof). Field shape: the
// lane's HEAD is in origin/main, but local `main` is stale (behind).
function realGit(dir, args) {
  const r = require('node:child_process').spawnSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com'].concat(args), { encoding: 'utf8' });
  if (r.status !== 0 && args[0] !== 'merge-base') throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return { status: r.status, out: String(r.stdout || '').trim() };
}
function commitFile(dir, name) {
  fs.writeFileSync(path.join(dir, name), name);
  realGit(dir, ['add', name]);
  realGit(dir, ['commit', '-q', '-m', name]);
  return realGit(dir, ['rev-parse', 'HEAD']).out;
}
// realLane(fx) -> the c1 worktree as a real repo on feat/c1, merged into
// origin/main by a fast-forward push, with local `main` left one commit behind.
function realLane(fx) {
  const wt = fx.byId.c1.wt;
  const remote = path.join(fx.base, 'remote.git');
  require('node:child_process').spawnSync('git', ['init', '-q', '--bare', remote]);
  realGit(wt, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(wt, '.gitignore'), '.anti-hall/\n');
  realGit(wt, ['add', '.gitignore']);
  commitFile(wt, 'base');
  realGit(wt, ['remote', 'add', 'origin', remote]);
  realGit(wt, ['push', '-q', 'origin', 'main']);
  realGit(wt, ['remote', 'set-head', 'origin', 'main']);
  realGit(wt, ['checkout', '-q', '-b', 'feat/c1']);
  const head = commitFile(wt, 'work');
  realGit(wt, ['push', '-q', 'origin', 'HEAD:main']); // the merge; also advances origin/main locally
  return { wt, head };
}
function realSummary(fx, wt) {
  const store = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
  const repoKey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js')).repoKeyForWorktree(wt);
  const s = store.openStore({ home: fx.home, hash: repoKey, backend: 'journal', env: {} });
  try { const sum = store.computeSummary(s, { home: fx.home, env: {}, now: NOW }); sum.workspaces.c1.unread = 0; return sum; }
  finally { s.close(); }
}
function realDeps(fx, wt) {
  const deps = Object.assign({}, fx.deps, { summary: () => realSummary(fx, wt) });
  delete deps.git; // the real git
  return deps;
}
const vctx = (fx, wt) => ({ home: fx.home, backend: 'journal', env: {}, cwd: wt });

test('REAL git: verified merged gate at HEAD + stale local main -> proven; verb and gate (b) agree', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', done: false }]);
  const { wt, head } = realLane(fx);
  // non-vacuous: HEAD is NOT in the stale local main, IS in origin/main
  assert.strictEqual(realGit(wt, ['merge-base', '--is-ancestor', 'HEAD', 'main']).status, 1);
  assert.strictEqual(realGit(wt, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']).status, 0);
  assert.strictEqual(dw.run(['register', 'c1', '--worktree', wt, '--session', 's'], vctx(fx, wt)).result.ok, true);
  const g = dw.run(['gate', 'c1', '--set', 'done,merged,tests_passed'], vctx(fx, wt)).result;
  assert.strictEqual(g.gates.merged_verified, true);
  const sum = realSummary(fx, wt);
  assert.strictEqual(sum.workspaces.c1.mergedVerifiedHead, head, 'the verb binds its verdict to HEAD');
  const deps = realDeps(fx, wt);
  const c = L.planAutoArchive(Object.assign(opts(fx, { settings: DRY }), { deps })).candidates[0];
  assert.strictEqual(c.eligible, true, JSON.stringify(c.blockers));
  assert.strictEqual(c.facts.merged.via, 'git:origin/main');
  // origin/main unavailable locally (git undeterminable): the verified gate at HEAD proves it
  const originMain = realGit(wt, ['rev-parse', 'origin/main']).out;
  realGit(wt, ['update-ref', '-d', 'refs/remotes/origin/main']);
  const c2 = L.planAutoArchive(Object.assign(opts(fx, { settings: DRY }), { deps })).candidates[0];
  assert.strictEqual(c2.eligible, true, JSON.stringify(c2.blockers));
  assert.strictEqual(c2.facts.merged.via, 'gate:merged_verified');
  // a new commit after the verified merge: blocked, with or without origin/main
  commitFile(wt, 'more');
  const blocked = () => L.planAutoArchive(Object.assign(opts(fx, { settings: DRY }), { deps })).candidates[0];
  assert.deepStrictEqual(blocked().blockers.map((b) => b.gate), ['b-merged']);
  assert.strictEqual(blocked().facts.merged.via, 'unproven');
  realGit(wt, ['update-ref', 'refs/remotes/origin/main', originMain]);
  assert.deepStrictEqual(blocked().blockers.map((b) => b.gate), ['b-merged']);
  assert.strictEqual(blocked().facts.merged.via, 'git:not-ancestor');
});

test('REAL git: unverified merged gate (HEAD not in origin/main) never proves gate (b)', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', done: false }]);
  const { wt } = realLane(fx);
  commitFile(wt, 'unmerged'); // HEAD now ahead of origin/main
  dw.run(['register', 'c1', '--worktree', wt, '--session', 's'], vctx(fx, wt));
  const g = dw.run(['gate', 'c1', '--set', 'done,merged,tests_passed'], vctx(fx, wt)).result;
  assert.strictEqual(g.gates.merged, true);
  assert.strictEqual(g.gates.merged_verified, false);
  const deps = realDeps(fx, wt);
  const c = L.planAutoArchive(Object.assign(opts(fx, { settings: DRY }), { deps })).candidates[0];
  assert.deepStrictEqual(c.blockers.map((b) => b.gate), ['b-merged']);
  realGit(wt, ['update-ref', '-d', 'refs/remotes/origin/main']); // undeterminable: still blocked
  const c2 = L.planAutoArchive(Object.assign(opts(fx, { settings: DRY }), { deps })).candidates[0];
  assert.deepStrictEqual(c2.blockers.map((b) => b.gate), ['b-merged']);
  assert.strictEqual(c2.facts.merged.via, 'unproven');
});

test('dry-run writes NOTHING and spawns no archive (even with 2.5.3 available)', { skip }, () => {
  const fx = fixture(V253, [{ id: 'c1' }]);
  L.planAutoArchive(opts(fx, { settings: DRY })); // warm the capability probe cache
  const before = listTree(fx.home);
  const r = L.autoArchiveSweep(opts(fx, { settings: DRY }));
  assert.deepStrictEqual(r.wouldArchive, ['c1']);
  assert.deepStrictEqual(r.archived, []);
  assert.deepStrictEqual(listTree(fx.home), before);
  assert.ok(!readCalls(fx.bin.callsFile).some((c) => c.argv[1] === 'archive' && c.argv[2] !== '--help'));
  assert.deepStrictEqual(fx.notified, []);
});

test('mode on + DevSwarm 2.5.2: dormant, reports, archives nothing', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1' }]);
  const r = L.autoArchiveSweep(opts(fx, { settings: ON }));
  assert.match(r.dormant, /requires DevSwarm >= 2\.5\.3/);
  assert.deepStrictEqual(r.wouldArchive, ['c1']);
  assert.deepStrictEqual(r.archived, []);
  assert.ok(!readCalls(fx.bin.callsFile).some((c) => c.argv[1] === 'archive'));
});

test('mode on + 2.5.3 fake: archives (rate-limited), logs, tells the Primary with an undo hint', { skip }, () => {
  const fx = fixture(V253, [{ id: 'c1' }, { id: 'c2' }]);
  const r = L.autoArchiveSweep(opts(fx, { settings: Object.assign({}, ON, { maxPerSweep: 1 }) }));
  assert.strictEqual(r.archived.length, 1);
  const calls = readCalls(fx.bin.callsFile).filter((c) => c.argv[1] === 'archive' && c.argv[2] !== '--help');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].argv, ['workspace', 'archive', r.archived[0]]);
  const log = fs.readFileSync(path.join(fx.home, '.anti-hall', 'logs', 'devswarm-auto-archive.ndjson'), 'utf8').trim().split('\n');
  assert.strictEqual(log.length, 1);
  assert.strictEqual(JSON.parse(log[0]).ok, true);
  assert.strictEqual(fx.notified.length, 1);
  assert.match(fx.notified[0].text, /auto-archived .*undo: unarchive/);
  // nag replacement: the sweep owns both done rows; only in mode "on".
  fs.writeFileSync(path.join(fx.home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { autoArchive: { mode: 'on' } } }));
  assert.strictEqual(L.autoArchiveOwns(fx.home, 'c2', { now: NOW, env: fx.env }), true);
  fs.writeFileSync(path.join(fx.home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { autoArchive: { mode: 'dry-run' } } }));
  assert.strictEqual(L.autoArchiveOwns(fx.home, 'c2', { now: NOW, env: fx.env }), false);
});

// 0.108.3 gate (h): the owner's only undo is unarchiving in the DevSwarm app.
// The done gate at that HEAD is still set, so without the auto-archive record
// the sweep re-archived it once the focus/idle windows passed.
test('gate (h): an owner-unarchived workspace is never re-archived at the same HEAD; a new done at a new HEAD re-arms', { skip }, () => {
  const fx = fixture(V253, [{ id: 'c1', done: false, gates: { done: true }, head: 'h1', doneHead: 'h1' }]);
  const archiveCalls = () => readCalls(fx.bin.callsFile).filter((c) => c.argv[1] === 'archive' && c.argv[2] !== '--help');
  const first = L.autoArchiveSweep(opts(fx, { settings: ON }));
  assert.deepStrictEqual(first.archived, ['c1']);
  const logFile = path.join(fx.home, '.anti-hall', 'logs', 'devswarm-auto-archive.ndjson');
  const rec = JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n')[0]);
  assert.strictEqual(rec.id, 'c1');
  assert.strictEqual(rec.doneHead, 'h1');
  assert.strictEqual(rec.at, NOW);
  // The fake archive never touches the app DB: c1 reads open again, exactly
  // what the owner's unarchive leaves behind. Later sweeps, windows long past:
  const later = { now: NOW + 5 * 60 * MIN };
  const again = L.autoArchiveSweep(opts(fx, Object.assign({ settings: ON }, later)));
  assert.deepStrictEqual(again.archived, []);
  assert.deepStrictEqual(again.wouldArchive, []);
  assert.strictEqual(archiveCalls().length, 1, 'no second archive spawn');
  const c = L.planAutoArchive(opts(fx, Object.assign({ settings: DRY }, later))).candidates[0];
  assert.deepStrictEqual(c.blockers.map((b) => b.gate), ['h-rearchive']);
  assert.strictEqual(c.soft, false, 'the sweep does not own it (not idle/viewed-only)');
  // A new done-report at a new HEAD makes it eligible again.
  fx.byId.c1.head = 'h2'; fx.byId.c1.doneHead = 'h2';
  const third = L.autoArchiveSweep(opts(fx, Object.assign({ settings: ON }, later)));
  assert.deepStrictEqual(third.archived, ['c1']);
  assert.strictEqual(archiveCalls().length, 2);
  // ...and is again protected at h2.
  assert.deepStrictEqual(L.autoArchiveSweep(opts(fx, Object.assign({ settings: ON }, later))).archived, []);
});

test('mode off: nothing planned, nothing spawned', { skip }, () => {
  const fx = fixture(V253, [{ id: 'c1' }]);
  const r = L.autoArchiveSweep(opts(fx, { settings: { mode: 'off', idleMin: 30, maxPerSweep: 3 } }));
  assert.deepStrictEqual(r, { mode: 'off', archived: [] });
  assert.deepStrictEqual(readCalls(fx.bin.callsFile), []);
});

test('settings: default ON; dry-run/off selectable; junk falls back to on', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-lc-set-'));
  assert.deepStrictEqual(L.readSettings(home), { mode: 'on', idleMin: 30, maxPerSweep: 3 });
  fs.mkdirSync(path.join(home, '.anti-hall'));
  fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { autoArchive: { mode: 'on', idleMin: 45, maxPerSweep: 99 } } }));
  assert.deepStrictEqual(L.readSettings(home), { mode: 'on', idleMin: 45, maxPerSweep: 20 });
  fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { autoArchive: { mode: 'yes', idleMin: 1 } } }));
  // v0.108.0 unified settings: out-of-range numbers CLAMP to the schema bound
  // (idleMin min 5), junk enums fall back to the default.
  assert.deepStrictEqual(L.readSettings(home), { mode: 'on', idleMin: 5, maxPerSweep: 3 });
  // the flat form `settings.js set` writes is read too
  fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { 'autoArchive.mode': 'dry-run', 'autoArchive.idleMin': 60 } }));
  assert.deepStrictEqual(L.readSettings(home), { mode: 'dry-run', idleMin: 60, maxPerSweep: 3 });
  // env beats the file
  assert.strictEqual(L.readSettings(home, null, { ANTIHALL_DEVSWARM_AUTO_ARCHIVE_MODE: 'off' }).mode, 'off');
  fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { autoArchive: { mode: 'dry-run' } } }));
  assert.strictEqual(L.readSettings(home).mode, 'dry-run');
  fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { autoArchive: { mode: 'off' } } }));
  assert.strictEqual(L.readSettings(home).mode, 'off');
});

// ---------------- prune ----------------
const DAY = 86400000;
function pruneFixture(fake, children) {
  const fx = fixture(fake, children.map((c) => Object.assign({ archived: true }, c)));
  const dir = path.join(fx.home, '.anti-hall', 'devswarm', 'archived');
  fs.mkdirSync(dir, { recursive: true });
  for (const c of children) fs.writeFileSync(path.join(dir, c.id + '.json'), '{}');
  return fx;
}
const LATER = Date.now() + 40 * DAY; // markers were written "now"; plan 40 days later

test('prune dry run: evidence per row, nonce plan stored, nothing deleted', { skip }, () => {
  const fx = pruneFixture(V253, [{ id: 'a1' }, { id: 'a2', porcelain: '?? tmp\n' }]);
  const r = L.planPrune(opts(fx, { now: LATER, olderThanDays: 30 }));
  assert.strictEqual(r.ok, true);
  assert.match(r.nonce, /^[0-9a-f]{16}$/);
  assert.deepStrictEqual(r.eligibleIds, ['a1']);
  const a1 = r.rows.find((x) => x.id === 'a1');
  for (const k of ['archivedSince', 'ageDays', 'merged', 'uncommitted', 'unread', 'worktreeBytes']) assert.ok(k in a1, k);
  assert.ok(a1.ageDays >= 39);
  assert.deepStrictEqual(r.rows.find((x) => x.id === 'a2').blockers, ['uncommitted-changes']);
  assert.ok(fs.existsSync(path.join(fx.home, '.anti-hall', 'devswarm', 'prune-plans', r.nonce + '.json')));
  assert.ok(!readCalls(fx.bin.callsFile).some((c) => c.argv[1] === 'delete' && c.argv[2] !== '--help'));
  const young = L.planPrune(opts(fx, { now: Date.now(), olderThanDays: 30 }));
  assert.deepStrictEqual(young.eligibleIds, []);
});

test('prune refuses without a valid plan nonce / exact ids / fresh plan', { skip }, () => {
  const fx = pruneFixture(V253, [{ id: 'a1' }, { id: 'a3' }]);
  const plan = L.planPrune(opts(fx, { now: LATER, olderThanDays: 30 }));
  const ex = (x) => L.executePrune(opts(fx, Object.assign({ now: LATER }, x)));
  assert.match(ex({ ids: ['a1', 'a3'] }).error, /requires --plan/);
  assert.match(ex({ ids: ['a1', 'a3'], nonce: '0000000000000000' }).error, /unknown plan/);
  assert.match(ex({ ids: ['a1'], nonce: plan.nonce }).error, /exactly match/);
  assert.match(ex({ ids: ['a1', 'a3', 'x'], nonce: plan.nonce }).error, /exactly match/);
  assert.match(L.executePrune(opts(fx, { now: LATER + 16 * MIN, ids: ['a1', 'a3'], nonce: plan.nonce })).error, /expired/);
  assert.ok(!readCalls(fx.bin.callsFile).some((c) => c.argv[1] === 'delete' && c.argv[2] !== '--help'));
});

test('supervisor/automated caller can never delete (lib throws; CLI refuses)', { skip }, () => {
  const fx = pruneFixture(V253, [{ id: 'a1' }]);
  const plan = L.planPrune(opts(fx, { now: LATER, olderThanDays: 30 }));
  const env = Object.assign({}, fx.env, { ANTIHALL_CALLER: 'supervisor' });
  assert.throws(() => L.executePrune(opts(fx, { env, now: LATER, ids: ['a1'], nonce: plan.nonce })), /refused: caller "supervisor"/);
  const r = dw.run(['prune-archived', '--confirm-ids', 'a1', '--plan', plan.nonce], { home: fx.home, env });
  assert.strictEqual(r.code, 2);
  assert.ok(!readCalls(fx.bin.callsFile).some((c) => c.argv[1] === 'delete' && c.argv[2] !== '--help'));
});

test('prune on DevSwarm 2.5.2: plan is dormant, deletion refused', { skip }, () => {
  const fx = pruneFixture(V252, [{ id: 'a1' }]);
  const plan = L.planPrune(opts(fx, { now: LATER, olderThanDays: 30 }));
  assert.match(plan.dormant, /requires DevSwarm >= 2\.5\.3/);
  const r = L.executePrune(opts(fx, { now: LATER, ids: ['a1'], nonce: plan.nonce }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.dormant, true);
});

test('approved prune: re-verifies, deletes via hivecontrol, logs, tombstones, plan single-use', { skip }, () => {
  const fx = pruneFixture(V253, [{ id: 'a1' }, { id: 'a3' }]);
  const plan = L.planPrune(opts(fx, { now: LATER, olderThanDays: 30 }));
  assert.deepStrictEqual(plan.eligibleIds, ['a1', 'a3']);
  fx.byId.a3.porcelain = ' M dirty\n'; // became dirty after the dry run
  const archivedDesc = [];
  const r = L.executePrune(opts(fx, { now: LATER, ids: ['a3', 'a1'], nonce: plan.nonce, archiveDescriptor: (id) => { archivedDesc.push(id); return { ok: true }; } }));
  assert.strictEqual(r.ok, false, 'one row refused');
  assert.deepStrictEqual(r.results.find((x) => x.id === 'a3'), { id: 'a3', ok: false, refused: 'uncommitted-changes' });
  assert.strictEqual(r.results.find((x) => x.id === 'a1').ok, true);
  const dels = readCalls(fx.bin.callsFile).filter((c) => c.argv[1] === 'delete' && c.argv[2] !== '--help');
  assert.deepStrictEqual(dels.map((c) => c.argv), [['workspace', 'delete', 'a1']]);
  const log = fs.readFileSync(path.join(fx.home, '.anti-hall', 'logs', 'devswarm-prune.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(log.map((x) => [x.id, x.ok]), [['a1', true], ['a3', false]]);
  assert.ok(fs.existsSync(path.join(fx.home, '.anti-hall', 'devswarm', 'pruned', 'a1.json')));
  assert.match(L.executePrune(opts(fx, { now: LATER, ids: ['a1', 'a3'], nonce: plan.nonce })).error, /already used/);
});

test('notifyPrimary lands ONE line in the Primary partition through the partition door (real store)', { skip }, () => {
  const store = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
  const identity = require(path.join(ROOT, 'companion', 'lib', 'identity.js'));
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-lc-notify-')));
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  const repo = path.join(base, 'repo'); fs.mkdirSync(repo);
  const g = require('node:child_process').spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  assert.strictEqual(g.status, 0, g.stderr);
  const idc = identity.resolveContext(repo);
  const env = { HOME: home };
  const s = store.openStore({ home, hash: idc.repoKey, env });
  s.upsertRegistry({ id: idc.primaryMeshId, worktreePath: repo, sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null });
  s.close();
  const cand = { id: 'c1', worktreePath: repo, repoKey: idc.repoKey };
  assert.strictEqual(L.notifyPrimary(home, cand, 'auto-archived "x" (c1). ' + L.UNDO_HINT + '.', { env }), 'ok');
  assert.strictEqual(L.notifyPrimary(home, cand, 'auto-archived "x" (c1). again', { env }), 'ok'); // same hash: deduped
  const s2 = store.openStore({ home, hash: idc.repoKey, env, readOnly: true });
  const rows = s2.listMessages(idc.primaryMeshId);
  s2.close();
  assert.strictEqual(rows.length, 1);
  assert.match(rows[0].body, /undo: unarchive/);
});

test('DEFAULT (no settings file) + 2.5.3 fake: archives and reports with an undo hint', { skip }, () => {
  const fx = fixture(V253, [{ id: 'c1' }]);
  const r = L.autoArchiveSweep(opts(fx)); // no `settings` override -> reads the (absent) file -> default
  assert.strictEqual(r.mode, 'on');
  assert.deepStrictEqual(r.archived, ['c1']);
  assert.strictEqual(fx.notified.length, 1);
  assert.match(fx.notified[0].text, /undo: unarchive/);
});

test('DEFAULT (no settings file) + 2.5.2: dormant, nothing archived', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1' }]);
  const r = L.autoArchiveSweep(opts(fx));
  assert.strictEqual(r.mode, 'on');
  assert.match(r.dormant, /requires DevSwarm >= 2\.5\.3/);
  assert.deepStrictEqual(r.archived, []);
  assert.ok(!readCalls(fx.bin.callsFile).some((c) => c.argv[1] === 'archive'));
});

// DevSwarm 2.5.3: archive/delete with no argument act on the CURRENT workspace.
test('verbArgv always passes the explicit workspace id, never --yes; no id -> no call', () => {
  const detail = { args: [{ name: 'idOrBranch', required: false }], flags: ['-h', '--help'] };
  assert.deepStrictEqual(L.verbArgv('archive', detail, { id: 'ws-1', branch: 'feat/x' }), ['workspace', 'archive', 'ws-1']);
  assert.deepStrictEqual(L.verbArgv('delete', {}, { id: 'ws-2' }), ['workspace', 'delete', 'ws-2'], 'help parse failure still passes the id');
  assert.deepStrictEqual(L.verbArgv('delete', { flags: ['--yes'] }, { id: 'ws-3' }), ['workspace', 'delete', 'ws-3']);
  assert.strictEqual(L.verbArgv('delete', detail, { branch: 'feat/x' }), null);
  assert.strictEqual(L.verbArgv('archive', detail, { id: '' }), null);
  assert.strictEqual(L.verbArgv('archive', detail, { id: '--help' }), null);
});

// 0.108.3 Fix B — gate (e) authority. A legacy CHILD descriptor labelled
// `primary-<hash>` (the child worktree's label, e.g. primary-af7e82fd sharing a
// standard builder's worktree) must not make that builder count as the Primary.
function withLegacyLabel(fx, id, label) {
  const f = fx.byId[id];
  const descs = fx.deps.descriptors;
  return Object.assign({}, fx.deps, {
    descriptors: () => descs().concat([{ id: label, worktreePath: f.wt, sessionId: null }]),
    activityTs: (d) => (d.id === label ? null : fx.byId[d.id].activity),
  });
}

test('standard builder + legacy primary-<hash> descriptor on the same worktree is NOT the Primary', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1' }]);
  const deps = withLegacyLabel(fx, 'c1', 'primary-af7e82fd');
  const c = L.planAutoArchive(Object.assign(opts(fx, { settings: DRY }), { deps })).candidates[0];
  assert.ok(c.facts && c.id === 'c1');
  assert.ok(!c.blockers.some((b) => b.gate === 'e-primary'), JSON.stringify(c.blockers));
  assert.strictEqual(c.eligible, true, JSON.stringify(c.blockers));
});

test('a real builderType primary is still blocked, with or without a legacy label', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1', builderType: 'primary' }]);
  const deps = withLegacyLabel(fx, 'c1', 'primary-af7e82fd');
  const c = L.planAutoArchive(Object.assign(opts(fx, { settings: DRY }), { deps })).candidates[0];
  assert.deepStrictEqual(c.blockers.map((b) => b.gate), ['e-primary']);
});

test('app DB unreadable -> nothing archived (fail-safe), readable -> archived', { skip }, () => {
  const fx = fixture(V252, [{ id: 'c1' }]);
  assert.deepStrictEqual(L.autoArchiveSweep(opts(fx, { settings: DRY })).wouldArchive, ['c1']);
  fs.writeFileSync(fx.env.ANTIHALL_DEVSWARM_APP_DB, 'not a sqlite database');
  const plan = L.planAutoArchive(opts(fx, { settings: DRY }));
  assert.strictEqual(plan.reason, 'app-db-unavailable');
  assert.deepStrictEqual(plan.toArchive, []);
  assert.deepStrictEqual(L.autoArchiveSweep(opts(fx, { settings: ON })).archived, []);
});

test('no builderType column: the Primary seat (main checkout) decides, never the primary- id prefix', { skip }, () => {
  const cp = require('node:child_process');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-lifecycle-seat-')));
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  const repo = path.join(base, 'main');
  cp.spawnSync('git', ['init', '-q', repo]);
  cp.spawnSync('git', ['-C', repo, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
  // gate (b) proves against the REMOTE default branch: give the repo an origin.
  cp.spawnSync('git', ['init', '-q', '--bare', path.join(base, 'remote.git')]);
  cp.spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', path.join(base, 'remote.git')]);
  cp.spawnSync('git', ['-C', repo, 'push', '-q', 'origin', 'HEAD:main']);
  cp.spawnSync('git', ['-C', repo, 'remote', 'set-head', 'origin', 'main']);
  const child = path.join(base, 'child');
  cp.spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', child, '-b', 'feat/child']);
  const dbFile = path.join(base, 'devswarm.db');
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, sourceBranch TEXT, worktreePath TEXT,'
    + ' isActive INTEGER, isHidden INTEGER, lastSelectedAt TEXT, label TEXT, pullRequestId TEXT)');
  const ins = db.prepare('INSERT INTO builders VALUES (?,?,?,?,?,?,?,?,?,?)');
  ins.run('p-1', 'r1', 'main', null, repo, 1, 0, null, 'Primary', null);
  ins.run('c1', 'r1', 'feat/child', 'main', child, 1, 0, null, 'Child', null);
  db.close();
  try {
    const bin = fakeHivecontrol(path.join(base, 'bin'), V252);
    const env = { HOME: home, PATH: bin.dir + path.delimiter + process.env.PATH, ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
    caps.resetCache();
    const descs = [
      { id: 'c1', worktreePath: child }, { id: 'primary-af7e82fd', worktreePath: child }, // legacy child label
      { id: 'p-1', worktreePath: repo },
    ];
    const deps = {
      descriptors: () => descs,
      repoKey: () => 'proj-abc123',
      summary: () => ({ workspaces: { c1: { id: 'c1', archive_ready: true, gates: {}, unread: 0, broadcastUnread: 0 }, 'p-1': { id: 'p-1', archive_ready: true, gates: {}, unread: 0, broadcastUnread: 0 } } }),
      unreadFrom: () => 0,
      activityTs: () => NOW - 60 * MIN,
    };
    const plan = L.planAutoArchive({ home, env, now: NOW, deps, settings: DRY });
    assert.strictEqual(plan.ok, true, JSON.stringify(plan));
    const c1 = plan.candidates.find((c) => c.id === 'c1');
    const p1 = plan.candidates.find((c) => c.id === 'p-1');
    assert.ok(!c1.blockers.some((b) => b.gate === 'e-primary'), JSON.stringify(c1.blockers));
    assert.strictEqual(c1.eligible, true, JSON.stringify(c1.blockers));
    assert.ok(p1.blockers.some((b) => b.gate === 'e-primary'), 'the main checkout stays the Primary: ' + JSON.stringify(p1.blockers));
    assert.deepStrictEqual(plan.toArchive, ['c1']);
  } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {} }
});

// P2 — the builderType column exists but the row's value is NULL or empty:
// fall through to the Primary seat's main-checkout rule (fail safe), never
// "not primary".
for (const [label, bt] of [['NULL', null], ['empty', ''], ['whitespace-only', '  \t ']]) {
  test('builderType column present but ' + label + ' for the row: the main-checkout rule decides', { skip }, () => {
    const cp = require('node:child_process');
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-lifecycle-btnull-')));
    const home = path.join(base, 'home'); fs.mkdirSync(home);
    const repo = path.join(base, 'main');
    cp.spawnSync('git', ['init', '-q', repo]);
    cp.spawnSync('git', ['-C', repo, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
    // gate (b) proves against the REMOTE default branch: give the repo an origin.
    cp.spawnSync('git', ['init', '-q', '--bare', path.join(base, 'remote.git')]);
    cp.spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', path.join(base, 'remote.git')]);
    cp.spawnSync('git', ['-C', repo, 'push', '-q', 'origin', 'HEAD:main']);
    cp.spawnSync('git', ['-C', repo, 'remote', 'set-head', 'origin', 'main']);
    const child = path.join(base, 'child');
    cp.spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', child, '-b', 'feat/child']);
    const dbFile = path.join(base, 'devswarm.db');
    const db = new sqlite.DatabaseSync(dbFile);
    db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, sourceBranch TEXT, worktreePath TEXT,'
      + ' builderType TEXT, isActive INTEGER, isHidden INTEGER, lastSelectedAt TEXT, label TEXT, pullRequestId TEXT)');
    const ins = db.prepare('INSERT INTO builders VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    ins.run('p-1', 'r1', 'main', null, repo, bt, 1, 0, null, 'Primary', null);
    ins.run('c1', 'r1', 'feat/child', 'main', child, bt, 1, 0, null, 'Child', null);
    db.close();
    try {
      const bin = fakeHivecontrol(path.join(base, 'bin'), V252);
      const env = { HOME: home, PATH: bin.dir + path.delimiter + process.env.PATH, ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
      caps.resetCache();
      const ready = (id) => ({ id, archive_ready: true, gates: {}, unread: 0, broadcastUnread: 0 });
      const deps = {
        descriptors: () => [{ id: 'c1', worktreePath: child }, { id: 'p-1', worktreePath: repo }],
        repoKey: () => 'proj-abc123',
        summary: () => ({ workspaces: { c1: ready('c1'), 'p-1': ready('p-1') } }),
        unreadFrom: () => 0,
        activityTs: () => NOW - 60 * MIN,
      };
      const plan = L.planAutoArchive({ home, env, now: NOW, deps, settings: DRY });
      assert.strictEqual(plan.ok, true, JSON.stringify(plan));
      const p1 = plan.candidates.find((c) => c.id === 'p-1');
      const c1 = plan.candidates.find((c) => c.id === 'c1');
      assert.ok(p1.blockers.some((b) => b.gate === 'e-primary'), 'the main checkout stays the Primary: ' + JSON.stringify(p1.blockers));
      assert.ok(!c1.blockers.some((b) => b.gate === 'e-primary'), JSON.stringify(c1.blockers));
      assert.deepStrictEqual(plan.toArchive, ['c1']);
      // primary-seat.js applies the same rule (whitespace-only = unknown).
      const seat = require(path.join(ROOT, 'companion', 'lib', 'primary-seat.js'));
      const appDb = require(path.join(ROOT, 'companion', 'lib', 'devswarm-app-db.js'));
      const row = appDb.builderForWorktree({ home, env, worktreePath: repo });
      assert.strictEqual(row && row.id, 'p-1', 'the app DB row is read (non-vacuous): ' + JSON.stringify(row));
      assert.ok(seat.primaryCheckout({ home, env, cwd: repo }), 'main checkout is the Primary seat');
      assert.strictEqual(seat.primaryCheckout({ home, env, cwd: child }), null);
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {} }
  });
}

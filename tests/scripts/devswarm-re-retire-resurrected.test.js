'use strict';
// Item 6, defect df54edf54804 field aftermath — SkyCrew's `roster --json` on
// 0.99.0 showed ~43 legacy-slug registry rows (the resurrected worktree-group
// family) still sitting in the store after the migration gate (companion/lib/
// devswarm-archive-gate.js) shipped: the gate stops the migration doing this
// again, but an install that ALREADY ran the buggy migration once needs a
// forward-hygiene pass to clean up what it already wrote.
//
// devswarm.js's reRetireResurrectedRows(AllStores) is that pass: forward any
// unread DIRECTS into a same-worktree archived id, then removeRegistry —
// REGISTRY ONLY, never a file — for any row that (1) has a PROVEN archive
// link (its own marker, or a worktree-group match to a DIFFERENT id's
// marker — never bare descriptor-absence alone, R2 P0 fix) AND (2) is NOT
// live by isSiblingPartitionLive.
//
// R2 fixes covered by this file: P0 (a descriptor-less row with NO archive
// link must never be a candidate at all — mail stranded otherwise), P1
// (each candidate's classify+forward+remove runs under withIdLock with a
// fresh re-read), and the "no forward target" / forward-failure classes
// that leave a row in place as `unhealable` instead of guessing.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const repoKeyLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const updateMod = require(path.join(ROOT, 'skills', 'update', 'scripts', 'update.js'));
const { DEFAULT_ROSTER_IDLE_MS } = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));

const STALE_MS = DEFAULT_ROSTER_IDLE_MS + 60 * 60 * 1000;

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-reretire-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces'), { recursive: true });
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'archived'), { recursive: true });
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'heartbeats'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-reretire-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function backend() { return (storeLib.sqliteAvailable && storeLib.sqliteAvailable()) ? 'sqlite' : 'journal'; }
function repoKeyOf(repo) { return repoKeyLib.repoKeyForWorktree(repo); }
function seedUnread(home, repo, id, n) {
  const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
  try {
    for (let i = 0; i < n; i++) {
      const f = { from: 'p', to: id, type: 'direct', message: 'm-' + id + '-' + i, timestamp: Date.now(), urgency: 'normal' };
      storeLib.appendMeshMessage(s, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
    }
  } finally { s.close(); }
}
function writeStaleDescriptor(home, id, wt, sessionId) {
  const p = path.join(home, '.anti-hall', 'devswarm', 'workspaces', id + '.json');
  fs.writeFileSync(p, JSON.stringify({ id, worktreePath: wt, sessionId }));
  const old = new Date(Date.now() - STALE_MS);
  fs.utimesSync(p, old, old);
  return p;
}
function upsertResurrectedRow(home, repo, id, wt, sessionId) {
  const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
  try { s.upsertRegistry({ id, worktreePath: wt, sessionId }); } finally { s.close(); }
}

test('re-retire: SkyCrew shape — archived A + resurrected legacy-slug twin T (stale, no marker): T retired, unread forwarded to A, A stays archived', () => {
  const home = tmpHome();
  const repo = makeGitRepo('main');
  try {
    const ctx = { home, env: {}, cwd: repo, now: Date.now(), backend: backend() };
    let r = cli.run(['register', 'A', '--worktree', repo, '--session', 'sess-A'], ctx);
    assert.equal(r.code, 0, JSON.stringify(r.result));
    r = cli.run(['archive', 'A'], ctx);
    assert.equal(r.code, 0, JSON.stringify(r.result));

    // T: legacy-slug twin — descriptor present (stale mtime, no heartbeat),
    // NO archived/T.json marker of its own, but a registry row a prior
    // (pre-fix) migration run resurrected — exactly the shape traced from
    // SkyCrew's field data.
    writeStaleDescriptor(home, 'T', repo, 'sess-T-dead');
    upsertResurrectedRow(home, repo, 'T', repo, 'sess-T-dead');
    seedUnread(home, repo, 'T', 2);

    const repoKey = repoKeyOf(repo);
    const before = cli.reRetireResurrectedRows(home, { now: Date.now(), repoKey });
    assert.equal(before.candidates, 1);
    assert.equal(before.reRetired, 1);
    assert.equal(before.forwarded, 2, 'both unread DIRECTS must forward to A');

    const s = storeLib.openStore({ home, hash: repoKey, backend: backend() });
    try {
      assert.deepEqual(s.listRegistry().filter((row) => row.id === 'T'), [], 'T must be gone');
      assert.deepEqual(s.listRegistry().filter((row) => row.id === 'A'), [], 'A stays archived (never resurrected)');
      assert.equal(s.messageCount('A') >= 2, true, 'A must have received the forwarded mail');
    } finally { s.close(); }

    const { isArchivedWorkspace } = require(path.join(ROOT, 'companion', 'lib', 'devswarm-archived.js'));
    assert.equal(isArchivedWorkspace(home, 'A', repo), true, 'A must still read as archived');
  } finally { rm(home); rm(repo); }
});

test('R2 P0: a descriptor-less row with NO archive link at all (register-only phantom, unread mail) is NEVER a candidate — mail must not be stranded', () => {
  const home = tmpHome();
  const repo = makeGitRepo('main');
  try {
    // No archive() call at all here — this repo has ZERO archived markers.
    // A plain register-only phantom: unclaimed sessionId, real unread mail,
    // no descriptor on disk. Live-run repro from the R2 critic.
    upsertResurrectedRow(home, repo, 'P', repo, 'unclaimed:P');
    seedUnread(home, repo, 'P', 3);

    const repoKey = repoKeyOf(repo);
    const rep = cli.reRetireResurrectedRows(home, { now: Date.now(), repoKey });
    assert.equal(rep.candidates, 0, 'a row with no archive link must never become a candidate');
    assert.equal(rep.reRetired, 0);
    assert.equal(rep.forwarded, 0);

    const s = storeLib.openStore({ home, hash: repoKey, backend: backend() });
    try {
      const reg = s.listRegistry().filter((row) => row.id === 'P');
      assert.equal(reg.length, 1, 'P must survive untouched');
      assert.equal(s.messageCount('P') >= 3, true, 'P\'s unread mail must not be stranded/lost');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('R2: a row whose own marker is the ONLY marker at its worktree ("no forward target") is left in place, classified unhealable', () => {
  const home = tmpHome();
  const repo = makeGitRepo('main');
  try {
    // X was archived (its own marker exists) but its registry row was ALSO
    // resurrected (a leftover, not a sibling). There is no OTHER id to
    // forward its mail into at this worktree — this pass must not guess.
    const ctx = { home, env: {}, cwd: repo, now: Date.now(), backend: backend() };
    let r = cli.run(['register', 'X', '--worktree', repo, '--session', 'sess-X'], ctx);
    assert.equal(r.code, 0);
    r = cli.run(['archive', 'X'], ctx);
    assert.equal(r.code, 0);
    // Resurrect X's own row with a different, stale (not live) sessionId.
    upsertResurrectedRow(home, repo, 'X', repo, 'sess-X-stale');
    const p = path.join(home, '.anti-hall', 'devswarm', 'workspaces', 'X.json');
    fs.writeFileSync(p, JSON.stringify({ id: 'X', worktreePath: repo, sessionId: 'sess-X-stale' }));
    const old = new Date(Date.now() - STALE_MS);
    fs.utimesSync(p, old, old);

    const repoKey = repoKeyOf(repo);
    const rep = cli.reRetireResurrectedRows(home, { now: Date.now(), repoKey });
    assert.equal(rep.candidates, 0, 'a no-forward-target row is not counted as a retirable candidate');
    assert.equal(rep.unhealable, 1);
    const d = rep.detail.find((x) => x.id === 'X');
    assert.ok(d, 'X must be reported');
    assert.equal(d.action, 'unhealable');
    assert.equal(d.reason, 'no-forward-target');

    const s = storeLib.openStore({ home, hash: repoKey, backend: backend() });
    try {
      assert.equal(s.listRegistry().filter((row) => row.id === 'X').length, 1, 'X must be left in place, never guessed at');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('R2 P1: a candidate whose lock is held by a concurrent operation is skipped (lock-busy), never raced', () => {
  const home = tmpHome();
  const repo = makeGitRepo('main');
  const recovery = require(path.join(ROOT, 'companion', 'lib', 'recovery.js'));
  try {
    const ctx = { home, env: {}, cwd: repo, now: Date.now(), backend: backend() };
    let r = cli.run(['register', 'A7', '--worktree', repo, '--session', 'sess-A7'], ctx);
    assert.equal(r.code, 0);
    r = cli.run(['archive', 'A7'], ctx);
    assert.equal(r.code, 0);
    writeStaleDescriptor(home, 'T7', repo, 'sess-T7-dead');
    upsertResurrectedRow(home, repo, 'T7', repo, 'sess-T7-dead');

    const release = recovery.acquireLock('T7', home);
    assert.ok(typeof release === 'function', 'test setup: must actually hold the lock');
    try {
      const repoKey = repoKeyOf(repo);
      const rep = cli.reRetireResurrectedRows(home, { now: Date.now(), repoKey });
      assert.equal(rep.reRetired, 0, 'a locked row must never be removed out from under the lock holder');
      const d = rep.detail.find((x) => x.id === 'T7');
      assert.ok(d, 'T7 must be reported even though it was skipped');
      assert.equal(d.reason, 'lock-busy');

      const s = storeLib.openStore({ home, hash: repoKey, backend: backend() });
      try {
        assert.equal(s.listRegistry().filter((row) => row.id === 'T7').length, 1, 'T7 must survive while locked');
      } finally { s.close(); }
    } finally { try { release(); } catch (_) {} }

    // Once released, a follow-up pass retires it normally.
    const repoKey2 = repoKeyOf(repo);
    const rep2 = cli.reRetireResurrectedRows(home, { now: Date.now(), repoKey: repoKey2 });
    assert.equal(rep2.reRetired, 1);
  } finally { rm(home); rm(repo); }
}, { timeout: 10000 });

test('re-retire: a genuinely live twin (fresh heartbeat) is left alone', () => {
  const home = tmpHome();
  const repo = makeGitRepo('main');
  try {
    const ctx = { home, env: {}, cwd: repo, now: Date.now(), backend: backend() };
    let r = cli.run(['register', 'A2', '--worktree', repo, '--session', 'sess-A2'], ctx);
    assert.equal(r.code, 0);
    r = cli.run(['archive', 'A2'], ctx);
    assert.equal(r.code, 0);

    const now = Date.now();
    const p = path.join(home, '.anti-hall', 'devswarm', 'workspaces', 'L.json');
    fs.writeFileSync(p, JSON.stringify({ id: 'L', worktreePath: repo, sessionId: 'sess-L-live' }));
    upsertResurrectedRow(home, repo, 'L', repo, 'sess-L-live');
    const beatPath = path.join(home, '.anti-hall', 'devswarm', 'heartbeats', 'L.json');
    fs.writeFileSync(beatPath, JSON.stringify({ sessionId: 'sess-L-live', ts: now - 60 * 1000 }));

    const repoKey = repoKeyOf(repo);
    const rep = cli.reRetireResurrectedRows(home, { now, repoKey });
    assert.equal(rep.candidates, 0);
    assert.equal(rep.skippedLive, 1);

    const s = storeLib.openStore({ home, hash: repoKey, backend: backend() });
    try {
      const reg = s.listRegistry().filter((row) => row.id === 'L');
      assert.equal(reg.length, 1, 'a proven-live twin must survive');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('re-retire: running twice is a no-op the second time', () => {
  const home = tmpHome();
  const repo = makeGitRepo('main');
  try {
    const ctx = { home, env: {}, cwd: repo, now: Date.now(), backend: backend() };
    let r = cli.run(['register', 'A3', '--worktree', repo, '--session', 'sess-A3'], ctx);
    assert.equal(r.code, 0);
    r = cli.run(['archive', 'A3'], ctx);
    assert.equal(r.code, 0);

    writeStaleDescriptor(home, 'T3', repo, 'sess-T3-dead');
    upsertResurrectedRow(home, repo, 'T3', repo, 'sess-T3-dead');

    const repoKey = repoKeyOf(repo);
    const rep1 = cli.reRetireResurrectedRows(home, { now: Date.now(), repoKey });
    assert.equal(rep1.reRetired, 1);
    const rep2 = cli.reRetireResurrectedRows(home, { now: Date.now(), repoKey });
    assert.equal(rep2.candidates, 0);
    assert.equal(rep2.reRetired, 0);
  } finally { rm(home); rm(repo); }
});

test('re-retire: dry-run classifies without writing', () => {
  const home = tmpHome();
  const repo = makeGitRepo('main');
  try {
    const ctx = { home, env: {}, cwd: repo, now: Date.now(), backend: backend() };
    let r = cli.run(['register', 'A4', '--worktree', repo, '--session', 'sess-A4'], ctx);
    assert.equal(r.code, 0);
    r = cli.run(['archive', 'A4'], ctx);
    assert.equal(r.code, 0);
    writeStaleDescriptor(home, 'T4', repo, 'sess-T4-dead');
    upsertResurrectedRow(home, repo, 'T4', repo, 'sess-T4-dead');

    const repoKey = repoKeyOf(repo);
    const rep = cli.reRetireResurrectedRows(home, { now: Date.now(), repoKey, dryRun: true });
    assert.equal(rep.candidates, 1);
    assert.equal(rep.reRetired, 0);

    const s = storeLib.openStore({ home, hash: repoKey, backend: backend() });
    try {
      assert.equal(s.listRegistry().filter((row) => row.id === 'T4').length, 1, 'dry-run must not remove anything');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

// ---- doctor repair wiring (R3 fix, defect df54edf54804) ----
// re-retire-resurrected is DELIBERATELY NOT in the default AUTO-SAFE repair
// pass (runRepairs) any more — a bare `doctor` (what anti-hall-activate runs)
// must never remove a row with no operator intent. It is EXPLICIT, OPT-IN
// ONLY: `doctor --repair-resurrected [--apply]`, same posture as
// --repair-ingest-orphans/--repair-test-stores.
function setupDoctorFixture(idPrefix) {
  const home = tmpHome();
  const repo = makeGitRepo('main');
  const ctx = { home, env: {}, cwd: repo, now: Date.now(), backend: backend() };
  const aid = idPrefix + 'A';
  const tid = idPrefix + 'T';
  let r = cli.run(['register', aid, '--worktree', repo, '--session', 'sess-' + aid], ctx);
  assert.equal(r.code, 0);
  r = cli.run(['archive', aid], ctx);
  assert.equal(r.code, 0);
  writeStaleDescriptor(home, tid, repo, 'sess-' + tid + '-dead');
  upsertResurrectedRow(home, repo, tid, repo, 'sess-' + tid + '-dead');
  return { home, repo, tid };
}
function registryHasId(home, repo, id) {
  const repoKey = repoKeyOf(repo);
  const s = storeLib.openStore({ home, hash: repoKey, backend: backend() });
  try { return s.listRegistry().filter((row) => row.id === id).length > 0; } finally { s.close(); }
}

test('doctor repair: a bare (default) runRepairs pass leaves a resurrected row untouched', () => {
  const { home, repo, tid } = setupDoctorFixture('B5');
  try {
    const doctorRepair = require(path.join(ROOT, 'hooks', 'lib', 'doctor-repair.js'));
    const results = doctorRepair.runRepairs({ home, cwd: repo, env: {}, dryRun: false });
    assert.equal(results.find((x) => x.id === 're-retire-resurrected'), undefined,
      're-retire-resurrected must not appear in the default AUTO-SAFE repair pass at all');
    assert.equal(registryHasId(home, repo, tid), true, 'a bare doctor run must never remove a resurrected row');
  } finally { rm(home); rm(repo); }
});

test('doctor repair: checkResurrectedRows (unconditional DETECT, doctor --check included) reports the candidate + the exact command', () => {
  const { home, repo, tid } = setupDoctorFixture('C5');
  try {
    const doctorRepair = require(path.join(ROOT, 'hooks', 'lib', 'doctor-repair.js'));
    const result = doctorRepair.checkResurrectedRows({ home, cwd: repo, env: {} });
    assert.ok(result, 'must report when a candidate exists');
    assert.equal(result.candidates, 1);
    assert.match(result.message, /--repair-resurrected/);
    assert.equal(registryHasId(home, repo, tid), true, 'DETECT must never write');
  } finally { rm(home); rm(repo); }
});

test('doctor repair: --repair-resurrected (no --apply) leaves the row and prints the plan', () => {
  const { home, repo, tid } = setupDoctorFixture('D5');
  try {
    const doctorRepair = require(path.join(ROOT, 'hooks', 'lib', 'doctor-repair.js'));
    const results = doctorRepair.runResurrectedRepair({ home, cwd: repo, env: {}, dryRun: true });
    const row = results.find((x) => x.id === 'repair-resurrected');
    assert.ok(row);
    assert.equal(row.status, 'skipped');
    assert.match(row.msg, /\[dry-run\] would re-retire 1/);
    assert.equal(registryHasId(home, repo, tid), true, '--repair-resurrected without --apply must never write');
  } finally { rm(home); rm(repo); }
});

test('doctor repair: --repair-resurrected --apply removes the row; a second apply is a no-op', () => {
  const { home, repo, tid } = setupDoctorFixture('E5');
  try {
    const doctorRepair = require(path.join(ROOT, 'hooks', 'lib', 'doctor-repair.js'));
    const applied = doctorRepair.runResurrectedRepair({ home, cwd: repo, env: {}, dryRun: false });
    const appliedRow = applied.find((x) => x.id === 'repair-resurrected');
    assert.ok(appliedRow);
    assert.equal(appliedRow.status, 'fixed');
    assert.equal(registryHasId(home, repo, tid), false, 'row must be gone after --apply');

    const second = doctorRepair.runResurrectedRepair({ home, cwd: repo, env: {}, dryRun: false });
    const secondRow = second.find((x) => x.id === 'repair-resurrected');
    assert.ok(secondRow);
    assert.equal(secondRow.status, 'skipped');
    assert.match(secondRow.msg, /nothing to repair/);
  } finally { rm(home); rm(repo); }
});

// ---- update.js post-update: REPORT-ONLY (R2 owner decision) ----
// Removal is human-initiated only, via the existing doctor `--repair` flag —
// same posture as `--repair-ingest-orphans`/`--repair-test-stores`. update.js
// NEVER removes a row on its own; it detects, reports the count, and names
// the command that applies it. The per-version stamp still gates the REPORT
// (prints once), never a write.
test('update.js reRetireResurrectedPostUpdate: report-only — detects and counts, never removes; stamps so the report prints once per version', () => {
  const home = tmpHome();
  const repo = makeGitRepo('main');
  try {
    const ctx = { home, env: {}, cwd: repo, now: Date.now(), backend: backend() };
    let r = cli.run(['register', 'A6', '--worktree', repo, '--session', 'sess-A6'], ctx);
    assert.equal(r.code, 0);
    r = cli.run(['archive', 'A6'], ctx);
    assert.equal(r.code, 0);
    writeStaleDescriptor(home, 'T6', repo, 'sess-T6-dead');
    upsertResurrectedRow(home, repo, 'T6', repo, 'sess-T6-dead');

    const paths = { pluginSrcDir: ROOT };
    const env = { ANTIHALL_DEVSWARM_SUPERVISOR: 'on' };
    const first = updateMod.reRetireResurrectedPostUpdate({ paths, env, cwd: repo, home, version: '0.99.1' });
    assert.equal(first.attempted, true);
    assert.equal(first.candidates, 1);
    assert.match(first.detail, /doctor --repair/, 'must name the repair command to run');

    const repoKey = repoKeyOf(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: backend() });
    try {
      assert.equal(s.listRegistry().filter((row) => row.id === 'T6').length, 1,
        'update.js must NEVER remove a row on its own — it only reports');
    } finally { s.close(); }

    const second = updateMod.reRetireResurrectedPostUpdate({ paths, env, cwd: repo, home, version: '0.99.1' });
    assert.equal(second.skippedAlreadyDone, true);
  } finally { rm(home); rm(repo); }
});

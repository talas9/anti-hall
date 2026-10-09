'use strict';
// Field (2026-10-02, 49/49 supervisor reconcile runs): the same failures were
// re-reported on every run with no healing and no back-off:
//   (a) `Repository not found` from hivecontrol for a repoKey it no longer knows
//       (both the per-row `message-count` pull and the `workspace list all` probe);
//   (b) ~40 `worktree not found on disk` errors for ARCHIVED rows whose worktree
//       was pruned;
//   (c) skipped archived rows still carrying `ok:false`.
// Plus the supervisor log re-listed the identical failure set (and every row) per run.
// Root cause: those are terminal/known states but were modelled as failures and
// re-probed each sweep. All isolated: HOME is a mkdtemp dir, the native spawn is a
// fake, nothing under the real ~/.anti-hall is read or written.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-terminal-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const sup = require('../../plugins/anti-hall/companion/devswarm-supervisor.js');
const ru = require('../../plugins/anti-hall/companion/lib/devswarm-repo-unknown.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const NOT_FOUND = 'hivecontrol workspace message-count exited 1: \u001b[31mError: Repository not found. Make sure to pass the git root path.\u001b[0m';

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-terminal-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-terminal-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function seedRegistry(home, repoKey, desc) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { s.upsertRegistry(desc); } finally { s.close(); }
}
function writeArchivedMarker(home, id) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'archived');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, at: Date.now() }));
}
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

// ---- (b) + (c): archived rows are not failures -----------------------------
test('(b) archived row with a pruned worktree: skipped, ok:true, no error text', () => {
  const home = tmpHome(); const repo = makeGitRepo('b');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'arch-gone', worktreePath: path.join(os.tmpdir(), 'anti-hall-terminal-gone-' + process.pid), sessionId: 's' });
    writeArchivedMarker(home, 'arch-gone');
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo })).result;
    const row = r.results[0];
    assert.strictEqual(row.skipped, true);
    assert.strictEqual(row.ok, true, 'a skipped archived row is never ok:false');
    assert.strictEqual(row.error, null);
    assert.match(row.skipReason, /pruned/);
    assert.strictEqual(r.ok, true);
  } finally { rm(home); rm(repo); }
});

test('(c) archived row still on disk: skipped rows are not reported ok:false', () => {
  const home = tmpHome(); const repo = makeGitRepo('c'); const child = makeGitRepo('c-child');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'arch-here', worktreePath: child, sessionId: 's' });
    writeArchivedMarker(home, 'arch-here');
    const row = cli.run(['reconcile'], ctx(home, { cwd: repo })).result.results[0];
    assert.strictEqual(row.skipped, true);
    assert.strictEqual(row.archivedDuplicate, true);
    assert.strictEqual(row.ok, true);
    assert.strictEqual(row.error, null);
  } finally { rm(home); rm(repo); rm(child); }
});

test('a LIVE row with a vanished worktree is still a real ok:false failure with its error', () => {
  const home = tmpHome(); const repo = makeGitRepo('live');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'live-gone', worktreePath: path.join(os.tmpdir(), 'anti-hall-terminal-live-gone-' + process.pid), sessionId: 's' });
    const row = cli.run(['reconcile'], ctx(home, { cwd: repo })).result.results[0];
    assert.strictEqual(row.ok, false);
    assert.strictEqual(row.skipped, false);
    assert.match(row.error, /worktree not found on disk/);
  } finally { rm(home); rm(repo); }
});

// ---- (a) per-row pull: Repository not found ---------------------------------
// A LIVE row is never suppressed (the text can mean a wrong cwd or a transient
// app-start failure); an ARCHIVED row is suppressed only after N identical hits.
function pullHarness(home, repo, rows) {
  const repoKey = repokey.repoKeyForWorktree(repo);
  for (const r of rows) seedRegistry(home, repoKey, r);
  const st = { spawns: [], mode: 'unknown', text: NOT_FOUND };
  const io = {
    spawnReconcile: (d) => {
      st.spawns.push(d.id);
      if (d.id === 'bad1' && st.mode === 'unknown') {
        return { status: 1, stdout: JSON.stringify({ ok: false, error: st.text }), error: null };
      }
      return { status: 0, stdout: JSON.stringify({ ok: true, imported: 0, duplicate: 0, nativeCount: 0 }), error: null };
    },
  };
  const T0 = 1_800_000_000_000;
  const run = (now) => { st.spawns = []; return cli.run(['reconcile'], ctx(home, { cwd: repo, io, now })).result; };
  return { repoKey, st, run, T0 };
}

test('(a) ARCHIVED row "Repository not found": suppressed only on the 3rd consecutive hit, rechecked after 6h, cleared on success, nothing deleted', () => {
  const home = tmpHome(); const repo = makeGitRepo('a'); const bad = makeGitRepo('a-bad'); const good = makeGitRepo('a-good');
  try {
    const { repoKey, st, run, T0 } = pullHarness(home, repo, [
      { id: 'bad1', worktreePath: bad, sessionId: 's' }, { id: 'good1', worktreePath: good, sessionId: 's' }]);
    writeArchivedMarker(home, 'bad1');

    for (const i of [0, 1]) {
      const r = run(T0 + i * 60_000);
      const row = r.results.find((x) => x.id === 'bad1');
      assert.strictEqual(row.ok, false, 'hit ' + (i + 1) + ' is still a reported failure');
      assert.ok(!row.repoUnknown);
      assert.ok(st.spawns.includes('bad1'));
      assert.ok(!ru.isSuppressed(home, repoKey, 'pull:bad1', T0 + i * 60_000));
    }
    const r3 = run(T0 + 120_000);
    const bad1 = r3.results.find((x) => x.id === 'bad1');
    assert.strictEqual(bad1.repoUnknown, true);
    assert.strictEqual(bad1.skipped, true);
    assert.strictEqual(bad1.ok, true);
    assert.strictEqual(r3.repoUnknown, 1);
    assert.ok(r3.results.find((x) => x.id === 'good1').ok, 'a sibling row is unaffected');
    const marker = ru.read(home);
    assert.strictEqual(Object.keys(marker).length, 1);
    assert.match(Object.values(marker)[0].reason, /Repository not found/);
    assert.ok(!/\u001b/.test(Object.values(marker)[0].reason), 'ANSI stripped');

    const r4 = run(T0 + 180_000);
    assert.ok(!st.spawns.includes('bad1'), 'not spawned while suppressed');
    assert.strictEqual(r4.results.find((x) => x.id === 'bad1').repoUnknown, true);
    assert.strictEqual(Object.values(ru.read(home))[0].count, 3, 'idempotent while suppressed');

    run(T0 + ru.RECHECK_MS + 1_000_000);
    assert.deepStrictEqual(st.spawns.filter((x) => x === 'bad1'), ['bad1'], 'one recheck once due');
    assert.strictEqual(Object.values(ru.read(home))[0].count, 4);

    st.mode = 'known';
    run(T0 + 2 * ru.RECHECK_MS + 2_000_000);
    assert.deepStrictEqual(ru.read(home), {});

    assert.ok(fs.existsSync(bad) && fs.existsSync(good));
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { assert.strictEqual(s.listRegistry().length, 2); } finally { s.close(); }
  } finally { rm(home); rm(repo); rm(bad); rm(good); }
});

test('(a) LIVE row "Repository not found": never suppressed, never ok:true, no marker, pulled every sweep', () => {
  const home = tmpHome(); const repo = makeGitRepo('live'); const bad = makeGitRepo('live-bad');
  try {
    const { repoKey, st, run, T0 } = pullHarness(home, repo, [{ id: 'bad1', worktreePath: bad, sessionId: 's' }]);
    for (let i = 0; i < 5; i++) {
      const r = run(T0 + i * 60_000);
      const row = r.results.find((x) => x.id === 'bad1');
      assert.strictEqual(row.ok, false);
      assert.ok(!row.repoUnknown && !row.skipped);
      assert.strictEqual(r.ok, false);
      assert.ok(st.spawns.includes('bad1'), 'pulled again on sweep ' + (i + 1));
    }
    assert.deepStrictEqual(ru.read(home), {}, 'no marker for a live row');
    fs.mkdirSync(path.dirname(ru.markerPath(home)), { recursive: true });
    // an earlier-shape marker (no streak) must not silence a live row either
    fs.writeFileSync(ru.markerPath(home), JSON.stringify({ version: 1, scopes: { [repoKey + ':pull:bad1']: { reason: 'r', firstSeen: T0, lastChecked: T0 + 5 * 60_000, count: 1 } } }));
    const r = run(T0 + 6 * 60_000);
    assert.ok(st.spawns.includes('bad1'));
    assert.strictEqual(r.results.find((x) => x.id === 'bad1').ok, false);
  } finally { rm(home); rm(repo); rm(bad); }
});

test('(a) an intervening success or a different error resets the consecutive count', () => {
  const home = tmpHome(); const repo = makeGitRepo('reset'); const bad = makeGitRepo('reset-bad');
  try {
    const { repoKey, st, run, T0 } = pullHarness(home, repo, [{ id: 'bad1', worktreePath: bad, sessionId: 's' }]);
    writeArchivedMarker(home, 'bad1');
    run(T0); run(T0 + 1000);
    st.mode = 'known'; run(T0 + 2000);
    assert.deepStrictEqual(ru.read(home), {}, 'success clears');
    st.mode = 'unknown'; run(T0 + 3000); run(T0 + 4000);
    assert.ok(!ru.isSuppressed(home, repoKey, 'pull:bad1', T0 + 4000), 'only 2 in a row since the success');
    st.text = 'hivecontrol workspace message-count exited 2: boom';
    run(T0 + 5000);
    assert.deepStrictEqual(ru.read(home), {}, 'a different error clears');
    st.text = NOT_FOUND; run(T0 + 6000); run(T0 + 7000);
    assert.ok(!ru.isSuppressed(home, repoKey, 'pull:bad1', T0 + 7000));
    run(T0 + 8000);
    assert.ok(ru.isSuppressed(home, repoKey, 'pull:bad1', T0 + 8000), '3 fresh hits in a row suppress');
  } finally { rm(home); rm(repo); rm(bad); }
});

test('(a) an unrelated error that merely contains the phrase does not match; the real line shapes do', () => {
  assert.strictEqual(ru.isRepoUnknownText('Repository not found in the object cache, retry later'), false);
  assert.strictEqual(ru.isRepoUnknownText('hivecontrol x exited 1: could not clone: Repository not found. Check your remote'), false);
  assert.strictEqual(ru.isRepoUnknownText('remote: Repository not found.\nfatal: unable to access'), false, 'a git remote error is a different message');
  assert.strictEqual(ru.isRepoUnknownText('noise\nError: Repository not found. Make sure to pass the git root path.\n'), true, 'matched per line');
  assert.strictEqual(ru.isRepoUnknownText(NOT_FOUND), true);
  assert.strictEqual(ru.isRepoUnknownText('Error: Repository not found.'), true);
  assert.strictEqual(ru.isRepoUnknownText(null, undefined, 5), false);
  const home = tmpHome(); const repo = makeGitRepo('phr'); const bad = makeGitRepo('phr-bad');
  try {
    const { st, run, T0 } = pullHarness(home, repo, [{ id: 'bad1', worktreePath: bad, sessionId: 's' }]);
    writeArchivedMarker(home, 'bad1');
    st.text = 'hivecontrol workspace message-count exited 1: Repository not found in the object cache, retry later';
    for (let i = 0; i < 4; i++) assert.strictEqual(run(T0 + i).results[0].ok, false);
    assert.deepStrictEqual(ru.read(home), {});
  } finally { rm(home); rm(repo); rm(bad); }
});

test('(a) an earlier-shape marker (no streak) still suppresses an ARCHIVED row for its 6h window', () => {
  const home = tmpHome(); const repo = makeGitRepo('leg'); const bad = makeGitRepo('leg-bad');
  try {
    const { repoKey, st, run, T0 } = pullHarness(home, repo, [{ id: 'bad1', worktreePath: bad, sessionId: 's' }]);
    writeArchivedMarker(home, 'bad1');
    fs.mkdirSync(path.dirname(ru.markerPath(home)), { recursive: true });
    fs.writeFileSync(ru.markerPath(home), JSON.stringify({ version: 1, scopes: { [repoKey + ':pull:bad1']: { reason: 'r', firstSeen: T0, lastChecked: T0, count: 1 } } }));
    const r = run(T0 + 1000);
    assert.strictEqual(r.results.find((x) => x.id === 'bad1').repoUnknown, true);
    assert.ok(!st.spawns.includes('bad1'));
  } finally { rm(home); rm(repo); rm(bad); }
});

test('a NEW, different pull failure is still reported as a real failure', () => {
  const home = tmpHome(); const repo = makeGitRepo('new'); const child = makeGitRepo('new-child');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'boom', worktreePath: child, sessionId: 's' });
    const io = { spawnReconcile: () => ({ status: 1, stdout: JSON.stringify({ ok: false, error: 'something else broke' }), error: null }) };
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo, io })).result;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.results[0].ok, false);
    assert.strictEqual(r.results[0].repoUnknown, undefined);
    assert.deepStrictEqual(ru.read(home), {});
  } finally { rm(home); rm(repo); rm(child); }
});

// ---- (a) supervisor active probe ---------------------------------------------
function supHarness(home, probeResultFn) {
  const state = { probes: 0 };
  const deps = {
    readDescriptors: () => [{ id: 'x', worktreePath: '/wt/x' }],
    repoKeyForWorktree: () => 'proj-key',
    fs: Object.assign({}, fs, { existsSync: () => true }),
    readReconcileSweepState: () => ({ lastRunAt: 0 }),
    writeReconcileSweepState: () => {},
    runReconcile: () => ({ ok: true, count: 0, imported: 0, lost: 0, results: [] }),
    runFold: () => ({ ok: true }),
    runActiveList: () => { state.probes++; return probeResultFn(); },
    startupSampling: { runSamplingPass: () => {} },
  };
  const sweep = (now) => sup.reconcileSweepIfDue({ home, env: {}, now, cooldownMs: 0, deps });
  return { state, sweep };
}
const NF_LIST = 'hivecontrol workspace list all exited 1: \u001b[31mError: Repository not found. Make sure to pass the git root path.\u001b[0m';

test('(a) supervisor `workspace list all` "Repository not found", repoKey with NO live row: reported twice, suppressed on the 3rd, rechecked after 6h; a new failure still is reported', () => {
  const home = tmpHome();
  try {
    writeArchivedMarker(home, 'x');
    let probeResult = { ok: false, reason: 'hivecontrol-unavailable', error: NF_LIST, status: 1, stderr: 'Error: Repository not found.' };
    const { state, sweep } = supHarness(home, () => probeResult);
    const T0 = 1_800_000_000_000;

    assert.ok(sweep(T0).activeProbe.failure, 'hit 1 is still a probe failure');
    assert.ok(sweep(T0 + 1000).activeProbe.failure, 'hit 2 too');
    const s3 = sweep(T0 + 2000);
    assert.strictEqual(s3.activeProbe.failure, null, 'suppressed from the 3rd hit');
    assert.ok(ru.isSuppressed(home, 'proj-key', 'list', T0 + 2000));
    assert.strictEqual(state.probes, 3);

    sweep(T0 + 60_000);
    assert.strictEqual(state.probes, 3, 'no re-probe while suppressed');
    sweep(T0 + ru.RECHECK_MS + 5000);
    assert.strictEqual(state.probes, 4, 'one recheck once due');

    probeResult = { ok: false, reason: 'hivecontrol-unavailable', error: 'hivecontrol workspace list all exited 2: kaboom', status: 2 };
    const s5 = sweep(T0 + 3 * ru.RECHECK_MS);
    assert.ok(s5.activeProbe.failure && /kaboom/.test(s5.activeProbe.failure.error));
    assert.deepStrictEqual(ru.read(home), {}, 'a different error clears the streak');
  } finally { rm(home); }
});

test('(a) supervisor probe with a LIVE row in the repo: never suppressed, failure reported every sweep, no marker', () => {
  const home = tmpHome();
  try {
    const { state, sweep } = supHarness(home, () => ({ ok: false, reason: 'hivecontrol-unavailable', error: NF_LIST, status: 1 }));
    const T0 = 1_800_000_000_000;
    for (let i = 0; i < 5; i++) assert.ok(sweep(T0 + i * 1000).activeProbe.failure, 'sweep ' + (i + 1));
    assert.strictEqual(state.probes, 5);
    assert.deepStrictEqual(ru.read(home), {});
  } finally { rm(home); }
});

// ---- logging: signature dedupe + compaction ----------------------------------
test('compactReconcileForLog: failure set listed once, then "N unchanged failures (same as last run)" until it changes', () => {
  const mk = (rows) => ({
    ran: true, projects: 1, skipped: 0,
    results: [{ repoKey: 'k', result: { ok: false, count: rows.length, imported: 0, lost: 0, results: rows }, fold: { ok: true, retired: [], folded: 0 }, active: { ok: true, records: [{ big: 1 }, { big: 2 }] } }],
    activeProbe: { repoKeys: ['k'], failure: null },
  });
  const archived = { id: 'a', ok: true, skipped: true, skipReason: 'archived' };
  const real = { id: 'r', ok: false, skipped: false, error: 'boom' };
  const c1 = sup.compactReconcileForLog(mk([archived, real]), null);
  assert.ok(Array.isArray(c1.line.failures) && c1.line.failures.length === 1);
  assert.strictEqual(c1.line.results[0].skipped, 1);
  assert.strictEqual(c1.line.results[0].active.records, 2, 'record list collapsed to a count');
  assert.ok(!('results' in c1.line.results[0]), 'rows are not re-dumped');

  const c2 = sup.compactReconcileForLog(mk([archived, real]), c1.sig);
  assert.deepStrictEqual(c2.line.failures, { unchanged: 1, note: '1 unchanged failures (same as last run)' });

  const c3 = sup.compactReconcileForLog(mk([archived, real, { id: 'r2', ok: false, skipped: false, error: 'new' }]), c2.sig);
  assert.ok(Array.isArray(c3.line.failures) && c3.line.failures.length === 2, 'a changed signature lists in full again');

  const c4 = sup.compactReconcileForLog(mk([archived]), c3.sig);
  assert.strictEqual(c4.line.failures, 0);
  assert.deepStrictEqual(sup.compactReconcileForLog({ ran: false, reason: 'cooldown' }, 'x').line, { ran: false, reason: 'cooldown' });
});

test('repo-unknown marker: tolerates corrupt/foreign shapes (fail-open) and is idempotent', () => {
  const home = tmpHome();
  try {
    fs.mkdirSync(path.dirname(ru.markerPath(home)), { recursive: true });
    for (const bad of ['not json', '[]', '{"scopes":[]}', '{"version":9}']) {
      fs.writeFileSync(ru.markerPath(home), bad);
      assert.deepStrictEqual(ru.read(home), {});
      assert.strictEqual(ru.isSuppressed(home, 'k', 'list', 1), false);
    }
    assert.strictEqual(ru.record(home, 'k', 'list', 'r', 1000).first, true);
    assert.strictEqual(ru.record(home, 'k', 'list', 'r', 2000).first, false);
    assert.strictEqual(ru.read(home)['k:list'].firstSeen, 1000);
  } finally { rm(home); }
});

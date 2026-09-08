'use strict';
// v0.98 — launchd/systemd-list-based orphan detection (defect ec33954162ef).
// D9's git-worktree-list-driven reap (reapLegacyUnitsForRepo) enumerates FROM
// a worktree — it is structurally blind to a label the SCHEDULER still has
// loaded once that worktree (and any file on disk about it) is gone. This
// file exercises listLoadedIngestLabels/classifyLoadedLabel/orphanReapPlan/
// bootoutLoadedLabel/stopLoadedUnit — the launchctl/systemctl side is ALWAYS
// mocked via opts.io.listLoaded / opts.io.schedRun; this suite never spawns a
// real launchctl/systemctl, matching every other test in
// tests/companion/install-devswarm-ingest.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cp = require('node:child_process');

const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');

// mkGitRepo(tag) -> a REAL git repo dir. repoKeyForWorktree spawns `git
// rev-parse --git-common-dir` (mirrors tests/scripts/devswarm-send.test.js /
// devswarm-fleet-2e8653787945.test.js's own makeGitRepo/mkGitRepo rationale)
// so the duplicate-label-same-project cross-check can actually fire — a
// non-git tmp dir always resolves repoKeyForWorktree to null and the pass
// never fires at all, which is a VACUOUS test of it (fix-wave R2 P1).
function mkGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-orphan-reap-git-' + tag + '-'));
  cp.execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  cp.execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  cp.execFileSync('git', ['config', 'user.name', 'a'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'f.txt'), tag);
  cp.execFileSync('git', ['add', '.'], { cwd: dir });
  cp.execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-orphan-reap-'));
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function writeHeartbeat(home, repoKey, ts, pid) {
  const p = path.join(home, '.anti-hall', 'devswarm', 'heartbeats', 'ingest-' + repoKey + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ts, pid }));
}
function writeProjectLock(home, repoKey, pid) {
  const p = path.join(home, '.anti-hall', 'devswarm', 'locks', 'ingest-project-' + repoKey + '.lock');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ pid, ts: Date.now(), token: 'test' }));
}
function writeLegacyLock(home, hash, pid) {
  const p = path.join(home, '.anti-hall', 'devswarm', 'locks', 'ingest-' + hash + '.lock');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ pid, ts: Date.now(), token: 'test' }));
}
// writeLegacyHeartbeat — mirrors devswarm-ingest.js's own ingestHeartbeatPath(home, hash)
// shape (heartbeats/ingest-<hash>.json), the per-worktree liveness file the
// ingest loop rewrites every sweep even when quiet (0 inserts).
function writeLegacyHeartbeat(home, hash, ts) {
  const p = path.join(home, '.anti-hall', 'devswarm', 'heartbeats', 'ingest-' + hash + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ts, pid: null }));
}
function writePlist(home, label, workdir) {
  const dir = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(dir, { recursive: true });
  const xml = inst.buildPlist ? inst.buildPlist({ label, workdir }) : null;
  const body = xml || `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>WorkingDirectory</key><string>${workdir || ''}</string>
<key>ProgramArguments</key><array><string>/usr/bin/node</string><string>/some/script.js</string></array>
</dict></plist>`;
  fs.writeFileSync(path.join(dir, label + '.plist'), body);
}

// ---------------------------------------------------------------------------
// 1. healthy: plist present + healthy heartbeat -> never in the repair plan.
// ---------------------------------------------------------------------------
test('orphanReapPlan: loaded label with matching plist + healthy heartbeat -> class healthy, never eligible', () => {
  const home = tmpHome();
  try {
    const workdir = tmpHome(); // reused as a stand-in "worktree" that exists on disk
    const label = 'com.anti-hall.devswarm-ingest.projh-aaaaaa';
    writePlist(home, label, workdir);
    writeHeartbeat(home, 'projh-aaaaaa', Date.now(), 111);
    writeProjectLock(home, 'projh-aaaaaa', 111);
    const plan = inst.orphanReapPlan({
      home, platform: 'darwin',
      io: { listLoaded: () => [{ label, pid: 111, lastExit: '0' }], isAlive: () => true },
    });
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].class, 'healthy');
    assert.strictEqual(plan[0].eligible, false);
    rm(workdir);
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// 2. orphan-no-plist: loaded label, no matching plist file at all -> eligible.
// ---------------------------------------------------------------------------
test('orphanReapPlan: loaded label with NO matching plist -> class orphan-no-plist, eligible', () => {
  const home = tmpHome();
  try {
    const label = 'com.anti-hall.devswarm-ingest.projn-bbbbbb';
    const plan = inst.orphanReapPlan({
      home, platform: 'darwin',
      io: { listLoaded: () => [{ label, pid: null, lastExit: '19968' }] },
    });
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].class, 'orphan-no-plist');
    assert.strictEqual(plan[0].plistPresent, false);
    assert.strictEqual(plan[0].eligible, true);
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// 3. orphan-path-gone: plist present but workingDir doesn't exist ->
//    REPORT-ONLY (fix-wave R2 P0): a plist DOES exist on disk for this
//    entry, so unloading it is the EXISTING reap machinery's job
//    (reapLegacyUnitsForRepo/stopLegacyUnitEntry), never this new
//    label-only bootout/stop path. eligible MUST be false.
// ---------------------------------------------------------------------------
test('orphanReapPlan: plist present but workingDir gone -> class orphan-path-gone, REPORT-ONLY (never eligible)', () => {
  const home = tmpHome();
  try {
    const label = 'com.anti-hall.devswarm-ingest.projp-cccccc';
    const goneDir = path.join(os.tmpdir(), 'anti-hall-orphan-reap-gone-' + Date.now());
    writePlist(home, label, goneDir);
    const plan = inst.orphanReapPlan({
      home, platform: 'darwin',
      io: { listLoaded: () => [{ label, pid: null, lastExit: '0' }] },
    });
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].plistPresent, true);
    assert.strictEqual(plan[0].pathExists, false);
    assert.strictEqual(plan[0].class, 'orphan-path-gone');
    assert.strictEqual(plan[0].eligible, false, 'orphan-path-gone must NEVER be eligible for the new bootout path — a plist exists on disk for it');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// 4. duplicate-label-same-project: two legacy hash-labeled loaded entries
//    whose workingDir resolves to the SAME repoKey via a REAL git repo (so
//    the cross-check actually fires, not a vacuous non-git-dir case) -> both
//    reported as duplicate-label-same-project, REPORT-ONLY — eligible is
//    false for BOTH unconditionally (fix-wave R2 P0: a plist exists on disk
//    for every entry that can even enter this pass, so unloading is never
//    this new path's job, regardless of liveness).
// ---------------------------------------------------------------------------
test('orphanReapPlan: two legacy hash labels sharing a repoKey (real git fixture) -> duplicate-label-same-project, REPORT-ONLY for both', () => {
  const home = tmpHome();
  const workdir = mkGitRepo('dup');
  try {
    const labelA = 'com.anti-hall.devswarm-ingest.11112222';
    const labelB = 'com.anti-hall.devswarm-ingest.33334444';
    writePlist(home, labelA, workdir);
    writePlist(home, labelB, workdir);
    const plan = inst.orphanReapPlan({
      home, platform: 'darwin',
      io: { listLoaded: () => [
        { label: labelA, pid: null, lastExit: '0' },
        { label: labelB, pid: null, lastExit: '0' },
      ] },
    });
    assert.strictEqual(plan.length, 2);
    for (const e of plan) {
      assert.strictEqual(e.kind, 'hash');
      assert.strictEqual(e.pathExists, true, 'precondition: the real git repo must resolve as an existing path');
      assert.strictEqual(e.class, 'duplicate-label-same-project', 'the real-git-repo cross-check must actually fire and merge both entries');
      assert.strictEqual(e.eligible, false, 'duplicate-label-same-project is ALWAYS report-only, regardless of liveness');
    }
  } finally { rm(home); rm(workdir); }
});

// ---------------------------------------------------------------------------
// P0 regression (fix-wave R2): two hash-labeled plists sharing ONE real
// worktree, BOTH quiet (no heartbeat, no lock at all for either label) ->
// the plan must contain ZERO eligible entries. The previous version of this
// pass marked the non-live member of such a group `eligible:true`, and
// doctor-repair's apply loop (which filters on `eligible` alone) would have
// booted out a real, on-disk-registered, worktree-present unit for real.
// ---------------------------------------------------------------------------
test('orphanReapPlan P0 regression: two quiet hash plists sharing one worktree -> plan contains ZERO eligible entries', () => {
  const home = tmpHome();
  const workdir = mkGitRepo('p0');
  try {
    const labelA = 'com.anti-hall.devswarm-ingest.55556666';
    const labelB = 'com.anti-hall.devswarm-ingest.77778888';
    writePlist(home, labelA, workdir);
    writePlist(home, labelB, workdir);
    // Deliberately NO heartbeat, NO lock for either hash — both genuinely quiet.
    const plan = inst.orphanReapPlan({
      home, platform: 'darwin',
      io: { listLoaded: () => [
        { label: labelA, pid: null, lastExit: '0' },
        { label: labelB, pid: null, lastExit: '0' },
      ] },
    });
    assert.strictEqual(plan.length, 2);
    assert.strictEqual(plan.filter((e) => e.eligible).length, 0, 'a quiet duplicate group must never yield an eligible entry — both have a real plist on disk');
    for (const e of plan) assert.strictEqual(e.class, 'duplicate-label-same-project');
  } finally { rm(home); rm(workdir); }
});

// ---------------------------------------------------------------------------
// 5. orphan-no-plist label whose repoKey/hash HAS a live heartbeat -> MUST
//    NOT appear in the repair plan (never-unload guard rule 3).
// ---------------------------------------------------------------------------
test('orphanReapPlan: orphan-no-plist with a live heartbeat for its repoKey -> never eligible (guard rule 3)', () => {
  const home = tmpHome();
  try {
    const label = 'com.anti-hall.devswarm-ingest.projg-dddddd';
    writeHeartbeat(home, 'projg-dddddd', Date.now(), 555);
    const plan = inst.orphanReapPlan({
      home, platform: 'darwin',
      io: { listLoaded: () => [{ label, pid: null, lastExit: '19968' }] },
    });
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].class, 'orphan-no-plist');
    assert.strictEqual(plan[0].eligible, false, 'a fresh heartbeat must block eligibility even with no plist present');
  } finally { rm(home); }
});

// Same guard, legacy hash form: a live-pid legacy lock file blocks eligibility.
test('orphanReapPlan: orphan-no-plist (legacy hash) with a live legacy lock -> never eligible', () => {
  const home = tmpHome();
  try {
    const label = 'com.anti-hall.devswarm-ingest.deadbeef';
    writeLegacyLock(home, 'deadbeef', process.pid); // our own pid is genuinely alive
    const plan = inst.orphanReapPlan({
      home, platform: 'darwin',
      io: { listLoaded: () => [{ label, pid: null, lastExit: '19968' }] },
    });
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].kind, 'hash');
    assert.strictEqual(plan[0].class, 'orphan-no-plist');
    assert.strictEqual(plan[0].eligible, false, 'a live legacy lock holder must block eligibility');
  } finally { rm(home); }
});

// P1 fix-wave R2: legacy-hash liveness must OR a fresh heartbeat with the
// lock check, exactly like the repoKey branch already does — a RELEASED
// lock (no lock file at all) with a still-fresh legacy heartbeat used to
// read as dead here (lock-only check), wrongly making the entry eligible.
test('orphanReapPlan: orphan-no-plist (legacy hash) with a released lock but a FRESH legacy heartbeat -> never eligible', () => {
  const home = tmpHome();
  try {
    const label = 'com.anti-hall.devswarm-ingest.cafebabe';
    // No lock file at all (released) — only a fresh heartbeat remains.
    writeLegacyHeartbeat(home, 'cafebabe', Date.now());
    const plan = inst.orphanReapPlan({
      home, platform: 'darwin',
      io: { listLoaded: () => [{ label, pid: null, lastExit: '19968' }] },
    });
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].kind, 'hash');
    assert.strictEqual(plan[0].class, 'orphan-no-plist');
    assert.strictEqual(plan[0].eligible, false, 'a fresh legacy heartbeat must block eligibility even with the lock already released');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// 6. launchctl list mock returns empty/errors -> [], fail-open, no crash.
// ---------------------------------------------------------------------------
test('listLoadedIngestLabels: io.listLoaded throwing -> [], fail-open', () => {
  const plan = inst.orphanReapPlan({
    home: tmpHome(), platform: 'darwin',
    io: { listLoaded: () => { throw new Error('boom'); } },
  });
  assert.deepStrictEqual(plan, []);
});
test('listLoadedIngestLabels: io.listLoaded returning [] -> []', () => {
  assert.deepStrictEqual(inst.listLoadedIngestLabels({ platform: 'linux', io: { listLoaded: () => [] } }), []);
});

// ---------------------------------------------------------------------------
// 7. --repair-ingest-orphans without --apply -> plan printed, io.schedRun/
//    schedFs assert ZERO calls (dry-run-by-default), via doctor-repair.js.
// ---------------------------------------------------------------------------
test('doctor-repair runIngestOrphanRepair: dry-run (default) never calls schedRun', () => {
  const home = tmpHome();
  try {
    const label = 'com.anti-hall.devswarm-ingest.projz-eeeeee';
    let schedCalls = 0;
    const doctorRepair = require('../../plugins/anti-hall/hooks/lib/doctor-repair.js');
    const results = doctorRepair.runIngestOrphanRepair({
      home, platform: 'darwin', dryRun: true,
      io: { listLoaded: () => [{ label, pid: null, lastExit: '19968' }], schedRun: () => { schedCalls++; return { status: 0 }; } },
    });
    assert.strictEqual(schedCalls, 0, 'dry-run must never call schedRun');
    assert.ok(results.length >= 1);
    assert.ok(results.some((r) => r.status === 'skipped' && /dry-run/.test(r.msg)));
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// 8. --repair-ingest-orphans --apply -> mocks assert exactly the eligible
//    labels were passed to bootout, and an INELIGIBLE label (live heartbeat)
//    was never passed.
// ---------------------------------------------------------------------------
test('doctor-repair runIngestOrphanRepair: apply calls bootout ONLY for eligible labels, never for a live one', () => {
  const home = tmpHome();
  try {
    const orphanLabel = 'com.anti-hall.devswarm-ingest.projo-ffffff';
    const liveLabel = 'com.anti-hall.devswarm-ingest.projl-999999';
    writeHeartbeat(home, 'projl-999999', Date.now(), 777);
    const bootoutCalls = [];
    const doctorRepair = require('../../plugins/anti-hall/hooks/lib/doctor-repair.js');
    const results = doctorRepair.runIngestOrphanRepair({
      home, platform: 'darwin', dryRun: false,
      io: {
        listLoaded: () => [
          { label: orphanLabel, pid: null, lastExit: '19968' },
          { label: liveLabel, pid: null, lastExit: '19968' },
        ],
        schedRun: (spec) => { bootoutCalls.push(spec); return { status: 0, stdout: '', error: null }; },
        uid: () => 501,
      },
    });
    assert.strictEqual(bootoutCalls.length, 1, 'exactly one bootout call (the eligible orphan only)');
    assert.ok(bootoutCalls[0].args.some((a) => a.includes(orphanLabel)));
    assert.ok(!bootoutCalls[0].args.some((a) => a.includes(liveLabel)));
    assert.ok(results.some((r) => r.status === 'fixed' && r.msg.includes(orphanLabel)));
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// 9. win32 -> listLoadedIngestLabels returns [] (matches existing no-op posture).
// ---------------------------------------------------------------------------
test('listLoadedIngestLabels: win32 -> []', () => {
  assert.deepStrictEqual(inst.listLoadedIngestLabels({ platform: 'win32' }), []);
});
test('orphanReapPlan: win32 -> []', () => {
  assert.deepStrictEqual(inst.orphanReapPlan({ home: tmpHome(), platform: 'win32' }), []);
});

// ---------------------------------------------------------------------------
// bootoutLoadedLabel / stopLoadedUnit — exact command shape, never kill(2),
// routed through opts.io.schedRun (never a real spawn under test).
// ---------------------------------------------------------------------------
test('bootoutLoadedLabel: launchctl bootout gui/<uid>/<label>, never a plist unload', () => {
  const calls = [];
  inst.bootoutLoadedLabel('com.anti-hall.devswarm-ingest.projq-aaaaaa', {
    io: { schedRun: (spec) => { calls.push(spec); return { status: 0 }; }, uid: () => 501 },
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'launchctl');
  assert.deepStrictEqual(calls[0].args, ['bootout', 'gui/501/com.anti-hall.devswarm-ingest.projq-aaaaaa']);
});
test('stopLoadedUnit: systemctl --user stop <unit>.service, never disable/rm', () => {
  const calls = [];
  inst.stopLoadedUnit('anti-hall-devswarm-ingest-projq-aaaaaa', {
    io: { schedRun: (spec) => { calls.push(spec); return { status: 0 }; } },
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'systemctl');
  assert.deepStrictEqual(calls[0].args, ['--user', 'stop', 'anti-hall-devswarm-ingest-projq-aaaaaa.service']);
});

// ---------------------------------------------------------------------------
// Idempotency: a second orphanReapPlan call after the (mocked) labels are
// gone from listLoaded returns an empty eligible set — natural idempotency,
// no state file needed.
// ---------------------------------------------------------------------------
test('orphanReapPlan: idempotent — a repaired label no longer appears once listLoaded stops reporting it', () => {
  const home = tmpHome();
  try {
    const label = 'com.anti-hall.devswarm-ingest.projr-bbbbbb';
    let stillLoaded = true;
    const io = { listLoaded: () => (stillLoaded ? [{ label, pid: null, lastExit: '19968' }] : []) };
    let plan = inst.orphanReapPlan({ home, platform: 'darwin', io });
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].eligible, true);
    stillLoaded = false; // simulates a successful bootout
    plan = inst.orphanReapPlan({ home, platform: 'darwin', io });
    assert.deepStrictEqual(plan, []);
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// Structural test-context guard (fix-wave R2 item 7, defect ec33954162ef):
// closes the CLASS of the original leak, not just the one fixed instance.
// A test that forgets ANTIHALL_INGEST_DRY_RUN=1 — exactly the mistake that
// caused the leak — must STILL be safe, because `node --test` sets
// NODE_TEST_CONTEXT in every worker AND every child it spawns inherits it
// (verified live on this machine before writing this test: a tiny probe
// asserted both). This spawns the REAL `install-devswarm-ingest.js` as
// `main()` (via `require.main === module`, the only way main() ever runs —
// it is not exported) under an isolated HOME, with NEITHER `--dry-run` NOR
// ANTIHALL_INGEST_DRY_RUN set, and relies ENTIRELY on the NODE_TEST_CONTEXT
// fallback the child inherits from this test process's own env.
// ---------------------------------------------------------------------------
test('install-devswarm-ingest.js main(): NO explicit dry-run flag/env, isolated HOME -> NODE_TEST_CONTEXT alone forces dry-run, zero real launchctl/systemctl calls, no unit file written', () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return; // no daemon on win32
  assert.ok(process.env.NODE_TEST_CONTEXT, 'precondition: this test must itself be running under `node --test` for the guard under test to have anything to inherit');

  const home = tmpHome();
  const repo = mkGitRepo('structural-guard');
  const installerPath = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-ingest.js');
  try {
    // Deliberately NO --dry-run arg, NO ANTIHALL_INGEST_DRY_RUN in env — the
    // exact shape of the ORIGINAL leaking test. `...process.env` carries
    // NODE_TEST_CONTEXT through by inheritance, same as any real spawn chain
    // (defaultSpawnInstaller/defaultSchedRunViaPlan spawn the SAME way).
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
    delete env.ANTIHALL_INGEST_DRY_RUN;
    const r = cp.spawnSync(process.execPath, [installerPath], { cwd: repo, env, encoding: 'utf8', timeout: 30000 });

    assert.strictEqual(r.status, 0, 'main() must exit 0 (stdout: ' + r.stdout + ' / stderr: ' + r.stderr + ')');
    assert.match(r.stderr, /NODE_TEST_CONTEXT/, 'the structural guard must print its stderr notice');
    assert.match(r.stdout, /\[dry-run\] would (write|run)/, 'planWrite/planRun must have taken the dry-run branch');

    const laDir = path.join(home, 'Library', 'LaunchAgents');
    const sdDir = path.join(home, '.config', 'systemd', 'user');
    let plistFiles = [];
    try { plistFiles = fs.readdirSync(laDir).filter((n) => n.endsWith('.plist')); } catch (_) { plistFiles = []; }
    let serviceFiles = [];
    try { serviceFiles = fs.readdirSync(sdDir).filter((n) => n.endsWith('.service')); } catch (_) { serviceFiles = []; }
    assert.deepStrictEqual(plistFiles, [], 'no real plist must ever be written under the isolated HOME');
    assert.deepStrictEqual(serviceFiles, [], 'no real systemd unit must ever be written under the isolated HOME');

    // Independently confirm via the module's own readback that nothing real
    // was registered (belt-and-braces on top of the raw directory listing).
    const installer = require(installerPath);
    const units = installer.listInstalledIngestUnits({ home, platform: process.platform });
    assert.deepStrictEqual(units, [], 'listInstalledIngestUnits must read back zero units');
  } finally { rm(home); rm(repo); }
});

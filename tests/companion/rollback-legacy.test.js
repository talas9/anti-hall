'use strict';
// rollback-legacy — v0.57 mesh -> <=0.56 legacy per-worktree units (D13,
// PLAN-v0.57-mesh.md Phase 6b). Covers ONLY `rollbackToLegacyUnits` (exported
// from plugins/anti-hall/skills/update/scripts/update.js — the ACTUAL update
// helper; `companion/update.js` does not exist in this tree).
//
// NO real launchctl/systemctl/crontab/git spawn anywhere in this file:
//   - git is exercised via install-devswarm-ingest.js's/devswarm-repokey.js's
//     OWN injectable `io.run`/`io.fs` (mocked here — same discipline as
//     tests/companion/install-ingest-repokey.test.js), never a real spawn.
//   - the scheduler mutation steps (uninstall the per-project daemon,
//     reinstall each legacy per-worktree unit) are ALWAYS passed via
//     doUninstallProject/doInstallLegacy overrides — the REAL
//     macInstall/macUninstallProject/etc. are NEVER reached from a test.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const U = require('../../plugins/anti-hall/skills/update/scripts/update.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const { devswarmRoot } = require('../../plugins/anti-hall/companion/lib/liveness.js');

const REAL_PLUGIN_SRC_DIR = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-legacy-'));
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// mockIo(mainWorktree, worktreePaths) -> {run, fs} — a git-common-dir AND
// worktree-list mock (no real git spawn), mirroring
// install-ingest-repokey.test.js's own mocked-io pattern. Every worktree of
// the project shares the SAME common-dir (mainWorktree/.git), exactly as a
// real repo's linked worktrees do.
function mockIo(mainWorktree, worktreePaths) {
  const porcelain = worktreePaths.map((wt) => 'worktree ' + wt).join('\n\n') + '\n';
  return {
    run(spec) {
      const args = spec.args || [];
      if (args.includes('worktree') && args.includes('list')) return { ok: true, raw: porcelain };
      return { ok: true, raw: path.join(mainWorktree, '.git') }; // rev-parse --git-common-dir
    },
    fs: { realpathSync: (p) => p },
  };
}

const MAIN_WT = '/repo/proj-main';
const LINKED_WT = '/repo/proj-main-wt-feature';

// ---------------------------------------------------------------------------
// Gate / fail-open cases
// ---------------------------------------------------------------------------

test('rollbackToLegacyUnits: win32 -> documented no-op (D28), never touches installIngest', () => {
  const result = U.rollbackToLegacyUnits({
    platform: 'win32',
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    installIngest: { resolveMainWorktree: () => { throw new Error('must not be called on win32'); } },
  });
  assert.equal(result.attempted, false);
  assert.equal(result.viable, false);
  assert.match(result.detail, /win32/);
});

test('rollbackToLegacyUnits: missing plugin files under pluginSrcDir -> fail-open, attempted:false', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-empty-'));
  try {
    const result = U.rollbackToLegacyUnits({
      platform: 'darwin',
      paths: { pluginSrcDir: empty },
    });
    assert.equal(result.attempted, false);
    assert.match(result.detail, /not found/);
  } finally { rm(empty); }
});

test('rollbackToLegacyUnits: non-git cwd -> attempted:false, no mutation attempted', () => {
  const result = U.rollbackToLegacyUnits({
    platform: 'darwin',
    cwd: '/tmp/not-a-repo',
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    io: { run: () => ({ ok: false, raw: '' }) },
    doUninstallProject: () => { throw new Error('must not be called — no project resolved'); },
    doInstallLegacy: () => { throw new Error('must not be called — no project resolved'); },
  });
  assert.equal(result.attempted, false);
  assert.equal(result.viable, false);
  assert.match(result.detail, /not a git worktree/);
});

test('rollbackToLegacyUnits: an internal throw is fail-open — never propagates, detail explains it', () => {
  const io = mockIo(MAIN_WT, [MAIN_WT]);
  const result = U.rollbackToLegacyUnits({
    platform: 'darwin',
    cwd: MAIN_WT,
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    io,
    doUninstallProject: () => { throw new Error('boom — must not propagate'); },
    doInstallLegacy: () => { throw new Error('boom'); },
    readHeartbeat: () => ({ fresh: false, ts: null }),
  });
  // doUninstallProject's throw is caught per-step (uninstalled:false) — the
  // call as a whole still completes and reports plan/viability, it does not
  // raise. installed:false for every entry (doInstallLegacy also throws).
  assert.equal(result.attempted, true);
  assert.equal(result.uninstalled, false);
  assert.equal(result.viable, false);
  assert.ok(result.reinstalled.every((r) => r.installed === false && r.fresh === false));
});

// ---------------------------------------------------------------------------
// Enumeration + reinstall — via mocked io + injected doUninstallProject/
// doInstallLegacy, NEVER the real scheduler.
// ---------------------------------------------------------------------------

test('rollbackToLegacyUnits: uninstalls the per-project daemon, reinstalls EVERY enumerated worktree\'s legacy unit', () => {
  const io = mockIo(MAIN_WT, [MAIN_WT, LINKED_WT]);
  const expectedRepoKey = repokey.repoKeyForWorktree(MAIN_WT, { io });
  const uninstallCalls = [];
  const installCalls = [];
  const result = U.rollbackToLegacyUnits({
    platform: 'darwin',
    cwd: MAIN_WT,
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    io,
    doUninstallProject: (rk) => uninstallCalls.push(rk),
    doInstallLegacy: (wt) => installCalls.push(wt),
    readHeartbeat: (home, hash) => ({ fresh: true, ts: Date.now() }),
  });
  assert.equal(result.attempted, true);
  assert.equal(result.repoKey, expectedRepoKey);
  assert.equal(result.uninstalled, true);
  assert.deepEqual(uninstallCalls, [expectedRepoKey], 'the per-project daemon is uninstalled exactly once, by repoKey');
  assert.deepEqual(installCalls.sort(), [LINKED_WT, MAIN_WT].sort(), 'every enumerated worktree gets its OWN legacy unit reinstalled');
  assert.equal(result.reinstalled.length, 2);
  for (const entry of result.reinstalled) {
    assert.equal(entry.hash, installIngest.worktreeHash(entry.worktree), 'hash matches the SAME production primitive reap uses');
    assert.equal(entry.installed, true);
    assert.equal(entry.fresh, true);
  }
  assert.equal(result.viable, true, 'viable once every reinstalled unit has a fresh heartbeat');
});

test('rollbackToLegacyUnits: viable:false while ANY reinstalled unit has no fresh heartbeat yet (one-shot check, no poll/sleep)', () => {
  const io = mockIo(MAIN_WT, [MAIN_WT, LINKED_WT]);
  let call = 0;
  const result = U.rollbackToLegacyUnits({
    platform: 'darwin',
    cwd: MAIN_WT,
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    io,
    doUninstallProject: () => {},
    doInstallLegacy: () => {},
    readHeartbeat: () => { call++; return { fresh: call !== 2, ts: null }; }, // 2nd entry has NOT started yet
  });
  assert.equal(result.viable, false);
  assert.ok(result.reinstalled.some((r) => r.fresh === false));
  assert.ok(result.reinstalled.some((r) => r.fresh === true));
});

test('rollbackToLegacyUnits: a worktree whose reinstall throws is skipped (fail-open) — the rest still reinstall', () => {
  const io = mockIo(MAIN_WT, [MAIN_WT, LINKED_WT]);
  const result = U.rollbackToLegacyUnits({
    platform: 'darwin',
    cwd: MAIN_WT,
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    io,
    doUninstallProject: () => {},
    doInstallLegacy: (wt) => { if (wt === LINKED_WT) throw new Error('unit-write failed'); },
    readHeartbeat: () => ({ fresh: true, ts: Date.now() }),
  });
  assert.equal(result.reinstalled.length, 2);
  const failed = result.reinstalled.find((r) => r.worktree === LINKED_WT);
  const ok = result.reinstalled.find((r) => r.worktree === MAIN_WT);
  assert.equal(failed.installed, false);
  assert.equal(failed.fresh, false, 'a failed install never reads a heartbeat');
  assert.equal(ok.installed, true);
  assert.equal(ok.fresh, true);
  assert.equal(result.viable, false, 'one failed reinstall makes the whole rollback not-viable yet');
});

test('rollbackToLegacyUnits: no worktrees enumerated -> attempted:true, viable:false, nothing reinstalled', () => {
  const io = { run: (spec) => {
    const args = spec.args || [];
    if (args.includes('worktree') && args.includes('list')) return { ok: false, raw: '' };
    return { ok: true, raw: path.join(MAIN_WT, '.git') };
  }, fs: { realpathSync: (p) => p } };
  const result = U.rollbackToLegacyUnits({
    platform: 'darwin',
    cwd: MAIN_WT,
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    io,
    doUninstallProject: () => {},
    doInstallLegacy: () => { throw new Error('must not be called — nothing to reinstall'); },
  });
  assert.equal(result.attempted, true);
  assert.equal(result.viable, false);
  assert.deepEqual(result.reinstalled, []);
});

test('rollbackToLegacyUnits: default doUninstallProject/doInstallLegacy route to installIngest.macUninstallProject/macInstall (darwin) when only `installIngest` is overridden', () => {
  const io = mockIo(MAIN_WT, [MAIN_WT]);
  const macUninstallCalls = [];
  const macInstallCalls = [];
  const fakeInstallIngest = {
    resolveMainWorktree: installIngest.resolveMainWorktree,
    reapPlanForRepo: installIngest.reapPlanForRepo,
    macUninstallProject: (rk) => macUninstallCalls.push(rk),
    macInstall: (wt) => macInstallCalls.push(wt),
  };
  const result = U.rollbackToLegacyUnits({
    platform: 'darwin',
    cwd: MAIN_WT,
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    io,
    installIngest: fakeInstallIngest,
    readHeartbeat: () => ({ fresh: true, ts: Date.now() }),
  });
  assert.equal(macUninstallCalls.length, 1, 'the default wiring calls macUninstallProject exactly once, via the injected module');
  assert.equal(macInstallCalls.length, 1, 'the default wiring calls macInstall exactly once, via the injected module');
  assert.equal(result.viable, true);
});

// ---------------------------------------------------------------------------
// End-to-end against the REAL default readHeartbeat (heartbeats/ingest-
// <hash>.json under devswarmRoot(home)) + REAL store/<hash>/ non-destruction
// assertion (D13 — a rollback source is NEVER deleted).
// ---------------------------------------------------------------------------

test('rollbackToLegacyUnits: real readHeartbeat default reads heartbeats/ingest-<hash>.json fresh/stale correctly; store/<hash>/ untouched', () => {
  const home = tmpHome();
  try {
    const io = mockIo(MAIN_WT, [MAIN_WT]);
    const hash = installIngest.worktreeHash(MAIN_WT);

    // Simulate a pre-existing migration source (D13 leaves store/<hash>/ as
    // backup) — must survive the rollback untouched.
    const storeDir = path.join(devswarmRoot(home), 'store', hash);
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, 'devswarm.db'), 'PRESERVED-SOURCE-CONTENT');

    const result = U.rollbackToLegacyUnits({
      platform: 'darwin',
      cwd: MAIN_WT,
      home,
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      io,
      doUninstallProject: () => {},
      // Simulate the reinstalled daemon actually starting and writing its OWN
      // legacy heartbeat (writeIngestHeartbeat's real shape) — exercises the
      // DEFAULT readLegacyHeartbeat, not an injected stub.
      doInstallLegacy: (wt) => {
        const hbDir = path.join(devswarmRoot(home), 'heartbeats');
        fs.mkdirSync(hbDir, { recursive: true });
        fs.writeFileSync(path.join(hbDir, 'ingest-' + installIngest.worktreeHash(wt) + '.json'),
          JSON.stringify({ ts: Date.now(), workspaceId: 'primary-' + hash, workingDir: wt, pid: 1 }));
      },
    });

    assert.equal(result.viable, true, 'the real default readHeartbeat reads the just-written file as fresh');
    assert.equal(result.reinstalled[0].fresh, true);

    // D13: store/<hash>/ is NEVER touched by rollback.
    assert.equal(fs.readFileSync(path.join(storeDir, 'devswarm.db'), 'utf8'), 'PRESERVED-SOURCE-CONTENT');
  } finally { rm(home); }
});

test('readLegacyHeartbeat: stale (old ts), missing file, and corrupt JSON all read as NOT fresh — fail-open, never throws', () => {
  const home = tmpHome();
  try {
    const hash = 'deadbeef';
    const hbDir = path.join(devswarmRoot(home), 'heartbeats');
    fs.mkdirSync(hbDir, { recursive: true });

    // Missing file.
    assert.deepEqual(U.readLegacyHeartbeat(devswarmRoot, home, hash, () => Date.now()), { fresh: false, ts: null });

    // Stale (5 minutes old vs. the 3-minute D25 window).
    const staleTs = Date.now() - 5 * 60 * 1000;
    fs.writeFileSync(path.join(hbDir, 'ingest-' + hash + '.json'), JSON.stringify({ ts: staleTs }));
    const stale = U.readLegacyHeartbeat(devswarmRoot, home, hash, () => Date.now());
    assert.equal(stale.fresh, false);
    assert.equal(stale.ts, staleTs);

    // Fresh.
    const freshTs = Date.now() - 1000;
    fs.writeFileSync(path.join(hbDir, 'ingest-' + hash + '.json'), JSON.stringify({ ts: freshTs }));
    const fresh = U.readLegacyHeartbeat(devswarmRoot, home, hash, () => Date.now());
    assert.equal(fresh.fresh, true);

    // Corrupt JSON.
    fs.writeFileSync(path.join(hbDir, 'ingest-' + hash + '.json'), '{not json');
    assert.deepEqual(U.readLegacyHeartbeat(devswarmRoot, home, hash, () => Date.now()), { fresh: false, ts: null });
  } finally { rm(home); }
});

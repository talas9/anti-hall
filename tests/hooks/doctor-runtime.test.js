'use strict';
// doctor-runtime: DevSwarm RUNTIME health checks (companion/lib/doctor-runtime.js)
// as a pure, testable module — mirrors tests/companion/doctor-devswarm.test.js's
// isolated-fixture-home style. No real HOME/launchctl/systemctl/ps is ever
// touched: every probe accepts an injected spawnSync/fsi/now, and process
// enumeration/scheduler checks are stubbed. sqlite-specific cases are gated on
// store.sqliteAvailable() (skipped on node < 22.5-ish where node:sqlite is absent).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const D = require(path.join(ROOT, 'companion', 'lib', 'doctor-runtime.js'));
const store = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const installIngest = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));
const installSupervisor = require(path.join(ROOT, 'companion', 'install-devswarm-supervisor.js'));

function tmpHome(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dr-test-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

// ---------------------------------------------------------------------------
// check 1: checkDbHealth
// ---------------------------------------------------------------------------

test('checkDbHealth: empty home (no db, no journal) -> no results', () => {
  const { home, cleanup } = tmpHome();
  try {
    const r = D.checkDbHealth(home, {});
    assert.deepEqual(r, []);
  } finally { cleanup(); }
});

test('checkDbHealth: sqlite probe injected as ok:true, quick_check "ok" -> PASS', () => {
  const { home, cleanup } = tmpHome();
  try {
    fs.mkdirSync(path.dirname(store.sqlitePath(home)), { recursive: true });
    fs.writeFileSync(store.sqlitePath(home), 'not a real db, probe is stubbed anyway');
    const fakeSpawnSync = () => ({ status: 0, stdout: JSON.stringify({ ok: true, quickCheck: [{ quick_check: 'ok' }], counts: {} }) });
    const r = D.checkDbHealth(home, { spawnSync: fakeSpawnSync });
    const line = r.find((x) => /quick_check/.test(x.message));
    assert.ok(line, 'a quick_check line is present');
    assert.equal(line.status, D.PASS);
  } finally { cleanup(); }
});

test('checkDbHealth: sqlite probe injected as ok:true, quick_check NOT "ok" -> FAIL', () => {
  const { home, cleanup } = tmpHome();
  try {
    fs.mkdirSync(path.dirname(store.sqlitePath(home)), { recursive: true });
    fs.writeFileSync(store.sqlitePath(home), 'stub target');
    const fakeSpawnSync = () => ({ status: 0, stdout: JSON.stringify({ ok: true, quickCheck: [{ quick_check: 'corruption found on page 5' }], counts: {} }) });
    const r = D.checkDbHealth(home, { spawnSync: fakeSpawnSync });
    const line = r.find((x) => /quick_check/.test(x.message));
    assert.ok(line);
    assert.equal(line.status, D.FAIL);
  } finally { cleanup(); }
});

test('checkDbHealth: sqlite probe failure (spawn error) -> WARN, fail-open (never throws)', () => {
  const { home, cleanup } = tmpHome();
  try {
    fs.mkdirSync(path.dirname(store.sqlitePath(home)), { recursive: true });
    fs.writeFileSync(store.sqlitePath(home), 'stub target');
    const fakeSpawnSync = () => ({ error: new Error('spawn ENOENT') });
    const r = D.checkDbHealth(home, { spawnSync: fakeSpawnSync });
    const line = r.find((x) => /quick_check probe failed/.test(x.message));
    assert.ok(line);
    assert.equal(line.status, D.WARN);
  } finally { cleanup(); }
});

if (store.sqliteAvailable()) {
  test('[sqlite, real probe] checkDbHealth runs the REAL --no-warnings child probe end-to-end -> PASS, no ExperimentalWarning on our own stderr', () => {
    const { home, cleanup } = tmpHome();
    try {
      const s = store.openStore({ home, backend: 'sqlite' });
      s.appendMessage({ workspaceId: 'w1', body: 'hello', hash: 'h1' });
      s.close();
      const r = D.checkDbHealth(home, {});
      const line = r.find((x) => /quick_check/.test(x.message));
      assert.ok(line, 'quick_check line present: ' + JSON.stringify(r));
      assert.equal(line.status, D.PASS);
    } finally { cleanup(); }
  });

  test('[sqlite] runSqliteProbe on a missing db file -> ok:false, error set (no crash)', () => {
    const p = path.join(os.tmpdir(), 'antihall-dr-missing-' + Date.now() + '.db');
    const probe = D.runSqliteProbe(p, {});
    assert.equal(probe.ok, false);
    assert.ok(probe.error);
  });
}

test('checkDbHealth: journal backend with no torn lines -> PASS', () => {
  const { home, cleanup } = tmpHome();
  try {
    const s = store.openStore({ home, backend: 'journal' });
    s.appendMessage({ workspaceId: 'w1', body: 'a', hash: 'ha' });
    s.appendMessage({ workspaceId: 'w1', body: 'b', hash: 'hb' });
    const r = D.checkDbHealth(home, {});
    const line = r.find((x) => /journal (store|legacy)/.test(x.message));
    assert.ok(line);
    assert.equal(line.status, D.PASS);
  } finally { cleanup(); }
});

test('checkDbHealth: journal backend with a mid-file torn line -> WARN', () => {
  const { home, cleanup } = tmpHome();
  try {
    const dir = store.journalDir(home);
    fs.mkdirSync(dir, { recursive: true });
    // A torn line FOLLOWED by a valid one is real corruption (must be flagged).
    fs.writeFileSync(path.join(dir, 'messages.ndjson'), '{"broken\n{"workspaceId":"w","ts":1,"hash":"h","body":"x"}\n');
    const r = D.checkDbHealth(home, {});
    const line = r.find((x) => /journal (store|legacy)/.test(x.message));
    assert.ok(line);
    assert.equal(line.status, D.WARN);
    assert.match(line.message, /torn line/);
  } finally { cleanup(); }
});

test('checkDbHealth: a torn TRAILING line (in-flight write, no trailing newline) is NOT flagged', () => {
  const { home, cleanup } = tmpHome();
  try {
    const dir = store.journalDir(home);
    fs.mkdirSync(dir, { recursive: true });
    // Valid line + a trailing in-flight (incomplete) write with NO trailing \n.
    fs.writeFileSync(path.join(dir, 'messages.ndjson'), '{"workspaceId":"w","ts":1,"hash":"h","body":"x"}\n{"still-writ');
    const r = D.checkDbHealth(home, {});
    const line = r.find((x) => /journal (store|legacy)/.test(x.message));
    assert.ok(line);
    assert.equal(line.status, D.PASS, 'trailing in-flight line must not be flagged as torn');
  } finally { cleanup(); }
});

test('scanJournalTornLines: empty file -> checked but zero torn', () => {
  const { home, cleanup } = tmpHome();
  try {
    const dir = store.journalDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.ndjson'), '');
    const r = D.scanJournalTornLinesIn(store.journalDir(home), fs);
    assert.equal(r.checked, 1);
    assert.equal(r.torn.length, 0);
  } finally { cleanup(); }
});

test('checkDbHealth: store<->summary parity — summary.total > store.total -> WARN (journal backend)', () => {
  const { home, cleanup } = tmpHome();
  try {
    const s = store.openStore({ home, backend: 'journal' });
    s.appendMessage({ workspaceId: 'w1', body: 'a', hash: 'ha' });
    // summary claims 5 total though the store only has 1 message for w1.
    store.writeSummaryAtomic(home, undefined, { generatedAt: Date.now(), workspaces: { w1: { total: 5, cursor: 0, unread: 5 } } });
    const r = D.checkDbHealth(home, {});
    const line = r.find((x) => /summary total .* > store total/.test(x.message));
    assert.ok(line, 'parity WARN present: ' + JSON.stringify(r));
    assert.equal(line.status, D.WARN);
  } finally { cleanup(); }
});

test('checkDbHealth: store<->summary parity — store ahead of summary -> NEVER flagged', () => {
  const { home, cleanup } = tmpHome();
  try {
    const s = store.openStore({ home, backend: 'journal' });
    s.appendMessage({ workspaceId: 'w1', body: 'a', hash: 'ha' });
    s.appendMessage({ workspaceId: 'w1', body: 'b', hash: 'hb' });
    store.writeSummaryAtomic(home, undefined, { generatedAt: Date.now(), workspaces: { w1: { total: 1, cursor: 0, unread: 1 } } });
    const r = D.checkDbHealth(home, {});
    const line = r.find((x) => /summary total .* > store total/.test(x.message));
    assert.ok(!line, 'a store AHEAD of summary must never be flagged: ' + JSON.stringify(r));
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// check 3: checkDaemonsRunning
// ---------------------------------------------------------------------------

test('checkDaemonsRunning: win32 -> INFO no-op, anyRunning false', () => {
  const { home, cleanup } = tmpHome();
  try {
    const r = D.checkDaemonsRunning(home, { platform: 'win32' });
    assert.equal(r.anyRunning, false);
    assert.ok(r.results.some((x) => x.status === D.INFO && /Windows/.test(x.message)));
  } finally { cleanup(); }
});

test('checkDaemonsRunning: nothing installed -> both ingest + supervisor report INFO not-installed', () => {
  const { home, cleanup } = tmpHome();
  try {
    const platform = process.platform === 'win32' ? 'darwin' : process.platform;
    const r = D.checkDaemonsRunning(home, { platform });
    assert.ok(r.results.some((x) => x.status === D.INFO && /ingest daemon: not installed/.test(x.message)));
    assert.ok(r.results.some((x) => x.status === D.INFO && /supervisor: not installed/.test(x.message)));
    assert.equal(r.anyRunning, false);
  } finally { cleanup(); }
});

test('checkDaemonsRunning: installed ingest unit + injected "running" probe -> PASS, anyRunning true', { skip: process.platform === 'win32' }, () => {
  const { home, cleanup } = tmpHome();
  try {
    const platform = process.platform;
    const wt = path.join(home, 'wt-a');
    fs.mkdirSync(wt, { recursive: true });
    const hash = installIngest.worktreeHash(wt);
    if (platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(dir, { recursive: true });
      const label = installIngest.labelForWorktree(wt);
      fs.writeFileSync(path.join(dir, label + '.plist'), installIngest.buildPlist({ label, exec: '/n', script: '/a.js', log: '/l', workdir: wt }));
    } else {
      const dir = path.join(home, '.config', 'systemd', 'user');
      fs.mkdirSync(dir, { recursive: true });
      const unit = installIngest.unitForWorktree(wt);
      fs.writeFileSync(path.join(dir, unit + '.service'), installIngest.buildService({ exec: '/n', script: '/a.js', workdir: wt }));
    }
    const fakeSpawnSync = (cmd, argv) => {
      if (cmd === 'launchctl') return { status: 0, stdout: 'label = x\n"PID" = 1234;\n' };
      if (cmd === 'systemctl') return { status: 0, stdout: 'active\n' };
      return { status: 1, stdout: '' };
    };
    const r = D.checkDaemonsRunning(home, { platform, spawnSync: fakeSpawnSync });
    assert.ok(r.results.some((x) => x.status === D.PASS && /ingest daemon .*RUNNING/.test(x.message)), JSON.stringify(r.results));
    assert.equal(r.anyRunning, true);
    assert.equal(r.runningByHash[hash], true);
  } finally { cleanup(); }
});

test('checkDaemonsRunning: installed ingest unit + injected "dead" probe -> WARN (installed but not running)', { skip: process.platform === 'win32' }, () => {
  const { home, cleanup } = tmpHome();
  try {
    const platform = process.platform;
    const wt = path.join(home, 'wt-b');
    fs.mkdirSync(wt, { recursive: true });
    if (platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(dir, { recursive: true });
      const label = installIngest.labelForWorktree(wt);
      fs.writeFileSync(path.join(dir, label + '.plist'), installIngest.buildPlist({ label, exec: '/n', script: '/a.js', log: '/l', workdir: wt }));
    } else {
      const dir = path.join(home, '.config', 'systemd', 'user');
      fs.mkdirSync(dir, { recursive: true });
      const unit = installIngest.unitForWorktree(wt);
      fs.writeFileSync(path.join(dir, unit + '.service'), installIngest.buildService({ exec: '/n', script: '/a.js', workdir: wt }));
    }
    const fakeSpawnSync = (cmd) => {
      if (cmd === 'launchctl') return { status: 1, stdout: '' }; // not loaded
      if (cmd === 'systemctl') return { status: 3, stdout: 'inactive\n' };
      return { status: 1, stdout: '' };
    };
    const r = D.checkDaemonsRunning(home, { platform, spawnSync: fakeSpawnSync });
    assert.ok(r.results.some((x) => x.status === D.WARN && /installed but NOT running \(dead\)/.test(x.message)), JSON.stringify(r.results));
    assert.equal(r.anyRunning, false);
  } finally { cleanup(); }
});

test('checkDaemonsRunning: probe throws/errors -> WARN "running-state unknown", never crashes', { skip: process.platform === 'win32' }, () => {
  const { home, cleanup } = tmpHome();
  try {
    const platform = process.platform;
    const wt = path.join(home, 'wt-c');
    fs.mkdirSync(wt, { recursive: true });
    if (platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(dir, { recursive: true });
      const label = installIngest.labelForWorktree(wt);
      fs.writeFileSync(path.join(dir, label + '.plist'), installIngest.buildPlist({ label, exec: '/n', script: '/a.js', log: '/l', workdir: wt }));
    } else {
      const dir = path.join(home, '.config', 'systemd', 'user');
      fs.mkdirSync(dir, { recursive: true });
      const unit = installIngest.unitForWorktree(wt);
      fs.writeFileSync(path.join(dir, unit + '.service'), installIngest.buildService({ exec: '/n', script: '/a.js', workdir: wt }));
    }
    const fakeSpawnSync = () => ({ error: new Error('spawn ENOENT') });
    const r = D.checkDaemonsRunning(home, { platform, spawnSync: fakeSpawnSync });
    assert.ok(r.results.some((x) => x.status === D.WARN && /running-state unknown/.test(x.message)));
  } finally { cleanup(); }
});

test('checkDaemonsRunning: installed supervisor + injected "loaded/active" probe -> PASS (periodic unit, no PID required)', { skip: process.platform === 'win32' }, () => {
  const { home, cleanup } = tmpHome();
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, installSupervisor.LABEL + '.plist'), installSupervisor.buildPlist());
    } else {
      const dir = path.join(home, '.config', 'systemd', 'user');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, installSupervisor.UNIT + '.timer'), installSupervisor.buildTimer());
    }
    // launchd: exit 0 with NO "PID" key at all (a periodic StartInterval job is
    // idle between sweeps) must still read as scheduled/RUNNING.
    const fakeSpawnSync = (cmd) => {
      if (cmd === 'launchctl') return { status: 0, stdout: 'label = x\n"LastExitStatus" = 0;\n' };
      if (cmd === 'systemctl') return { status: 0, stdout: 'active\n' };
      return { status: 1, stdout: '' };
    };
    const r = D.checkDaemonsRunning(home, { platform, spawnSync: fakeSpawnSync });
    assert.ok(r.results.some((x) => x.status === D.PASS && /supervisor: scheduled\/RUNNING/.test(x.message)), JSON.stringify(r.results));
  } finally { cleanup(); }
});

test('probeCronRunning: prefers a FRESH ingest heartbeat over ps', () => {
  const { home, cleanup } = tmpHome();
  try {
    const ingestMod = require(path.join(ROOT, 'companion', 'devswarm-ingest.js'));
    const hash = 'deadbeef';
    const hbPath = ingestMod.ingestHeartbeatPath(home, hash);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: Date.now(), pid: 999 }));
    const r = D.probeCronRunning(home, hash, { now: Date.now(), spawnSync: () => { throw new Error('ps must not be called'); } });
    assert.equal(r.known, true);
    assert.equal(r.running, true);
    assert.equal(r.via, 'heartbeat');
  } finally { cleanup(); }
});

test('probeCronRunning: stale heartbeat -> running:false via heartbeat', () => {
  const { home, cleanup } = tmpHome();
  try {
    const ingestMod = require(path.join(ROOT, 'companion', 'devswarm-ingest.js'));
    const hash = 'deadbeef';
    const hbPath = ingestMod.ingestHeartbeatPath(home, hash);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: Date.now() - 60 * 60 * 1000, pid: 999 }));
    const r = D.probeCronRunning(home, hash, { now: Date.now() });
    assert.equal(r.known, true);
    assert.equal(r.running, false);
  } finally { cleanup(); }
});

test('probeCronRunning: no hash (legacy pre-per-worktree unit) -> falls back to bare ps scan', { skip: process.platform === 'win32' }, () => {
  const { home, cleanup } = tmpHome();
  try {
    const fakeSpawnSync = () => ({ status: 0, stdout: '  123 node /x/companion/devswarm-ingest.js\n' });
    const r = D.probeCronRunning(home, null, { spawnSync: fakeSpawnSync });
    assert.equal(r.known, true);
    assert.equal(r.running, true);
    assert.equal(r.via, 'ps');
  } finally { cleanup(); }
});

// P1 repro: a DEAD cron unit for worktree hash X must NOT read as running just
// because an UNRELATED worktree's ingest daemon happens to be alive. Before the
// fix, no heartbeat for hash X fell through to a bare `ps` scan matching ANY
// devswarm-ingest.js process — a false positive across worktrees.
test('probeCronRunning: hash given, no heartbeat, UNRELATED worktree ingest process present, no lock for this hash -> running:false (P1 fix)', () => {
  const { home, cleanup } = tmpHome();
  try {
    // An unrelated worktree's ingest daemon really is running (ps sees it), but
    // it must never be attributed to a DIFFERENT worktree's hash.
    const fakeSpawnSync = () => ({ status: 0, stdout: '  424242 node /some/other/worktree/companion/devswarm-ingest.js\n' });
    const r = D.probeCronRunning(home, 'deadbeef', { spawnSync: fakeSpawnSync });
    assert.equal(r.known, true);
    assert.equal(r.running, false, JSON.stringify(r));
  } finally { cleanup(); }
});

test('probeCronRunning: hash given, no heartbeat, fresh per-worktree lock held by a live PID -> running:true via lock', () => {
  const { home, cleanup } = tmpHome();
  try {
    const hash = 'deadbeef';
    const locksDir = require('path').join(home, '.anti-hall', 'devswarm', 'locks');
    fs.mkdirSync(locksDir, { recursive: true });
    fs.writeFileSync(path.join(locksDir, 'ingest-' + hash + '.lock'), JSON.stringify({ pid: process.pid, ts: Date.now(), token: 't' }));
    const r = D.probeCronRunning(home, hash, { spawnSync: () => ({ status: 0, stdout: '' }) });
    assert.equal(r.known, true);
    assert.equal(r.running, true);
    assert.equal(r.via, 'lock');
  } finally { cleanup(); }
});

test('probeCronRunning: hash given, no heartbeat, lock holder PID is dead -> running:false via lock', () => {
  const { home, cleanup } = tmpHome();
  try {
    const hash = 'deadbeef';
    const locksDir = require('path').join(home, '.anti-hall', 'devswarm', 'locks');
    fs.mkdirSync(locksDir, { recursive: true });
    // A PID this large is not a real running process on any test runner.
    fs.writeFileSync(path.join(locksDir, 'ingest-' + hash + '.lock'), JSON.stringify({ pid: 2147480000, ts: Date.now(), token: 't' }));
    const r = D.probeCronRunning(home, hash, { spawnSync: () => ({ status: 0, stdout: '' }) });
    assert.equal(r.known, true);
    assert.equal(r.running, false, JSON.stringify(r));
    assert.equal(r.via, 'lock');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// check 2: checkDataStaleness (depends on daemonInfo from check 3)
// ---------------------------------------------------------------------------

test('checkDataStaleness: daemon NOT running -> no results regardless of staleness', () => {
  const { home, cleanup } = tmpHome();
  try {
    store.writeSummaryAtomic(home, undefined, { generatedAt: Date.now() - 60 * 60 * 1000, workspaces: { w1: { total: 5, cursor: 0, unread: 5 } } });
    const r = D.checkDataStaleness(home, { daemonInfo: { anyRunning: false } });
    assert.deepEqual(r, []);
  } finally { cleanup(); }
});

test('checkDataStaleness: daemon running but unread=0 (idle) -> no results, no false alarm', () => {
  const { home, cleanup } = tmpHome();
  try {
    store.writeSummaryAtomic(home, undefined, { generatedAt: Date.now() - 60 * 60 * 1000, workspaces: { w1: { total: 5, cursor: 5, unread: 0 } } });
    const r = D.checkDataStaleness(home, { daemonInfo: { anyRunning: true } });
    assert.deepEqual(r, []);
  } finally { cleanup(); }
});

test('checkDataStaleness: primary workspace, OWN daemon confirmed running, unread>0 + old generatedAt + no heartbeat -> WARN', () => {
  const { home, cleanup } = tmpHome();
  try {
    const hash = 'deadbeef';
    const id = 'primary-' + hash;
    store.writeSummaryAtomic(home, undefined, { generatedAt: Date.now() - 60 * 60 * 1000, workspaces: { [id]: { total: 5, cursor: 2, unread: 3 } } });
    const r = D.checkDataStaleness(home, { now: Date.now(), daemonInfo: { anyRunning: true, runningByHash: { [hash]: true } } });
    assert.equal(r.length, 1);
    assert.equal(r[0].status, D.WARN);
    assert.match(r[0].message, new RegExp('workspace ' + id));
  } finally { cleanup(); }
});

// P2 repro: a CHILD workspace's summary shows unread>0 forever (devswarm-pull.js
// deliberately never advances its store cursor — deriveSummary sets unread=total),
// so it must NOT false-WARN just because SOME unrelated primary daemon (a
// different worktree) happens to be running. The child id has no derivable
// per-worktree hash, so there is no "own daemon" to attribute staleness to.
test('checkDataStaleness: CHILD workspace (no derivable hash), unread>0 forever + old generatedAt, only an UNRELATED primary daemon running -> no false WARN (P2 fix)', () => {
  const { home, cleanup } = tmpHome();
  try {
    store.writeSummaryAtomic(home, undefined, { generatedAt: Date.now() - 60 * 60 * 1000, workspaces: { 'child-workspace-1': { total: 5, cursor: 0, unread: 5 } } });
    // Some OTHER worktree's primary daemon is running (anyRunning true), but that
    // hash has nothing to do with this child workspace.
    const r = D.checkDataStaleness(home, { now: Date.now(), daemonInfo: { anyRunning: true, runningByHash: { cafefeed: true } } });
    assert.deepEqual(r, []);
  } finally { cleanup(); }
});

test('checkDataStaleness: primary workspace with a derivable hash, but THAT hash confirmed NOT running (only an unrelated hash is) -> no WARN', () => {
  const { home, cleanup } = tmpHome();
  try {
    const hash = 'deadbeef';
    const id = 'primary-' + hash;
    store.writeSummaryAtomic(home, undefined, { generatedAt: Date.now() - 60 * 60 * 1000, workspaces: { [id]: { total: 5, cursor: 2, unread: 3 } } });
    const r = D.checkDataStaleness(home, { now: Date.now(), daemonInfo: { anyRunning: true, runningByHash: { [hash]: false, cafefeed: true } } });
    assert.deepEqual(r, []);
  } finally { cleanup(); }
});

test('checkDataStaleness: daemon running + unread>0 + FRESH matching heartbeat -> no WARN even if generatedAt is old', () => {
  const { home, cleanup } = tmpHome();
  try {
    const hash = 'cafe1234';
    const id = 'primary-' + hash;
    store.writeSummaryAtomic(home, undefined, { generatedAt: Date.now() - 60 * 60 * 1000, workspaces: { [id]: { total: 5, cursor: 2, unread: 3 } } });
    const ingestMod = require(path.join(ROOT, 'companion', 'devswarm-ingest.js'));
    const hbPath = ingestMod.ingestHeartbeatPath(home, hash);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: Date.now(), pid: 1 }));
    const r = D.checkDataStaleness(home, { now: Date.now(), daemonInfo: { anyRunning: true } });
    assert.deepEqual(r, []);
  } finally { cleanup(); }
});

test('hashFromWorkspaceId: extracts the hash from `primary-<hash>`, null otherwise', () => {
  assert.equal(D.hashFromWorkspaceId('primary-deadbeef'), 'deadbeef');
  assert.equal(D.hashFromWorkspaceId('some-other-id'), null);
  assert.equal(D.hashFromWorkspaceId(''), null);
});

// ---------------------------------------------------------------------------
// check 4: checkNoOtherConsumer
// ---------------------------------------------------------------------------

test('checkNoOtherConsumer: win32 -> INFO unknown', () => {
  const { home, cleanup } = tmpHome();
  try {
    const r = D.checkNoOtherConsumer(home, { platform: 'win32' });
    assert.ok(r.some((x) => x.status === D.INFO && /unknown on Windows/.test(x.message)));
  } finally { cleanup(); }
});

test('checkNoOtherConsumer: no monitor processes -> PASS "none detected"', { skip: process.platform === 'win32' }, () => {
  const { home, cleanup } = tmpHome();
  try {
    const fakeSpawnSync = () => ({ status: 0, stdout: '  1 /sbin/launchd\n  50 node /x/some-other-script.js\n' });
    const r = D.checkNoOtherConsumer(home, { platform: process.platform, spawnSync: fakeSpawnSync });
    assert.ok(r.some((x) => x.status === D.PASS && /no .*monitor.*consumer process detected/.test(x.message)));
  } finally { cleanup(); }
});

test('checkNoOtherConsumer: exactly one monitor process matching the lock holder -> PASS', { skip: process.platform === 'win32' }, () => {
  const { home, cleanup } = tmpHome();
  try {
    const locksDir = path.join(home, '.anti-hall', 'devswarm', 'locks');
    fs.mkdirSync(locksDir, { recursive: true });
    fs.writeFileSync(path.join(locksDir, 'ingest.lock'), JSON.stringify({ pid: process.pid, ts: Date.now(), token: 't' }));
    const fakeSpawnSync = () => ({ status: 0, stdout: '  ' + process.pid + ' hivecontrol workspace monitor\n' });
    const r = D.checkNoOtherConsumer(home, { platform: process.platform, spawnSync: fakeSpawnSync });
    assert.ok(r.some((x) => x.status === D.PASS && /exactly one/.test(x.message)), JSON.stringify(r));
  } finally { cleanup(); }
});

test('checkNoOtherConsumer: TWO monitor processes -> WARN SECOND CONSUMER (report-only)', { skip: process.platform === 'win32' }, () => {
  const { home, cleanup } = tmpHome();
  try {
    const locksDir = path.join(home, '.anti-hall', 'devswarm', 'locks');
    fs.mkdirSync(locksDir, { recursive: true });
    fs.writeFileSync(path.join(locksDir, 'ingest.lock'), JSON.stringify({ pid: process.pid, ts: Date.now(), token: 't' }));
    const fakeSpawnSync = () => ({
      status: 0,
      stdout: '  ' + process.pid + ' hivecontrol workspace monitor\n  99999 hivecontrol workspace monitor\n',
    });
    const r = D.checkNoOtherConsumer(home, { platform: process.platform, spawnSync: fakeSpawnSync });
    const line = r.find((x) => /SECOND CONSUMER/.test(x.message));
    assert.ok(line, JSON.stringify(r));
    assert.equal(line.status, D.WARN);
  } finally { cleanup(); }
});

test('checkNoOtherConsumer: a monitor PID with no matching lock holder -> WARN stray consumer', { skip: process.platform === 'win32' }, () => {
  const { home, cleanup } = tmpHome();
  try {
    // No lock file at all — a monitor process running with nobody holding the lock.
    const fakeSpawnSync = () => ({ status: 0, stdout: '  424242 hivecontrol workspace monitor\n' });
    const r = D.checkNoOtherConsumer(home, { platform: process.platform, spawnSync: fakeSpawnSync });
    const line = r.find((x) => /SECOND CONSUMER/.test(x.message));
    assert.ok(line, JSON.stringify(r));
    assert.match(line.message, /hold no lock/);
  } finally { cleanup(); }
});

test('checkNoOtherConsumer: process enumeration failure -> WARN, fail-open (never throws)', { skip: process.platform === 'win32' }, () => {
  const { home, cleanup } = tmpHome();
  try {
    const fakeSpawnSync = () => ({ error: new Error('spawn ENOENT') });
    const r = D.checkNoOtherConsumer(home, { platform: process.platform, spawnSync: fakeSpawnSync });
    assert.ok(r.some((x) => x.status === D.WARN && /process enumeration failed/.test(x.message)));
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// runChecks (orchestration of checks 1-4)
// ---------------------------------------------------------------------------

test('runChecks: empty/dormant home never throws and returns an array', () => {
  const { home, cleanup } = tmpHome();
  try {
    const r = D.runChecks({ home, env: {} });
    assert.ok(Array.isArray(r.results));
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// check 5: scanForeignConflicts
// ---------------------------------------------------------------------------

function writeFakePlugin(pluginsRoot, marketplace, name, version, hooksCfg, skillNames) {
  const installPath = path.join(pluginsRoot, 'cache', marketplace, name, version);
  if (hooksCfg) {
    fs.mkdirSync(path.join(installPath, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(installPath, 'hooks', 'hooks.json'), JSON.stringify(hooksCfg));
  }
  for (const s of (skillNames || [])) {
    fs.mkdirSync(path.join(installPath, 'skills', s), { recursive: true });
  }
  return installPath;
}

function writeInstalledPluginsJson(home, entries) {
  const p = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const plugins = {};
  for (const [key, installPath] of Object.entries(entries)) {
    plugins[key] = [{ scope: 'user', installPath, version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z', lastUpdated: '2026-01-01T00:00:00.000Z' }];
  }
  fs.writeFileSync(p, JSON.stringify({ version: 2, plugins }));
}

function writeSettingsEnabled(home, keys) {
  const p = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const enabledPlugins = {};
  for (const k of keys) enabledPlugins[k] = true;
  fs.writeFileSync(p, JSON.stringify({ enabledPlugins }));
}

test('scanForeignConflicts: no other enabled plugins -> empty results', () => {
  const { home, cleanup } = tmpHome();
  try {
    writeSettingsEnabled(home, ['anti-hall@anti-hall']);
    const r = D.scanForeignConflicts({ home, cwd: home });
    assert.deepEqual(r.results, []);
  } finally { cleanup(); }
});

test('scanForeignConflicts: enabled but not in installed_plugins.json -> skipped, fail-open', () => {
  const { home, cleanup } = tmpHome();
  try {
    writeSettingsEnabled(home, ['anti-hall@anti-hall', 'ghost@nowhere']);
    // No installed_plugins.json at all.
    const r = D.scanForeignConflicts({ home, cwd: home });
    assert.deepEqual(r.results, []);
  } finally { cleanup(); }
});

test('scanForeignConflicts: foreign PreToolUse Bash hook -> HIGH', () => {
  const { home, cleanup } = tmpHome();
  try {
    const pluginsRoot = path.join(home, '.claude', 'plugins');
    const installPath = writeFakePlugin(pluginsRoot, 'mp', 'foo', '1.0.0', {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/some/path/foo-guard.js"' }] }] },
    });
    writeInstalledPluginsJson(home, { 'foo@mp': installPath });
    writeSettingsEnabled(home, ['anti-hall@anti-hall', 'foo@mp']);
    const r = D.scanForeignConflicts({ home, cwd: home });
    const line = r.results.find((x) => /foreign PreToolUse hook on Bash/.test(x.message));
    assert.ok(line, JSON.stringify(r.results));
    assert.equal(line.status, 'HIGH');
    assert.match(line.message, /foo-guard\.js/);
    assert.match(line.message, /plugin "foo"/);
  } finally { cleanup(); }
});

test('scanForeignConflicts: foreign Stop hook -> HIGH', () => {
  const { home, cleanup } = tmpHome();
  try {
    const pluginsRoot = path.join(home, '.claude', 'plugins');
    const installPath = writeFakePlugin(pluginsRoot, 'mp', 'bar', '1.0.0', {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/some/path/bar-stop.mjs"' }] }] },
    });
    writeInstalledPluginsJson(home, { 'bar@mp': installPath });
    writeSettingsEnabled(home, ['anti-hall@anti-hall', 'bar@mp']);
    const r = D.scanForeignConflicts({ home, cwd: home });
    const line = r.results.find((x) => /foreign Stop hook/.test(x.message));
    assert.ok(line, JSON.stringify(r.results));
    assert.equal(line.status, 'HIGH');
  } finally { cleanup(); }
});

test('scanForeignConflicts: additive SessionStart/UserPromptSubmit overlap -> INFO, non-competing', () => {
  const { home, cleanup } = tmpHome();
  try {
    const pluginsRoot = path.join(home, '.claude', 'plugins');
    const installPath = writeFakePlugin(pluginsRoot, 'mp', 'baz', '1.0.0', {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node "/x/baz-start.js"' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "/x/baz-prompt.js"' }] }],
      },
    });
    writeInstalledPluginsJson(home, { 'baz@mp': installPath });
    writeSettingsEnabled(home, ['anti-hall@anti-hall', 'baz@mp']);
    const r = D.scanForeignConflicts({ home, cwd: home });
    assert.ok(r.results.every((x) => x.status === D.INFO), JSON.stringify(r.results));
    assert.ok(r.results.some((x) => /additive SessionStart overlap/.test(x.message)));
    assert.ok(r.results.some((x) => /additive UserPromptSubmit overlap/.test(x.message)));
  } finally { cleanup(); }
});

test('scanForeignConflicts: skill-name collision -> HIGH', () => {
  const { home, cleanup } = tmpHome();
  try {
    const pluginsRoot = path.join(home, '.claude', 'plugins');
    // anti-hall ships a "doctor" skill (plugins/anti-hall/skills/doctor/) — collide with that.
    const installPath = writeFakePlugin(pluginsRoot, 'mp', 'collider', '1.0.0', null, ['doctor']);
    writeInstalledPluginsJson(home, { 'collider@mp': installPath });
    writeSettingsEnabled(home, ['anti-hall@anti-hall', 'collider@mp']);
    const r = D.scanForeignConflicts({ home, cwd: home });
    const line = r.results.find((x) => /skill-name collision/.test(x.message));
    assert.ok(line, JSON.stringify(r.results));
    assert.equal(line.status, 'HIGH');
    assert.match(line.message, /"doctor"/);
  } finally { cleanup(); }
});

test('scanForeignConflicts: PRIVACY — never leaks the full command string or a local path (only basename)', () => {
  const { home, cleanup } = tmpHome();
  try {
    const pluginsRoot = path.join(home, '.claude', 'plugins');
    const installPath = writeFakePlugin(pluginsRoot, 'mp', 'privtest', '1.0.0', {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/Users/some-secret-user/.claude/plugins/cache/privtest/1.0.0/hooks/leaky-hook.js" --flag=SECRET' }] }] },
    });
    writeInstalledPluginsJson(home, { 'privtest@mp': installPath });
    writeSettingsEnabled(home, ['anti-hall@anti-hall', 'privtest@mp']);
    const r = D.scanForeignConflicts({ home, cwd: home });
    const line = r.results.find((x) => /foreign Stop hook/.test(x.message));
    assert.ok(line);
    assert.doesNotMatch(line.message, /some-secret-user/);
    assert.doesNotMatch(line.message, /SECRET/);
    assert.doesNotMatch(line.message, /\/Users\//);
    assert.match(line.message, /leaky-hook\.js/);
  } finally { cleanup(); }
});

test('scanForeignConflicts: dedupes identical (status,message) lines', () => {
  const { home, cleanup } = tmpHome();
  try {
    const pluginsRoot = path.join(home, '.claude', 'plugins');
    const installPath = writeFakePlugin(pluginsRoot, 'mp', 'dupe', '1.0.0', {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'node run.cjs a' }] },
          { hooks: [{ type: 'command', command: 'node run.cjs b' }] },
        ],
      },
    });
    writeInstalledPluginsJson(home, { 'dupe@mp': installPath });
    writeSettingsEnabled(home, ['anti-hall@anti-hall', 'dupe@mp']);
    const r = D.scanForeignConflicts({ home, cwd: home });
    const stopLines = r.results.filter((x) => /foreign Stop hook/.test(x.message));
    assert.equal(stopLines.length, 1, 'both hooks share the same basename (run.cjs) -> one deduped line');
  } finally { cleanup(); }
});

test('scanForeignConflicts: never throws when installed_plugins.json is malformed', () => {
  const { home, cleanup } = tmpHome();
  try {
    const p = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'not json{{{');
    writeSettingsEnabled(home, ['anti-hall@anti-hall', 'ghost@nowhere']);
    assert.doesNotThrow(() => D.scanForeignConflicts({ home, cwd: home }));
  } finally { cleanup(); }
});

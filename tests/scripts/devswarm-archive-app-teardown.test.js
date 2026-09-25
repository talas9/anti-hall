'use strict';
// cmdArchive (scripts/devswarm.js) — APP ARCHIVE + accurate manualStep text,
// and the LIVE-CHILD warning's app-DB cross-check.
//
// Root causes fixed (both from a live substrate test, 2026-09-25):
//   1. cmdArchive's `manualStep` claimed "hivecontrol has no teardown
//      command" — FALSE on DevSwarm >= 2.5.3, which has a real
//      `workspace archive <id>` verb (proven live: it sets isActive=0/
//      isHidden=1). When the capability gate (devswarm-capabilities.js
//      can('workspace.archive')) allows it, cmdArchive now ALSO archives the
//      workspace in the app, with the EXPLICIT id always (never relying on
//      hivecontrol's "current workspace" default). The first attempt can
//      fail with "Could not confirm terminal process boundary" — a retry
//      succeeds; this is retried exactly once, targeted at that one error
//      text. Dormant/failed falls back to an ACCURATE manual-step string,
//      never the old false claim.
//   2. The LIVE-CHILD warning ("child session still live") fired off a
//      heartbeat file ALONE, which can be stale — e.g. the workspace was
//      already deleted in the app, whose builder-row removal an anti-hall
//      heartbeat file cannot observe. It now cross-checks the app DB's
//      builder rows: no row for this id -> the warning is suppressed.
//
// Every hivecontrol call in this suite goes through a FAKE binary
// (tests/helpers/fake-hivecontrol.js, or a small inline stand-in for the
// retry case) injected via PATH — the real hivecontrol is NEVER spawned.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const livenessLib = require('../../plugins/anti-hall/companion/lib/liveness.js');
const capsLib = require('../../plugins/anti-hall/companion/lib/devswarm-capabilities.js');
const { fakeHivecontrol, readCalls } = require('../helpers/fake-hivecontrol.js');
const { buildAppDb, rmFixture } = require('../helpers/app-db-fixture.js');

const BACKEND = 'journal';
const FIX = path.join(__dirname, '..', 'fixtures', 'devswarm-capabilities');
const HELP_253 = path.join(FIX, 'hivecontrol-2.5.3-workspace-help.txt');
const ARCHIVE_253 = path.join(FIX, 'hivecontrol-2.5.3-archive-help.txt');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-archteardown-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-archteardown-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
const openS = (home, bucket) => storeLib.openStore({ home, hash: bucket, backend: BACKEND });
function seedReg(home, bucket, desc) { const s = openS(home, bucket); try { s.upsertRegistry(desc); } finally { s.close(); } }
function writeDesc(home, id, desc) {
  const p = cli.descriptorPath(home, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(desc));
  return p;
}
const ID_A = 'b3f1c2d4-1111-4000-8000-abcdef012345';
function seedOne(home, W, id) {
  const repoKey = repokey.repoKeyForWorktree(W);
  const top = inst.resolveWorktree(W);
  const desc = { id, worktreePath: top, sessionId: 'sess-' + id, ownerKey: repoKey, repoKey };
  seedReg(home, repoKey, desc); writeDesc(home, id, desc);
  return { repoKey, desc };
}

test('APP ARCHIVE: capability present + hivecontrol succeeds -> archives in the app, EXPLICIT id passed, manualStep is accurate', () => {
  const home = tmpHome();
  const W = makeGitRepo('ok');
  try {
    seedOne(home, W, ID_A);
    const fake = fakeHivecontrol(path.join(home, 'bin'), { version: '2.5.3', workspaceHelp: HELP_253, verbHelp: { archive: ARCHIVE_253 } });
    capsLib.resetCache();
    const ctx = { home, cwd: W, env: { HOME: home, PATH: fake.dir, ANTIHALL_DEVSWARM_APP_DB: 'off' }, backend: BACKEND };
    const r = cli.run(['archive', ID_A], ctx);
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.appArchive.attempted, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.appArchive.ok, true, JSON.stringify(r.result));
    assert.ok(!/no teardown command/.test(r.result.manualStep), 'the old false claim must be gone: ' + r.result.manualStep);
    assert.match(r.result.manualStep, /DevSwarm app/);
    const calls = readCalls(fake.callsFile);
    const archiveCalls = calls.filter((c) => c.argv[0] === 'workspace' && c.argv[1] === 'archive' && c.argv[2] !== '--help');
    assert.strictEqual(archiveCalls.length, 1, JSON.stringify(calls));
    assert.deepStrictEqual(archiveCalls[0].argv, ['workspace', 'archive', ID_A], 'the EXPLICIT id must always be passed');
  } finally { rm(W); rm(home); }
});

test('APP ARCHIVE: capability dormant (hivecontrol absent) -> not attempted, manualStep is accurate and self-identifies why', () => {
  const home = tmpHome();
  const W = makeGitRepo('absent');
  try {
    seedOne(home, W, ID_A);
    capsLib.resetCache();
    const emptyBin = path.join(home, 'empty-bin');
    fs.mkdirSync(emptyBin, { recursive: true });
    const ctx = { home, cwd: W, env: { HOME: home, PATH: emptyBin, ANTIHALL_DEVSWARM_APP_DB: 'off' }, backend: BACKEND };
    const r = cli.run(['archive', ID_A], ctx);
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.appArchive.attempted, false, JSON.stringify(r.result));
    assert.ok(!/no teardown command/.test(r.result.manualStep), 'the old false claim must be gone: ' + r.result.manualStep);
    assert.match(r.result.manualStep, /hivecontrol workspace archive/);
    assert.match(r.result.manualStep, /DevSwarm app/);
  } finally { rm(W); rm(home); }
});

test('APP ARCHIVE: retries ONCE on "Could not confirm terminal process boundary", then succeeds', () => {
  const home = tmpHome();
  const W = makeGitRepo('retry');
  try {
    seedOne(home, W, ID_A);
    // Small inline fake binary: fails the FIRST `workspace archive` call with
    // the exact known-flaky boundary text, succeeds on the second — proves
    // the retry-once path without spawning anything real.
    const bin = path.join(home, 'bin2');
    fs.mkdirSync(bin, { recursive: true });
    const stateFile = path.join(bin, 'calls.json');
    fs.writeFileSync(stateFile, '0');
    const src = '#!' + process.execPath + '\n'
      + "'use strict';\nconst fs=require('fs');const a=process.argv.slice(2);\n"
      + "if(a[0]==='--version'){console.log('2.5.3');process.exit(0);}\n"
      + "if(a[0]==='workspace'&&a[1]==='--help'){process.stdout.write(fs.readFileSync(" + JSON.stringify(HELP_253) + ",'utf8'));process.exit(0);}\n"
      + "if(a[0]==='workspace'&&a[1]==='archive'&&a[2]==='--help'){process.stdout.write(fs.readFileSync(" + JSON.stringify(ARCHIVE_253) + ",'utf8'));process.exit(0);}\n"
      + "if(a[0]==='workspace'&&a[1]==='archive'){let n=parseInt(fs.readFileSync(" + JSON.stringify(stateFile) + ",'utf8'),10)||0;n++;fs.writeFileSync(" + JSON.stringify(stateFile) + ",String(n));\n"
      + "  if(n===1){process.stderr.write('Error: Could not confirm terminal process boundary\\n');process.exit(1);}\n"
      + "  console.log(JSON.stringify({ok:true}));process.exit(0);}\n"
      + 'process.exit(2);\n';
    fs.writeFileSync(path.join(bin, 'hivecontrol'), src, { mode: 0o755 });
    capsLib.resetCache();
    const ctx = { home, cwd: W, env: { HOME: home, PATH: bin, ANTIHALL_DEVSWARM_APP_DB: 'off' }, backend: BACKEND };
    const r = cli.run(['archive', ID_A], ctx);
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.appArchive.attempted, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.appArchive.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.appArchive.retried, true, JSON.stringify(r.result));
    assert.strictEqual(fs.readFileSync(stateFile, 'utf8'), '2', 'exactly two attempts (one retry)');
  } finally { rm(W); rm(home); }
});

test('APP ARCHIVE: a genuinely FAILED archive (not the retryable error) is reported once, no retry loop', () => {
  const home = tmpHome();
  const W = makeGitRepo('hardfail');
  try {
    seedOne(home, W, ID_A);
    const fake = fakeHivecontrol(path.join(home, 'bin3'), {
      version: '2.5.3', workspaceHelp: HELP_253, verbHelp: { archive: ARCHIVE_253 }, mutateExit: 1,
    });
    capsLib.resetCache();
    const ctx = { home, cwd: W, env: { HOME: home, PATH: fake.dir, ANTIHALL_DEVSWARM_APP_DB: 'off' }, backend: BACKEND };
    const r = cli.run(['archive', ID_A], ctx);
    assert.strictEqual(r.result.ok, true, 'the LOCAL archive still succeeds even if the app-side call fails: ' + JSON.stringify(r.result));
    assert.strictEqual(r.result.appArchive.ok, false, JSON.stringify(r.result));
    const calls = readCalls(fake.callsFile).filter((c) => c.argv[0] === 'workspace' && c.argv[1] === 'archive' && c.argv[2] !== '--help');
    assert.strictEqual(calls.length, 1, 'a non-retryable failure must not be retried: ' + JSON.stringify(calls));
    assert.match(r.result.manualStep, /app archive attempted and failed/);
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// LIVE-CHILD WARNING — app-DB cross-check.
// ---------------------------------------------------------------------------

test('LIVE-CHILD WARNING: fresh heartbeat + NO app-DB builder row for this id -> warning suppressed (already deleted in the app)', () => {
  const home = tmpHome();
  const W = makeGitRepo('gonewarn');
  const app = buildAppDb({});
  try {
    seedOne(home, W, ID_A);
    livenessLib.writeHeartbeat ? livenessLib.writeHeartbeat(ID_A, home, {}) : null;
    // Write the heartbeat file directly at the path liveness.js reads, since
    // writeHeartbeat may not be exported — mirrors cmdHeartbeat's own file.
    const hbPath = path.join(home, '.anti-hall', 'devswarm', 'heartbeats', ID_A + '.json');
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: Date.now() }));
    capsLib.resetCache();
    const ctx = {
      home, cwd: W, backend: BACKEND,
      env: Object.assign({ HOME: home, PATH: path.join(home, 'empty-bin-warn') }, app.env),
    };
    fs.mkdirSync(ctx.env.PATH, { recursive: true });
    const r = cli.run(['archive', ID_A], ctx);
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.warning, undefined,
      'ID_A has no builder row in the fixture app DB -> the app already has no record of it; warning must not fire: ' + JSON.stringify(r.result));
  } finally { rm(W); rm(home); rmFixture(app); }
});

test('LIVE-CHILD WARNING: fresh heartbeat + a REAL app-DB builder row for this id -> warning still fires', () => {
  const home = tmpHome();
  const W = makeGitRepo('stillwarn');
  const app = buildAppDb({});
  try {
    // Use the fixture's own 'b-a' id, which DOES have a builder row.
    const id = 'b-a';
    seedOne(home, W, id);
    const hbPath = path.join(home, '.anti-hall', 'devswarm', 'heartbeats', id + '.json');
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: Date.now() }));
    capsLib.resetCache();
    const ctx = {
      home, cwd: W, backend: BACKEND,
      env: Object.assign({ HOME: home, PATH: path.join(home, 'empty-bin-warn2') }, app.env),
    };
    fs.mkdirSync(ctx.env.PATH, { recursive: true });
    const r = cli.run(['archive', id], ctx);
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.match(r.result.warning || '', /child session still live/,
      'the id DOES have a builder row in the app DB -> the heartbeat is trusted; warning must still fire: ' + JSON.stringify(r.result));
  } finally { rm(W); rm(home); rmFixture(app); }
});

test('LIVE-CHILD WARNING: app DB unavailable -> fail-open, warning still fires (unchanged pre-fix behavior)', () => {
  const home = tmpHome();
  const W = makeGitRepo('nodbwarn');
  try {
    seedOne(home, W, ID_A);
    const hbPath = path.join(home, '.anti-hall', 'devswarm', 'heartbeats', ID_A + '.json');
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: Date.now() }));
    capsLib.resetCache();
    const ctx = { home, cwd: W, backend: BACKEND, env: { HOME: home, PATH: path.join(home, 'empty-bin-nodb'), ANTIHALL_DEVSWARM_APP_DB: 'off' } };
    fs.mkdirSync(ctx.env.PATH, { recursive: true });
    const r = cli.run(['archive', ID_A], ctx);
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.match(r.result.warning || '', /child session still live/,
      'no app DB at all -> fail-open toward warning: ' + JSON.stringify(r.result));
  } finally { rm(W); rm(home); }
});

'use strict';
// Regression test for defect 77d5a5bbf614 (P2): roster/diagnose/healthcheck
// fail open on an unreadable registry.
//
// Root cause: computeDiagnosis (scripts/devswarm.js) called s.listRegistry()
// directly with no getReadError() probe, and cmdRoster called
// store.computeSummary (which internally calls listRegistry()) with no probe
// either. devswarm-store.js's readAll() swallows any non-ENOENT fs error
// (EACCES on a chmod-000 store dir included) to an empty array — the
// documented fail-open contract for internal callers — so a genuinely
// unreadable registry.ndjson read back as "0 registry rows" through
// listRegistry()/computeSummary(). roster reported an empty-but-healthy-
// looking roster, diagnose reported degraded:false, and healthcheck reported
// ok:true/status:'ok' for an outage it never saw.
//
// Fix under test: computeDiagnosis and cmdRoster each probe
// `s.getReadError()` right after their own listRegistry()-triggering read
// (the same "probe right after read" idiom used by the count/read/ack/
// messages/read-primary/peek-primary read verbs elsewhere in this file — see
// devswarm-fleet-1932b53a3ace.test.js). All three commands now surface
// `known:false`, `storeUnavailable:true`, `storeUnavailableReason:<code>`
// instead of reporting a clean empty/ok result.

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

const cliPath = path.join(ROOT, 'scripts', 'devswarm.js');
if (!fs.existsSync(cliPath)) {
  throw new Error('ANTIHALL_TEST_PLUGIN_ROOT=' + JSON.stringify(ROOT) + ' is not a plugins/anti-hall-shaped tree — expected to find ' + cliPath);
}
const cli = require(cliPath);
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-77d5a5bbf614-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-77d5a5bbf614-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

const isWindows = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const canChmodTest = !isWindows && !isRoot;
function chmodChecked(p, mode) {
  try { fs.chmodSync(p, mode); return true; } catch (_) { return false; }
}

if (!canChmodTest) {
  // Platform cannot make a directory genuinely unreadable to this process
  // (root bypasses permission bits; Windows chmod does not map the same
  // way) — skip with a reason rather than silently passing a vacuous test.
  test('B1: roster/diagnose/healthcheck storeUnavailable on unreadable registry (SKIPPED: cannot chmod-000 as this user)', { skip: true }, () => {});
} else {
  test('77d5a5bbf614: roster/diagnose/healthcheck report known:false/storeUnavailable:true/storeUnavailableReason against a chmod-000 registry store', () => {
    const home = tmpHome();
    const repo = makeGitRepo('registry-unreadable');
    let storeDir = null;
    try {
      const inboxPath = path.join(home, 'ok-inbox.ndjson');
      const cursorPath = path.join(home, 'ok-cursor.txt');
      fs.writeFileSync(inboxPath, '');
      const reg = cli.run(['register', 'ok-id', '--worktree', repo, '--session', 's-ok', '--inbox', inboxPath, '--cursor', cursorPath], ctx(home, { cwd: repo })).result;
      assert.equal(reg.ok, true, 'register failed: ' + JSON.stringify(reg));

      const repoKey = repokey.repoKeyForWorktree(repo);
      storeDir = storeLib.storeDirForHash(home, repoKey);
      assert.ok(fs.existsSync(storeDir), 'the store dir must exist before this test locks it down');
      assert.ok(chmodChecked(storeDir, 0o000), 'chmod 000 must succeed as a non-root, non-Windows test user');

      const roster = cli.run(['roster'], ctx(home, { cwd: repo })).result;
      assert.equal(roster.ok, true, 'roster must still return ok:true (a report, not a hard failure): ' + JSON.stringify(roster));
      assert.equal(roster.known, false, 'roster must report known:false on an unreadable registry, got ' + JSON.stringify(roster));
      assert.equal(roster.storeUnavailable, true, 'roster must report storeUnavailable:true, got ' + JSON.stringify(roster));
      assert.equal(typeof roster.storeUnavailableReason, 'string', 'roster storeUnavailableReason must be a string, got ' + JSON.stringify(roster.storeUnavailableReason));
      assert.equal(roster.storeUnavailableScope, 'registry', 'a whole-store-dir chmod-000 must attribute to the registry, got ' + JSON.stringify(roster));
      assert.equal(roster.count, 0, 'roster count reads 0 (the fail-open registry read) — the point of this fix is the honest known:false alongside it, not a non-zero count');

      const diagnose = cli.run(['diagnose'], ctx(home, { cwd: repo })).result;
      assert.equal(diagnose.known, false, 'diagnose must report known:false on an unreadable registry, got ' + JSON.stringify(diagnose));
      assert.equal(diagnose.storeUnavailable, true, 'diagnose must report storeUnavailable:true, got ' + JSON.stringify(diagnose));
      assert.equal(typeof diagnose.storeUnavailableReason, 'string', 'diagnose storeUnavailableReason must be a string');
      assert.equal(diagnose.storeUnavailableScope, 'registry', 'a whole-store-dir chmod-000 must attribute to the registry, got ' + JSON.stringify(diagnose));
      assert.equal(diagnose.degraded, true, 'diagnose must report degraded:true — an unreadable registry is never a clean/healthy report');
      assert.ok(diagnose.warning && /registry unreadable/.test(diagnose.warning), 'diagnose warning must call out the unreadable registry by name, got ' + JSON.stringify(diagnose.warning));

      const health = cli.run(['healthcheck'], ctx(home, { cwd: repo })).result;
      assert.equal(health.known, false, 'healthcheck must report known:false on an unreadable registry, got ' + JSON.stringify(health));
      assert.equal(health.storeUnavailable, true, 'healthcheck must report storeUnavailable:true, got ' + JSON.stringify(health));
      assert.equal(typeof health.storeUnavailableReason, 'string', 'healthcheck storeUnavailableReason must be a string');
      assert.equal(health.storeUnavailableScope, 'registry', 'a whole-store-dir chmod-000 must attribute to the registry, got ' + JSON.stringify(health));
      assert.equal(health.ok, false, 'healthcheck must NOT report ok:true for a registry it could not read (pre-fix: ok:true/status:"ok")');
      assert.equal(health.status, 'store-unavailable', 'healthcheck status must name the outage, not "ok"');
    } finally {
      if (storeDir) chmodChecked(storeDir, 0o755);
      rm(home); rm(repo);
    }
  });

  test('R2 Critic P2-9: an unreadable messages.ndjson (registry.ndjson itself readable) attributes storeUnavailableScope to "store", never "registry"', () => {
    const home = tmpHome();
    const repo = makeGitRepo('messages-unreadable-registry-fine');
    let messagesFile = null;
    try {
      const inboxPath = path.join(home, 'ok2-inbox.ndjson');
      const cursorPath = path.join(home, 'ok2-cursor.txt');
      fs.writeFileSync(inboxPath, '');
      const reg = cli.run(['register', 'ok2-id', '--worktree', repo, '--session', 's-ok2', '--inbox', inboxPath, '--cursor', cursorPath], ctx(home, { cwd: repo })).result;
      assert.equal(reg.ok, true, 'register failed: ' + JSON.stringify(reg));

      const repoKey = repokey.repoKeyForWorktree(repo);
      const journalDir = storeLib.journalDirForHash(home, repoKey);
      messagesFile = path.join(journalDir, 'messages.ndjson');
      // messages.ndjson is append-only and created lazily on the FIRST message
      // write — a bare `register` never writes one. Seed it empty so there is
      // a file to lock down (mirrors a real store that has registered a
      // workspace but not yet exchanged any mesh messages).
      if (!fs.existsSync(messagesFile)) fs.writeFileSync(messagesFile, '');
      assert.ok(chmodChecked(messagesFile, 0o000), 'chmod 000 on messages.ndjson alone must succeed as a non-root, non-Windows test user');

      const diagnose = cli.run(['diagnose'], ctx(home, { cwd: repo })).result;
      assert.equal(diagnose.storeUnavailable, true, 'an unreadable messages.ndjson must still report storeUnavailable:true, got ' + JSON.stringify(diagnose));
      assert.equal(diagnose.storeUnavailableScope, 'store', 'messages.ndjson (not registry.ndjson) breaking must attribute scope:"store", never "registry" — got ' + JSON.stringify(diagnose));
      assert.ok(diagnose.warning && /^store unreadable/.test(diagnose.warning), 'the warning text must say "store unreadable", not "registry unreadable", got ' + JSON.stringify(diagnose.warning));

      const health = cli.run(['healthcheck'], ctx(home, { cwd: repo })).result;
      assert.equal(health.storeUnavailableScope, 'store', 'healthcheck must also attribute scope:"store", got ' + JSON.stringify(health));

      const roster = cli.run(['roster'], ctx(home, { cwd: repo })).result;
      assert.equal(roster.storeUnavailable, true, 'roster must still report storeUnavailable:true on a broken messages.ndjson, got ' + JSON.stringify(roster));
      assert.equal(roster.storeUnavailableScope, 'store', 'roster must also attribute scope:"store", got ' + JSON.stringify(roster));
    } finally {
      if (messagesFile) chmodChecked(messagesFile, 0o644);
      rm(home); rm(repo);
    }
  });
}

// R2 Reviewer P2: emitKnownWarning must cover roster/diagnose (known:false on
// storeUnavailable), not just the inbox read verbs, so a plain-CLI caller
// (no --json) sees a stderr signal instead of a silently-untrustworthy
// report. Exercised directly against synthetic results (same idiom used by
// devswarm-fleet-1932b53a3ace.test.js's own emitKnownWarning assertions) —
// no fixture/store needed, this is testing the warning-emission function in
// isolation, not the read path that populates `known`/`storeUnavailable`
// (already covered above).
test('R2 Reviewer P2: emitKnownWarning covers roster and diagnose', () => {
  const rosterResult = { ok: true, action: 'roster', known: false, storeUnavailable: true, storeUnavailableReason: 'EACCES', storeUnavailableScope: 'registry' };
  const rosterLine = cli.emitKnownWarning(['roster'], rosterResult);
  assert.equal(typeof rosterLine, 'string', 'roster known:false must emit a WARNING line');
  assert.match(rosterLine, /^\[devswarm\] WARNING: roster reported known:false/);
  assert.match(rosterLine, /EACCES/);

  const diagnoseResult = { ok: true, action: 'diagnose', known: false, storeUnavailable: true, storeUnavailableReason: 'ENOTDIR', storeUnavailableScope: 'store' };
  const diagnoseLine = cli.emitKnownWarning(['diagnose'], diagnoseResult);
  assert.equal(typeof diagnoseLine, 'string', 'diagnose known:false must emit a WARNING line');
  assert.match(diagnoseLine, /^\[devswarm\] WARNING: diagnose reported known:false/);
  assert.match(diagnoseLine, /ENOTDIR/);

  // known:true (the healthy case) must never emit a line for either verb.
  assert.equal(cli.emitKnownWarning(['roster'], { ok: true, known: true }), null);
  assert.equal(cli.emitKnownWarning(['diagnose'], { ok: true, known: true }), null);

  // healthcheck is deliberately NOT added — it already has its own always-
  // visible ok:false/status:'store-unavailable' signal.
  assert.equal(
    cli.emitKnownWarning(['healthcheck'], { ok: false, known: false, storeUnavailable: true, storeUnavailableReason: 'EACCES' }),
    null,
    'healthcheck must not gain a second, duplicate stderr warning'
  );
});

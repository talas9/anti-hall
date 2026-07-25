'use strict';
// v0.65.0 coverage gap (from v0.64.0's logger-foundation): devswarm.js wires
// logVerbOutcome() into the run() dispatch so a FAILED verb (send/reconcile/
// register/ensure/inbox pull|messages|read-primary) logs a structured entry to
// the central JSONL log (companion/lib/anti-hall-log.js) — but v0.64.0 shipped
// with nothing asserting that end-to-end: every existing test either calls
// alog.logError/logEvent directly (devswarm-v064.test.js's own `logs` test) or
// exercises a verb that SUCCEEDS. This suite drives a genuinely-FAILING verb
// through the real `run()` CLI dispatch path, then reads it back via
// devswarm.js's own `logs` verb (cmdLogs) — proving the wiring, not just the
// logger primitive or the verb's own failure.
//
// NON-VACUOUS: the core assertion below only passes if logVerbOutcome() is
// still wired into the 'send' case of run() AND alog.logError still appends a
// readable entry — commenting out either wire would fail this test (see the
// "wiring removed" sanity note on the main test).
//
// HERMETIC: isolated tmp HOME (never real ~/.anti-hall/devswarm), an isolated
// ANTI_HALL_LOG_DIR (anti-hall-log.js reads process.env LIVE, not ctx.env — see
// its own logDir() — so this suite points process.env.ANTI_HALL_LOG_DIR at a
// throwaway dir and restores it after every test, mirroring doctor-logs.test.js
// and devswarm-v064.test.js's own seeding convention), a forced 'journal'
// backend (deterministic across node 18/20/22/24 — no node:sqlite dependency),
// ctx.env = {} (no ambient DEVSWARM_* leaking in), and a REAL git-init'd temp
// repo for cwd (repoKey/callerIdentity derivation needs a real worktree).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEVSWARM_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'scripts', 'devswarm.js');
const LOG_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'anti-hall-log.js');

const cli = require(DEVSWARM_JS);
const repokey = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-repokey.js'));

function mkTmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-logger-e2e-' + tag + '-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = mkTmp('repo-' + tag);
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return fs.realpathSync(dir);
}
// withLogDir(dir, fn) — points process.env.ANTI_HALL_LOG_DIR at `dir` for the
// duration of fn() and restores the prior value afterward (anti-hall-log.js's
// logDir() reads this env var live at call time, never cached — see
// doctor-logs.test.js's identical seedLog() pattern).
function withLogDir(dir, fn) {
  const prior = process.env.ANTI_HALL_LOG_DIR;
  process.env.ANTI_HALL_LOG_DIR = dir;
  try { return fn(); } finally {
    if (prior === undefined) delete process.env.ANTI_HALL_LOG_DIR;
    else process.env.ANTI_HALL_LOG_DIR = prior;
  }
}
function ctx(home, cwd, over) {
  return Object.assign({ home, cwd, backend: 'journal', env: {} }, over || {});
}

test('send to an unregistered recipient FAILS through run() AND logVerbOutcome writes a readable entry, retrievable via `devswarm.js logs` itself', () => {
  const home = mkTmp('home');
  const repo = makeGitRepo('send');
  const logDir = mkTmp('logdir');
  try {
    withLogDir(logDir, () => {
      // 1. Drive a genuinely-failing verb through the REAL CLI dispatch (run()),
      // not a hand-built result object. No registry entries exist for
      // 'nobody-registered' in this fresh store, so cmdSend's fail-closed
      // addressing (D12a) rejects it deterministically — no daemon, no mock.
      const sent = cli.run(
        ['send', '--to', 'nobody-registered', '--message', 'hello from the e2e test'],
        ctx(home, repo),
      );
      assert.strictEqual(sent.code, 2, 'a send to an unregistered recipient must fail (exit 2): ' + JSON.stringify(sent));
      assert.strictEqual(sent.result.ok, false, JSON.stringify(sent.result));
      assert.strictEqual(sent.result.reason, 'unregistered-recipient', JSON.stringify(sent.result));

      // 2. Read the failure back via devswarm.js's OWN `logs` verb (cmdLogs),
      // not a direct alog.readRecent() call — proving the full
      // run()->logVerbOutcome->alog.logError->cmdLogs round trip.
      const logs = cli.run(['logs', '--component', 'devswarm-cli', '--min-level', 'error'], ctx(home, repo));
      assert.strictEqual(logs.result.ok, true, JSON.stringify(logs.result));

      const repoKey = repokey.repoKeyForWorktree(repo);
      const entry = logs.result.entries.find((e) => e && e.op === 'send' && e.meshId === 'nobody-registered');
      assert.ok(entry, 'logVerbOutcome must have logged the failed send verb — none found among: ' + JSON.stringify(logs.result.entries));
      assert.strictEqual(entry.component, 'devswarm-cli', JSON.stringify(entry));
      assert.strictEqual(entry.level, 'error', JSON.stringify(entry));
      assert.strictEqual(entry.repoKey, repoKey, 'the logged repoKey must match this worktree\'s own repoKey: ' + JSON.stringify(entry));
      assert.match(String(entry.msg || (entry.err && entry.err.message)), /not a registered mesh workspace/, JSON.stringify(entry));

      // Sanity: exactly ONE matching entry landed from this single failed call
      // (not zero — which is what commenting out the logVerbOutcome() call in
      // run()'s 'send' case would produce — and not spurious duplicates).
      const matches = logs.result.entries.filter((e) => e && e.op === 'send' && e.meshId === 'nobody-registered');
      assert.strictEqual(matches.length, 1, JSON.stringify(matches));
    });
  } finally { rm(home); rm(repo); rm(logDir); }
});

test('a SUCCESSFUL send logs NOTHING (logVerbOutcome only fires on failure, proving the assertion above is specific, not a general log-everything artifact)', () => {
  const home = mkTmp('home-ok');
  const repo = makeGitRepo('send-ok');
  const logDir = mkTmp('logdir-ok');
  try {
    withLogDir(logDir, () => {
      // Register a real recipient in the SAME project store the send below will
      // address (mesh send/register both key off the CALLER's cwd repoKey, not
      // the --worktree flag value — see repoKeyForCwd/upsertStoreRegistry) —
      // 'recipient-1' is a distinct meshId from the caller's own derived
      // identity, so this is a genuine cross-workspace address, not a self-send.
      const reg = cli.run(['register', 'recipient-1', '--worktree', repo, '--session', 'sess-1'], ctx(home, repo));
      assert.strictEqual(reg.result.ok, true, JSON.stringify(reg.result));

      const sent = cli.run(
        ['send', '--to', 'recipient-1', '--message', 'a message that should succeed'],
        ctx(home, repo),
      );
      assert.strictEqual(sent.result.ok, true, 'send to a registered recipient must succeed: ' + JSON.stringify(sent.result));

      const logs = cli.run(['logs'], ctx(home, repo));
      assert.strictEqual(logs.result.ok, true);
      const matches = logs.result.entries.filter((e) => e && e.op === 'send');
      assert.strictEqual(matches.length, 0, 'a successful send must never write a devswarm-cli/send log entry: ' + JSON.stringify(matches));
    });
  } finally { rm(home); rm(repo); rm(logDir); }
});

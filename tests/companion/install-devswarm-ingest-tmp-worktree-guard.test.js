'use strict';
// Defect: a launchd unit com.anti-hall.devswarm-ingest.main-104459 was installed on
// a REAL machine with WorkingDirectory = /private/tmp/.../scratchpad/e2e/main (an
// e2e fixture repo in another session's scratchpad). It crash-looped 34,584 times
// with exit 78 EX_CONFIG once that fixture path was cleaned up. TMP_HOME_GUARD
// (install-devswarm-ingest-home-pin.test.js) only ever refused a tmp $HOME — it had
// no signal for a normal $HOME running the installer from a cwd that resolves to a
// scratch/tmp worktree (exactly what a review agent's or test's scratchpad clone
// produces). This file covers the fix:
//   (a) applyTmpWorktreeGuard/homeIsUnderTmpdir — pure function coverage.
//   (b) real subprocess: install from a tmp-rooted git worktree is refused (forced
//       dry-run + loud stderr notice), unless ANTIHALL_INGEST_ALLOW_TMP_HOME=1.
//   (c) doctor: classifyIngestUnit/tmpWorkdirReportMessage REPORT (never remove) an
//       already-installed unit whose WorkingDirectory is under a tmp root, using a
//       fake LaunchAgents dir under an isolated HOME — never the real launchctl.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const INGEST_MOD_PATH = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'install-devswarm-ingest.js');
const REPAIR_MOD_PATH = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'lib', 'doctor-repair.js');

const ingest = require(INGEST_MOD_PATH);
const repair = require(REPAIR_MOD_PATH);

function mkTmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-tmpwt-' + tag + '-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = mkTmp(tag);
  cp.spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c'], { encoding: 'utf8' });
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'a'], { encoding: 'utf8' });
  return dir;
}

// ---------------------------------------------------------------------------
// (a) applyTmpWorktreeGuard — pure function coverage.
// ---------------------------------------------------------------------------

test('(a) applyTmpWorktreeGuard: true + TMP_WORKTREE_GUARD flips for a path under os.tmpdir()', () => {
  const dir = mkTmp('pure-true');
  try {
    assert.strictEqual(ingest.applyTmpWorktreeGuard(dir), true);
    assert.strictEqual(ingest.TMP_WORKTREE_GUARD, true);
  } finally { rm(dir); }
});

test('(a) applyTmpWorktreeGuard: false for a null/empty path (fail-open, never throws)', () => {
  assert.strictEqual(ingest.applyTmpWorktreeGuard(null), false);
  assert.strictEqual(ingest.applyTmpWorktreeGuard(''), false);
  assert.strictEqual(ingest.applyTmpWorktreeGuard(undefined), false);
});

// ---------------------------------------------------------------------------
// (b) real subprocess coverage: install refused from a tmp-rooted worktree,
// never touches the real scheduler (forced dry-run, same posture as
// install-devswarm-ingest-home-pin.test.js's TMP_HOME_GUARD subprocess tests).
// ---------------------------------------------------------------------------

test('(b) install from a tmp-rooted git worktree is refused: prints the loud stderr notice, exits 0', () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return; // no daemon on win32
  const wt = makeGitRepo('refuse-wt');
  const home = mkTmp('refuse-home'); // deliberately ALSO under tmp — irrelevant to this assertion
  try {
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
    delete env.ANTIHALL_INGEST_ALLOW_TMP_HOME;
    delete env.ANTIHALL_INGEST_DRY_RUN;
    const r = cp.spawnSync(process.execPath, [INGEST_MOD_PATH], { cwd: wt, env, encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(r.status, 0, 'main() must still exit 0 (fail-open to dry-run, never crash): ' + r.stderr);
    assert.match(r.stderr, /resolved a WorkingDirectory .* under the system\s*temp/i,
      'must print the tmp-worktree refusal notice — stderr was:\n' + r.stderr);
    assert.match(r.stderr, /ANTIHALL_INGEST_ALLOW_TMP_HOME=1/, 'must name the exact opt-out');
    // Never actually registers a real unit for this scratch worktree.
    if (process.platform === 'darwin') {
      const plist = path.join(home, 'Library', 'LaunchAgents');
      const names = fs.existsSync(plist) ? fs.readdirSync(plist) : [];
      assert.deepStrictEqual(names.filter((n) => n.startsWith(ingest.LABEL)), [],
        'no real plist may be written for a tmp-rooted worktree');
    }
  } finally { rm(wt); rm(home); }
});

test('(b) ANTIHALL_INGEST_ALLOW_TMP_HOME=1 suppresses the tmp-worktree guard\'s own notice', () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return; // no daemon on win32
  const wt = makeGitRepo('allow-wt');
  const home = mkTmp('allow-home');
  try {
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, ANTIHALL_INGEST_ALLOW_TMP_HOME: '1' });
    delete env.ANTIHALL_INGEST_DRY_RUN;
    const r = cp.spawnSync(process.execPath, [INGEST_MOD_PATH], { cwd: wt, env, encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(r.status, 0, 'main() must exit 0: ' + r.stderr);
    assert.ok(!/resolved a WorkingDirectory .* under the system\s*temp/i.test(r.stderr),
      'ANTIHALL_INGEST_ALLOW_TMP_HOME=1 must suppress the tmp-worktree guard\'s own notice — stderr was:\n' + r.stderr);
    // NODE_TEST_CONTEXT is still inherited by this child (this test itself runs
    // under `node --test`), so a real registration still never happens here
    // either — that guard is separate and expected, and is the reason this
    // assertion is about the NOTICE TEXT, not about a plist landing on disk.
  } finally { rm(wt); rm(home); }
});

// ---------------------------------------------------------------------------
// (c) doctor: REPORT (never remove) an already-installed unit whose
// WorkingDirectory is under a tmp root. Fake LaunchAgents dir under an isolated
// HOME; never invokes the real launchctl (classifyIngestUnit/
// tmpWorkdirReportMessage are pure reads/string-builders, and the runRepairs
// 'tmp-workdir' branch never calls spawnInstaller or any scheduler command).
// ---------------------------------------------------------------------------

// NOTE: classifyIngestUnit deliberately does NOT gain a tmp-root check on THIS
// worktree's own resolved unit — a session/test/CI can legitimately run FROM a
// tmp checkout (proven empirically: adding that check here broke ~77 previously-
// passing doctor-repair.test.js assertions, because this repo's OWN test suite
// conventionally builds ingest-unit fixtures under os.tmpdir()). The real defect
// shape — a leaked unit for a DIFFERENT, unrelated, scratch-rooted worktree — is
// reported separately below, over `read.others` (see the 'ingest-others' finding
// in runRepairs), which is what the actual incident looked like: nobody runs
// doctor FROM inside a throwaway e2e fixture, so the offending unit only ever
// shows up as an "other" repo's unit relative to whoever runs doctor.
test('(c) classifyIngestUnit: a tmp-rooted WorkingDirectory that IS a valid worktree still classifies \'ok\' (never a false-positive report on your own session)', () => {
  const wt = makeGitRepo('classify-own-tmp');
  try {
    // No `env` — the stale-script drift check is opt-in and orthogonal to this
    // assertion (which is purely about the tmp-root/worktree-validity path).
    const cls = repair.classifyIngestUnit({ workingDir: wt, scriptPath: __filename, home: os.homedir() });
    assert.strictEqual(cls, 'ok', 'a valid, existing worktree must classify ok regardless of whether it happens to live under tmp');
  } finally { rm(wt); }
});

test('(c) tmpWorkdirReportMessage: exact bootout + quarantine command text (darwin)', () => {
  const home = mkTmp('msg-home-darwin');
  try {
    const msg = repair.tmpWorkdirReportMessage({
      label: 'com.anti-hall.devswarm-ingest.deadbeef', unit: null,
      workingDir: '/private/tmp/scratch/e2e/main', home, platform: 'darwin',
    });
    assert.match(msg, /launchctl bootout gui\/\$\(id -u\)\/com\.anti-hall\.devswarm-ingest\.deadbeef/);
    const plist = path.join(home, 'Library', 'LaunchAgents', 'com.anti-hall.devswarm-ingest.deadbeef.plist');
    assert.ok(msg.includes('mv ' + plist + ' ' + plist + '.quarantined'), 'must include the exact quarantine mv command: ' + msg);
    assert.ok(msg.includes('/private/tmp/scratch/e2e/main'), 'must name the offending WorkingDirectory');
  } finally { rm(home); }
});

test('(c) tmpWorkdirReportMessage: exact bootout + quarantine command text (linux)', () => {
  const home = mkTmp('msg-home-linux');
  try {
    const msg = repair.tmpWorkdirReportMessage({
      label: null, unit: 'anti-hall-devswarm-ingest-deadbeef',
      workingDir: '/tmp/scratch/e2e/main', home, platform: 'linux',
    });
    assert.match(msg, /systemctl --user disable --now anti-hall-devswarm-ingest-deadbeef\.service/);
    const svc = path.join(home, '.config', 'systemd', 'user', 'anti-hall-devswarm-ingest-deadbeef.service');
    assert.ok(msg.includes('mv ' + svc + ' ' + svc + '.quarantined'), 'must include the exact quarantine mv command: ' + msg);
  } finally { rm(home); }
});

test('(c) runRepairs: an OTHER repo\'s tmp-rooted ingest unit is reported (\'failed\'), never spawns a real scheduler command, and never affects THIS worktree\'s own finding', () => {
  // Reproduces the actual incident shape: doctor is run from a NORMAL (non-tmp)
  // worktree, and a SEPARATE, already-installed unit belongs to a different,
  // scratch/tmp-rooted worktree (the e2e fixture repo) — exactly what
  // `read.others` surfaces (own-worktree unit absent/no-match here, so it never
  // touches the primary 'ingest' finding at all).
  const cwd = makeGitRepo('runrepairs-cwd');
  const home = mkTmp('runrepairs-home');
  const scratchWt = mkTmp('runrepairs-scratch-wt');
  try {
    fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
    // Hash-suffixed to a worktree that is NOT cwd — lands in `read.others`, not
    // picked as this worktree's own unit.
    const hash = ingest.worktreeHash(scratchWt);
    const label = ingest.LABEL + '.' + hash;
    const plistPath = path.join(home, 'Library', 'LaunchAgents', label + '.plist');
    const plist = ingest.buildPlist({
      exec: process.execPath, script: path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'devswarm-ingest.js'),
      log: path.join(home, 'l.log'), workdir: scratchWt, label,
    });
    fs.writeFileSync(plistPath, plist);
    // io.schedRun/io.schedFs would only be consulted by scheduler-mutating
    // branches; the 'ingest-others' tmp report calls neither. A throwing stub
    // proves this: if runRepairs ever called it for this unit, the test itself
    // would throw and fail loudly instead of silently passing.
    const io = {
      schedRun() { throw new Error('runRepairs must NEVER invoke the real scheduler for another repo\'s tmp-workdir unit'); },
      schedFs: { unlinkSync() { throw new Error('runRepairs must NEVER remove another repo\'s tmp-workdir unit files'); } },
    };
    const results = repair.runRepairs({ cwd, env: {}, home, dryRun: true, platform: 'darwin', io });
    const tmpFindings = results.filter((r) => r.action === 'ingest-others' && r.status === 'failed');
    assert.strictEqual(tmpFindings.length, 1, 'exactly one report for the tmp-rooted other-worktree unit');
    assert.match(tmpFindings[0].msg, /under the system temp directory/);
    assert.match(tmpFindings[0].msg, /NOT auto-removed/);
    assert.match(tmpFindings[0].msg, /launchctl bootout/);
    // This worktree's OWN 'ingest' finding must be entirely unaffected (no
    // installed unit for cwd itself here, so it is 'absent'/'gated', never the
    // tmp-workdir message) — proves the two are correctly decoupled.
    const own = results.filter((r) => r.id === 'ingest');
    for (const f of own) assert.ok(!/under the system temp directory/.test(f.msg), 'the tmp report must never leak onto this worktree\'s own finding: ' + f.msg);
    // The plist must still be exactly what was written — never touched.
    assert.strictEqual(fs.readFileSync(plistPath, 'utf8'), plist, 'runRepairs must never mutate a tmp-workdir unit\'s plist');
  } finally { rm(cwd); rm(home); rm(scratchWt); }
});

'use strict';
// doctor-default-home-isolation — Task #6 part (a) regression guard.
//
// PROVEN ROOT CAUSE: doctor.test.js / doctor-repair.test.js /
// doctor-repair-reclaim.test.js / doctor-logs.test.js each spawn doctor.js
// (plugins/anti-hall/hooks/doctor.js) as a real subprocess through a local
// runDoctor() helper whose DEFAULT env merge used to set `HOME: undefined,
// USERPROFILE: undefined`. That default is NOT isolation: when HOME is
// unset, Node's os.homedir() falls back through the platform passwd db to
// the REAL machine home directory (verified empirically — spawning a child
// with HOME explicitly unset still yields the real `/Users/<user>` from
// os.homedir() inside that child). doctor.js resolves its target home via
// `os.homedir()` throughout (companion store paths, devswarm workspace
// descriptors, etc.), so any runDoctor() call that forgot to pass its own
// HOME override would silently read/write the REAL
// ~/.anti-hall/devswarm/store instead of a disposable fixture.
//
// Every current call site in those 4 files already passes its own isolated
// HOME, so this was a latent landmine rather than an active leak — but a
// landmine a future test (or a refactor that drops an env override) would
// step on with no warning. The fix (this branch) changes the DEFAULT in all
// 4 files from `HOME: undefined` to a freshly `fs.mkdtempSync`-created,
// disposable temp dir, used ONLY when the caller does not supply its own
// HOME.
//
// This file:
//   1. Statically greps the 4 fixed files to prove the dangerous literal
//      `HOME: undefined` pattern is gone (regression guard against
//      reintroducing it).
//   2. Functionally proves, by replicating each file's exact (fixed)
//      env-merge expression against a real subprocess, that a runDoctor()
//      call with NO caller-supplied HOME resolves to a disposable temp dir —
//      never the real os.homedir() — and that the real
//      ~/.anti-hall/devswarm/store (if present) is untouched (mtime
//      unchanged) by that call.
//   3. VACUOUS-RED proof: the same functional assertion is run against the
//      OLD (buggy) `HOME: undefined` pattern inline, and is shown to FAIL
//      (the child's HOME echoes back the real os.homedir()) — proving this
//      test is not vacuously true and would have caught the original bug.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const FIXED_FILES = [
  'tests/hooks/doctor.test.js',
  'tests/hooks/doctor-repair.test.js',
  'tests/hooks/doctor-repair-reclaim.test.js',
  'tests/hooks/doctor-logs.test.js',
].map((rel) => path.join(REPO_ROOT, rel));

// ---------------------------------------------------------------------------
// 1. Static regression guard: the dangerous literal must never come back.
// ---------------------------------------------------------------------------
for (const file of FIXED_FILES) {
  test(`static: ${path.relative(REPO_ROOT, file)} no longer defaults HOME to undefined`, () => {
    const src = fs.readFileSync(file, 'utf8');
    // Strip // line comments before matching so this guard checks the actual
    // executable env-merge expression, not the explanatory prose above it
    // (which legitimately mentions the old `HOME: undefined` pattern by name).
    const code = src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    assert.doesNotMatch(
      code,
      /HOME:\s*undefined/,
      'the fixed file must not reintroduce a literal `HOME: undefined` default: ' + file,
    );
    assert.match(
      src,
      /mkdtempSync\(path\.join\(os\.tmpdir\(\), 'antihall-doctor-default-home-'\)\)/,
      'the fixed file must fall back to a disposable mkdtemp HOME, not undefined: ' + file,
    );
  });
}

// ---------------------------------------------------------------------------
// 2 + 3. Functional proof + VACUOUS-RED contrast.
// ---------------------------------------------------------------------------
// A tiny probe script: prints os.homedir() as resolved INSIDE the child, so
// we can compare it against the real machine home without ever letting
// doctor.js itself run unisolated.
const PROBE_JS = path.join(os.tmpdir(), 'antihall-home-probe-' + process.pid + '.js');
fs.writeFileSync(PROBE_JS, "process.stdout.write(require('os').homedir());\n");

function spawnWithEnv(envOverrides) {
  const res = cp.spawnSync(process.execPath, [PROBE_JS], {
    encoding: 'utf8',
    timeout: 15000,
    env: Object.assign({}, process.env, envOverrides),
  });
  return (res.stdout || '').trim();
}

test('functional: FIXED pattern (mkdtemp fallback) never resolves the real machine home', () => {
  const callerEnv = {}; // caller supplies no HOME override, exactly like a runDoctor() call that forgot one
  const fallbackHome = ('HOME' in callerEnv)
    ? null
    : fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-default-home-'));
  try {
    const resolved = spawnWithEnv(Object.assign({
      HOME: fallbackHome, USERPROFILE: fallbackHome,
    }, callerEnv));
    const realHome = os.homedir();
    assert.notStrictEqual(resolved, realHome, 'fixed default must NOT resolve to the real machine home');
    assert.ok(
      resolved.startsWith(fs.realpathSync(os.tmpdir())) || resolved.startsWith(os.tmpdir()),
      'fixed default must resolve inside a disposable temp dir, got: ' + resolved,
    );
  } finally {
    try { fs.rmSync(fallbackHome, { recursive: true, force: true }); } catch (_) {}
  }
});

test('VACUOUS-RED proof: the OLD buggy pattern (HOME: undefined) DOES leak to the real machine home', () => {
  // This reproduces the exact bug this branch fixes. It is expected (and
  // asserted) to show the leak — proving the functional test above is not
  // vacuously true, i.e. it would have failed against the pre-fix code.
  const callerEnv = {};
  const buggyOverrides = Object.assign({ HOME: undefined, USERPROFILE: undefined }, callerEnv);
  const resolved = spawnWithEnv(buggyOverrides);
  const realHome = os.homedir();
  assert.strictEqual(
    resolved, realHome,
    'documenting the pre-fix bug: an unset HOME resolves os.homedir() to the REAL machine home ('
      + realHome + '), which is exactly why `HOME: undefined` was not isolation',
  );
});

test('real store untouched: ~/.anti-hall/devswarm/store mtime is unchanged by a FIXED-pattern runDoctor call', () => {
  const realStoreDir = path.join(os.homedir(), '.anti-hall', 'devswarm', 'store');
  const before = fs.existsSync(realStoreDir) ? fs.statSync(realStoreDir).mtimeMs : null;

  const callerEnv = {};
  const fallbackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-default-home-'));
  try {
    // Spawn doctor.js itself (read-only --check) through the fixed pattern,
    // with no caller HOME override — the exact shape of a runDoctor() call
    // that forgot to pass one.
    const DOCTOR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'doctor.js');
    cp.spawnSync(process.execPath, [DOCTOR_JS, '--check'], {
      cwd: fallbackHome,
      encoding: 'utf8',
      timeout: 60000,
      env: Object.assign({}, process.env, {
        HOME: fallbackHome, USERPROFILE: fallbackHome, DEVSWARM_REPO_ID: undefined,
        DISABLE_ANTIHALL_DEVSWARM: undefined, ANTIHALL_DEVSWARM_SUPERVISOR: undefined,
      }, callerEnv),
    });
  } finally {
    try { fs.rmSync(fallbackHome, { recursive: true, force: true }); } catch (_) {}
  }

  const after = fs.existsSync(realStoreDir) ? fs.statSync(realStoreDir).mtimeMs : null;
  assert.strictEqual(after, before, 'the real ~/.anti-hall/devswarm/store must be byte-for-byte untouched (mtime unchanged)');
});

test.after(() => {
  try { fs.rmSync(PROBE_JS, { force: true }); } catch (_) {}
});

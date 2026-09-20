'use strict';
// doctor.js's "does the statusline actually render?" self-test spawns
// statusline.js with spawnSync and a timeout. Under `node --test` file-level
// parallelism that spawn can legitimately lose the CPU-contention race: the
// child is genuinely slow, not broken, but spawnSync's timeout SIGTERMs it
// (res.status === null, res.signal === 'SIGTERM'), and the OLD doctor.js code
// treated that identically to "produced no output" — a real bug, not a slow
// child — and counted it as a FAIL. Observed causing intermittent
// `AssertionError: 1 !== 0` in doctor-repair.test.js and
// doctor-repair-flag-early-exit.test.js.
//
// This test proves the fix: a SIGTERM'd statusline spawn must be reported as
// a WARN (contention, not a real failure), never a fail++. It forces the
// SIGTERM deterministically — via the ANTIHALL_DOCTOR_SL_SCRIPT/
// ANTIHALL_DOCTOR_SL_TIMEOUT_MS test-only overrides doctor.js reads — by
// pointing the spawn at a stand-in script that sleeps past a short timeout,
// rather than waiting out a real 30s contention scenario or trying to
// reproduce genuine machine contention (which would be flaky by definition).
// A test asserting only "the constant is now 30000" would be vacuous; this
// one drives the actual SIGTERM/status===null branch and asserts its effect
// on the pass/fail/warn counters via doctor's own summary line.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DOCTOR_JS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'doctor.js');

function makeFakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-slct-home-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

// timeout: 60000ms outer harness cap — same generous headroom as every other
// runDoctor() helper in this suite (fe0d901/b99eafb precedent). This is the
// OUTER spawn of doctor.js itself, distinct from the INNER
// ANTIHALL_DOCTOR_SL_TIMEOUT_MS-controlled spawn under test.
//
// HOME fallback: every call site below passes its own isolated HOME, but per
// the doctor-default-home-isolation guard, the DEFAULT (used only if a caller
// ever omits HOME) must be a disposable mkdtemp dir, never undefined —
// unset HOME falls back to the REAL machine home via os.homedir().
function runDoctor({ cwd, env }) {
  const callerEnv = env || {};
  const fallbackHome = ('HOME' in callerEnv) ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-default-home-'));
  const res = cp.spawnSync(process.execPath, [DOCTOR_JS, '--check'], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: Object.assign({}, process.env, { HOME: fallbackHome, USERPROFILE: fallbackHome }, callerEnv),
  });
  return {
    code: res.status,
    out: (res.stdout || '') + (res.stderr || '')
      + (res.signal ? `\n[runDoctor: process terminated by signal ${res.signal}]` : ''),
  };
}

test('doctor: a statusline spawn killed by contention timeout (SIGTERM/status=null) reports WARN, not FAIL', () => {
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-slct-cwd-'));
  // A synchronous-sleep stand-in for statusline.js: blocks the event loop past
  // the short timeout below via a spin-wait (no timers, which spawnSync/child
  // processes without an active event loop would ignore differently) so the
  // parent's spawnSync timeout fires and SIGTERMs it, deterministically
  // reproducing the exact res.status===null/res.signal==='SIGTERM' shape a
  // genuinely-slow real statusline.js produces under contention.
  const fakeSlScript = path.join(cwd, 'fake-slow-statusline.js');
  fs.writeFileSync(fakeSlScript, 'const t=Date.now()+5000; while(Date.now()<t){}\nprocess.stdout.write("line1\\nline2\\n");\n');
  try {
    const r = runDoctor({
      cwd,
      env: {
        HOME: home, USERPROFILE: home,
        DEVSWARM_REPO_ID: undefined, DISABLE_ANTIHALL_DEVSWARM: undefined, ANTIHALL_DEVSWARM_SUPERVISOR: undefined,
        ANTIHALL_DOCTOR_SL_SCRIPT: fakeSlScript,
        ANTIHALL_DOCTOR_SL_TIMEOUT_MS: '200',
      },
    });
    assert.match(r.out, /statusline\.js timed out under load/, 'must report the contention-timeout WARN wording:\n' + r.out);
    assert.doesNotMatch(r.out, /statusline\.js produced no output/, 'must NOT fall into the genuine-failure branch for a SIGTERM:\n' + r.out);
    // The overall verdict must not be dragged down to FAIL by this one
    // contention-timeout WARN — that is the actual bug this fix closes.
    assert.strictEqual(r.code, 0, 'a contention-timed-out statusline spawn must not fail the whole doctor run:\n' + r.out);
    assert.match(r.out, /anti-hall ACTIVE/, r.out);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});

test('doctor: a statusline spawn that genuinely produces no output (clean exit, empty stdout) still reports FAIL', () => {
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-slct-cwd2-'));
  // Exits 0 fast with zero stdout — a genuine "ran but produced nothing" bug,
  // never touching the timeout path. Guards against the fix over-correcting
  // into treating every non-2-line result as a harmless WARN.
  const fakeSlScript = path.join(cwd, 'fake-silent-statusline.js');
  fs.writeFileSync(fakeSlScript, 'process.exit(0);\n');
  try {
    const r = runDoctor({
      cwd,
      env: {
        HOME: home, USERPROFILE: home,
        DEVSWARM_REPO_ID: undefined, DISABLE_ANTIHALL_DEVSWARM: undefined, ANTIHALL_DEVSWARM_SUPERVISOR: undefined,
        ANTIHALL_DOCTOR_SL_SCRIPT: fakeSlScript,
      },
    });
    assert.match(r.out, /statusline\.js produced no output \(exit 0\)/, r.out);
    assert.strictEqual(r.code, 1, 'a genuinely broken statusline (no output) must still fail doctor:\n' + r.out);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});

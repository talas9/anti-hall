'use strict';
// EARLY EXIT for the three EXPLICIT, OPT-IN repair flags (0.99.2):
// --repair-ingest-orphans, --repair-test-stores, --repair-resurrected.
//
// Before this fix, none of the three ever called process.exit inside their
// own `if (REPAIR_X) { ... }` block, so doctor.js fell through every LATER
// section (6j-6n) and the unconditional tail summary — a field report showed
// --repair-resurrected's own verdict line buried at line 562 of 571 total
// output lines. Each flag's block now ends with emitVerdictAndExit()
// (doctor.js), which prints the SAME verdict the tail always printed, then
// calls process.exit immediately.
//
// PROOF METHOD: seed a fixture that reliably triggers section 6n
// ("superseded archived markers" — checkSupersededArchivedMarkers, pure fs,
// no live-pid dependency, same fixture doctor-repair-superseded-archived-
// marker.test.js already uses) — a section that sits AFTER all three repair
// blocks in doctor.js's file order. Run each flag against that fixture and
// assert the 6n text is ABSENT (execution stopped before reaching it).
// VACUOUS-GUARD: run the SAME fixture through a plain `doctor --check` (no
// early exit at all) and assert the 6n text IS present — proving the
// fixture genuinely reaches and trips that section when nothing stops it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DOCTOR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'doctor.js');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-early-exit-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'archived'), { recursive: true });
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces'), { recursive: true });
  // Trips section 6n (checkSupersededArchivedMarkers): a marker whose
  // sessionId no longer matches the live descriptor's — same shape
  // doctor-repair-superseded-archived-marker.test.js already proves fires.
  fs.writeFileSync(
    path.join(home, '.anti-hall', 'devswarm', 'archived', 'anchor-1.json'),
    JSON.stringify({ id: 'anchor-1', worktreePath: '/repo', sessionId: 'session-old' })
  );
  fs.writeFileSync(
    path.join(home, '.anti-hall', 'devswarm', 'workspaces', 'anchor-1.json'),
    JSON.stringify({ id: 'anchor-1', worktreePath: '/repo', sessionId: 'session-new' })
  );
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

const SECTION_6N_MARKER = 'superseded archived markers';

// Mirrors doctor.test.js's runDoctor() isolation contract exactly (Task #6
// part (a) regression guard, tests/hooks/doctor-default-home-isolation.test.js):
// `HOME: undefined` does NOT isolate — os.homedir() falls back through the
// platform passwd db to the REAL machine home — so every call here passes
// its own `home`, and the default fallback (unused by this file's callers,
// which always pass one) is still a disposable mkdtemp dir, never undefined.
function runDoctor(home, extraArgs) {
  const callerEnv = { HOME: home, USERPROFILE: home };
  const fallbackHome = ('HOME' in callerEnv) ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-default-home-'));
  const res = cp.spawnSync(process.execPath, [DOCTOR_JS].concat(extraArgs || []), {
    encoding: 'utf8',
    timeout: 60000,
    env: Object.assign({}, process.env, {
      HOME: fallbackHome, USERPROFILE: fallbackHome, DEVSWARM_REPO_ID: undefined,
      DISABLE_ANTIHALL_DEVSWARM: undefined, ANTIHALL_DEVSWARM_SUPERVISOR: undefined,
      // EXPLICIT, not inherited: a child that ever wrote (it never should —
      // this file's own repair flags run against an isolated `home` with
      // nothing eligible) must still be pinned to dry-run, never relying on
      // the parent shell happening to have this exported.
      ANTIHALL_INGEST_DRY_RUN: '1',
    }, callerEnv),
  });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

test('VACUOUS-GUARD: plain `doctor --check` against the fixture DOES reach and report section 6n', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = runDoctor(home, ['--check']);
    assert.match(r.out, new RegExp(SECTION_6N_MARKER), 'the fixture must genuinely trip 6n when nothing stops execution — otherwise the early-exit tests below prove nothing');
    assert.match(r.out, /anchor-1/);
  } finally { cleanup(); }
});

test('--repair-ingest-orphans: prints its own section and exits WITHOUT reaching section 6n', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = runDoctor(home, ['--repair-ingest-orphans']);
    assert.match(r.out, /Repair ingest orphans/, 'its own section must still print');
    assert.doesNotMatch(r.out, new RegExp(SECTION_6N_MARKER), 'must exit before reaching a later section');
    assert.match(r.out, /anti-hall (ACTIVE|has \d+ FAILURE)/, 'must still print its own verdict line');
    assert.strictEqual(r.code, 0, 'nothing failed in this fixture, so exit must be 0');
  } finally { cleanup(); }
});

test('--repair-test-stores: prints its own section and exits WITHOUT reaching section 6n', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = runDoctor(home, ['--repair-test-stores']);
    assert.match(r.out, /Repair test stores/, 'its own section must still print');
    assert.doesNotMatch(r.out, new RegExp(SECTION_6N_MARKER), 'must exit before reaching a later section');
    assert.match(r.out, /anti-hall (ACTIVE|has \d+ FAILURE)/, 'must still print its own verdict line');
    assert.strictEqual(r.code, 0);
  } finally { cleanup(); }
});

test('--repair-resurrected: prints its own section and exits WITHOUT reaching section 6n (the field-reported case — verdict was buried at line 562/571)', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = runDoctor(home, ['--repair-resurrected']);
    assert.match(r.out, /Repair resurrected registry rows/, 'its own section must still print');
    assert.doesNotMatch(r.out, new RegExp(SECTION_6N_MARKER), 'must exit before reaching a later section');
    assert.match(r.out, /anti-hall (ACTIVE|has \d+ FAILURE)/, 'must still print its own verdict line');
    assert.strictEqual(r.code, 0);
  } finally { cleanup(); }
});

// ISOLATION CONFIRMATION (team-lead ruling, 0.99.2): the exact class of leak
// that produced two real defects the same day (a review agent registering a
// real launchd job under a temp HOME; an installer that never pinned HOME).
// Mirrors doctor-default-home-isolation.test.js's own "real store untouched"
// proof — the child's resolved os.homedir() must land inside the isolated
// fixture, never the real machine home, and the real
// ~/.anti-hall/devswarm/store must be byte-for-byte untouched (mtime
// unchanged) by every one of this file's spawns.
test('ISOLATION: this file\'s runDoctor() never resolves or touches the real machine home', () => {
  const realStoreDir = path.join(os.homedir(), '.anti-hall', 'devswarm', 'store');
  const before = fs.existsSync(realStoreDir) ? fs.statSync(realStoreDir).mtimeMs : null;

  const { home, cleanup } = makeHome();
  try {
    const PROBE_JS = path.join(home, 'probe.js');
    fs.writeFileSync(PROBE_JS, "process.stdout.write(require('os').homedir());\n");
    const probeRes = cp.spawnSync(process.execPath, [PROBE_JS], {
      encoding: 'utf8', timeout: 15000,
      env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, ANTIHALL_INGEST_DRY_RUN: '1' }),
    });
    const resolved = (probeRes.stdout || '').trim();
    const realHome = os.homedir();
    assert.notStrictEqual(resolved, realHome, 'the child\'s os.homedir() must never resolve to the real machine home');
    assert.ok(resolved === home || fs.realpathSync(resolved) === fs.realpathSync(home),
      'the child\'s os.homedir() must resolve to exactly the isolated fixture, got: ' + resolved);

    // Also run one real repair-flag pass through this file's own runDoctor()
    // (the actual spawn shape every test above uses) against the same
    // isolated home, then confirm the real store is still untouched.
    runDoctor(home, ['--repair-resurrected']);
  } finally { cleanup(); }

  const after = fs.existsSync(realStoreDir) ? fs.statSync(realStoreDir).mtimeMs : null;
  assert.strictEqual(after, before, 'the real ~/.anti-hall/devswarm/store must be byte-for-byte untouched (mtime unchanged) by this file\'s spawns');
});

// P2 FIX (Critic NO-GO, 2026-09-11): emitVerdictAndExit() sat inside the
// REPAIR_INGEST_ORPHANS block, AHEAD of REPAIR_TEST_STORES and
// REPAIR_RESURRECTED in file order, so `--repair-ingest-orphans
// --repair-test-stores` silently ran only the first section — the second
// flag's whole block never executed. Each block's exit is now gated on no
// LATER flag also being set, so a combined invocation runs every requested
// section in order and exits once, after the LAST one.
test('COMBINED FLAGS: `--repair-ingest-orphans --repair-test-stores` runs BOTH sections, then exits once (neither silently dropped)', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = runDoctor(home, ['--repair-ingest-orphans', '--repair-test-stores']);
    assert.match(r.out, /Repair ingest orphans/, 'the FIRST flag\'s section must still run');
    assert.match(r.out, /Repair test stores/, 'the SECOND flag\'s section must ALSO run — this is the exact silent-drop the Critic found');
    assert.doesNotMatch(r.out, new RegExp(SECTION_6N_MARKER), 'must still exit before reaching a later, unrequested section');
    // Exactly ONE verdict line: emitVerdictAndExit() must fire once, not
    // once per matched block (which would print the summary twice).
    const verdictMatches = r.out.match(/anti-hall (ACTIVE|has \d+ FAILURE)/g) || [];
    assert.strictEqual(verdictMatches.length, 1, 'exactly one verdict line, not one per matched repair flag');
    assert.strictEqual(r.code, 0);
  } finally { cleanup(); }
});

test('COMBINED FLAGS: all three flags together run all three sections, then exit once', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = runDoctor(home, ['--repair-ingest-orphans', '--repair-test-stores', '--repair-resurrected']);
    assert.match(r.out, /Repair ingest orphans/);
    assert.match(r.out, /Repair test stores/);
    assert.match(r.out, /Repair resurrected registry rows/);
    assert.doesNotMatch(r.out, new RegExp(SECTION_6N_MARKER));
    const verdictMatches = r.out.match(/anti-hall (ACTIVE|has \d+ FAILURE)/g) || [];
    assert.strictEqual(verdictMatches.length, 1);
    assert.strictEqual(r.code, 0);
  } finally { cleanup(); }
});

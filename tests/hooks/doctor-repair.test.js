'use strict';
// doctor repair mode (v0.55.0) — unit + black-box subprocess tests.
//
// Two layers:
//  1. Pure unit tests of doctor-repair.js's classify/readback logic (require the
//     module directly).
//  2. Black-box: spawn doctor.js with --fix / --dry-run / --check under an isolated
//     HOME + cwd + env (mirrors doctor.test.js's harness) and assert the Repair
//     section behavior AND that no repair artifact leaks onto the real machine.
//
// HERMETIC daemon fixes: a real `--fix` gated install would call launchctl/systemctl
// against the live user domain (not sandboxable in pure Node), so the gate-OPEN case
// is exercised with --dry-run — that still proves the gate DECISION (open vs closed)
// and the installer would run, without registering a real LaunchAgent/timer. The
// gate-CLOSED case is a real --fix and asserts NO unit artifact is written.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DOCTOR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'doctor.js');
const REPAIR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'lib', 'doctor-repair.js');
const INGEST_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'install-devswarm-ingest.js');

const repair = require(REPAIR_JS);
const ingest = require(INGEST_JS);

function mkTmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-repair-' + tag + '-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = mkTmp(tag);
  cp.spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  return dir;
}
// A user ~/.claude/settings.json is a prerequisite for the statusline --user
// install (the installer refuses to create it). Real machines always have it.
function seedUserSettings(home, statusLine) {
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const body = statusLine ? { statusLine } : {};
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(body));
  return path.join(dir, 'settings.json');
}
function runDoctor({ cwd, env, args }) {
  const res = cp.spawnSync(process.execPath, [DOCTOR_JS].concat(args || []), {
    cwd, encoding: 'utf8', timeout: 20000,
    env: Object.assign({}, process.env, {
      HOME: undefined, USERPROFILE: undefined, DEVSWARM_REPO_ID: undefined,
      DISABLE_ANTIHALL_DEVSWARM: undefined, ANTIHALL_DEVSWARM_SUPERVISOR: undefined,
    }, env || {}),
  });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}
function ingestUnitPath(home, platform) {
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', ingest.LABEL + '.plist');
  if (platform === 'linux') return path.join(home, '.config', 'systemd', 'user', ingest.UNIT + '.service');
  return null;
}

// ---------------------------------------------------------------------------
// 1. classifyIngestUnit — pure logic, all platforms.
// ---------------------------------------------------------------------------
test('classifyIngestUnit: no unit -> absent', () => {
  assert.strictEqual(repair.classifyIngestUnit({ workingDir: null, scriptPath: null, home: os.homedir() }), 'absent');
});

test('classifyIngestUnit: WorkingDirectory === HOME -> wrong-path', () => {
  const home = mkTmp('cls-home');
  try {
    assert.strictEqual(repair.classifyIngestUnit({ workingDir: home, scriptPath: INGEST_JS, home }), 'wrong-path');
  } finally { rm(home); }
});

test('classifyIngestUnit: non-existent WorkingDirectory -> wrong-path', () => {
  assert.strictEqual(
    repair.classifyIngestUnit({ workingDir: path.join(os.tmpdir(), 'no-such-dir-' + Date.now()), scriptPath: INGEST_JS, home: os.homedir() }),
    'wrong-path');
});

test('classifyIngestUnit: real git worktree + present script -> ok', () => {
  // REPO_ROOT is a git worktree; INGEST_JS is a real file on disk.
  assert.strictEqual(repair.classifyIngestUnit({ workingDir: REPO_ROOT, scriptPath: INGEST_JS, home: os.homedir() }), 'ok');
});

test('classifyIngestUnit: real worktree but missing script -> stale-script', () => {
  assert.strictEqual(
    repair.classifyIngestUnit({ workingDir: REPO_ROOT, scriptPath: path.join(REPO_ROOT, 'no-such-script-' + Date.now() + '.js'), home: os.homedir() }),
    'stale-script');
});

// ---------------------------------------------------------------------------
// 2. readInstalledIngestWorkingDir — round-trips a fixture unit written with the
// installer's OWN builders (parity), then classifies it.
// ---------------------------------------------------------------------------
test('readInstalledIngestWorkingDir + classify: wrong-path fixture (workdir=HOME)', { skip: process.platform === 'win32' }, () => {
  const home = mkTmp('rb-wrong');
  try {
    const platform = process.platform;
    const unitPath = ingestUnitPath(home, platform);
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    const body = platform === 'darwin'
      ? ingest.buildPlist({ exec: process.execPath, script: INGEST_JS, log: path.join(home, 'l.log'), workdir: home })
      : ingest.buildService({ exec: process.execPath, script: INGEST_JS, workdir: home });
    fs.writeFileSync(unitPath, body);

    const read = repair.readInstalledIngestWorkingDir({ home, platform });
    assert.strictEqual(read.present, true, 'unit should be read as present');
    assert.strictEqual(path.resolve(read.workingDir), path.resolve(home), 'workingDir round-trips to HOME');
    assert.strictEqual(path.resolve(read.scriptPath), path.resolve(INGEST_JS), 'scriptPath round-trips');
    assert.strictEqual(repair.classifyIngestUnit({ workingDir: read.workingDir, scriptPath: read.scriptPath, home }), 'wrong-path');
  } finally { rm(home); }
});

test('readInstalledIngestWorkingDir + classify: healthy fixture (workdir=git worktree) -> ok', { skip: process.platform === 'win32' }, () => {
  const home = mkTmp('rb-ok');
  try {
    const platform = process.platform;
    const unitPath = ingestUnitPath(home, platform);
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    const body = platform === 'darwin'
      ? ingest.buildPlist({ exec: process.execPath, script: INGEST_JS, log: path.join(home, 'l.log'), workdir: REPO_ROOT })
      : ingest.buildService({ exec: process.execPath, script: INGEST_JS, workdir: REPO_ROOT });
    fs.writeFileSync(unitPath, body);

    const read = repair.readInstalledIngestWorkingDir({ home, platform });
    assert.strictEqual(path.resolve(read.workingDir), path.resolve(REPO_ROOT), 'workingDir round-trips to the worktree');
    assert.strictEqual(repair.classifyIngestUnit({ workingDir: read.workingDir, scriptPath: read.scriptPath, home }), 'ok');
  } finally { rm(home); }
});

test('readInstalledIngestWorkingDir: absent unit -> present:false -> classify absent', () => {
  const home = mkTmp('rb-absent');
  try {
    const read = repair.readInstalledIngestWorkingDir({ home, platform: process.platform });
    assert.strictEqual(read.present, false);
    assert.strictEqual(repair.classifyIngestUnit({ workingDir: read.workingDir, scriptPath: read.scriptPath, home }), 'absent');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// 3. GATE — closed vs open.
// ---------------------------------------------------------------------------
test('doctor --fix: DevSwarm INACTIVE -> ingest is GATED, no unit artifact written', { skip: process.platform === 'win32' }, () => {
  const home = mkTmp('gate-closed');
  const cwd = makeGitRepo('gate-closed-cwd');
  try {
    seedUserSettings(home); // so the AUTO-SAFE statusline fix can succeed, not fail
    const r = runDoctor({ cwd, args: ['--fix'], env: { HOME: home, USERPROFILE: home } });
    assert.match(r.out, /GATED \[ingest\]/, 'ingest must be GATED when the DevSwarm gate is closed:\n' + r.out);
    assert.match(r.out, /Run manually from the worktree: node plugins\/anti-hall\/companion\/install-devswarm-ingest\.js/);
    const unit = ingestUnitPath(home, process.platform);
    assert.ok(!fs.existsSync(unit), 'no ingest unit artifact may be written when gated: ' + unit);
  } finally { rm(home); rm(cwd); }
});

test('doctor --dry-run: DevSwarm ACTIVE + git worktree -> gate OPENS (would install ingest), still no artifact', { skip: process.platform === 'win32' }, () => {
  const home = mkTmp('gate-open');
  const cwd = makeGitRepo('gate-open-cwd');
  try {
    seedUserSettings(home);
    const r = runDoctor({ cwd, args: ['--dry-run'], env: { HOME: home, USERPROFILE: home, ANTIHALL_DEVSWARM_SUPERVISOR: 'on', DEVSWARM_REPO_ID: 'repo-x' } });
    assert.match(r.out, /would \(re\)install the ingest daemon/, 'gate must OPEN (would-install) with active DevSwarm + worktree:\n' + r.out);
    assert.doesNotMatch(r.out, /GATED \[ingest\]/, 'must NOT be gated when the gate is open');
    const unit = ingestUnitPath(home, process.platform);
    assert.ok(!fs.existsSync(unit), 'dry-run must not write the ingest unit');
  } finally { rm(home); rm(cwd); }
});

// ---------------------------------------------------------------------------
// 4. Migration idempotency.
// ---------------------------------------------------------------------------
test('doctor --fix: legacy migration runs once, second run is a no-op (skipped)', () => {
  const home = mkTmp('mig-home');
  const cwd = mkTmp('mig-cwd');
  try {
    seedUserSettings(home, { command: 'custom-noop' }); // custom SL so statusline is skipped, not touched
    fs.writeFileSync(path.join(cwd, '.anti-hall-progress.md'), '# legacy progress\n');
    const env = { HOME: home, USERPROFILE: home };

    const r1 = runDoctor({ cwd, args: ['--fix'], env });
    assert.match(r1.out, /FIXED \[migrate-legacy\]/, 'first run migrates:\n' + r1.out);
    assert.ok(fs.existsSync(path.join(cwd, '.anti-hall', 'history', 'legacy', '.anti-hall-progress.md')), 'migrated copy exists');

    const r2 = runDoctor({ cwd, args: ['--fix'], env });
    assert.match(r2.out, /skipped \[migrate-legacy\] nothing to migrate/, 'second run is a no-op:\n' + r2.out);
    assert.doesNotMatch(r2.out, /FIXED \[migrate-legacy\]/);
  } finally { rm(home); rm(cwd); }
});

// Bug 3 (P1, false-FAILED): migrate-devswarm-store's dryRun `pending` used to
// count DESCRIPTORS (which a non-destructive migration never deletes), so
// `after.pending` stayed true forever and the migrationFix re-verify loop
// reported 'failed' on every default doctor run with an active DevSwarm
// workspace — even immediately after a fully successful migration.
test('doctor (default): migrate-devswarm-store FIXES a pending descriptor, then a re-run is a clean no-op (never FAILED)', () => {
  const home = mkTmp('devswarm-mig-home');
  const cwd = mkTmp('devswarm-mig-cwd');
  try {
    seedUserSettings(home, { command: 'custom-noop' }); // custom SL so statusline never fails this test
    const wsDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true });
    const inbox = path.join(home, 'inbox-w1.ndjson');
    fs.writeFileSync(inbox, 'hello-from-w1\n');
    fs.writeFileSync(path.join(wsDir, 'w1.json'), JSON.stringify({
      id: 'w1', worktreePath: '/wt/w1', sessionId: 'sess-w1',
      inboxPath: inbox, cursorPath: null, nudgeCommand: null,
    }));
    const env = { HOME: home, USERPROFILE: home };

    // Default doctor.js invocation (no --fix flag needed — repair runs by default).
    const r1 = runDoctor({ cwd, args: [], env });
    assert.strictEqual(r1.code, 0, 'first run must exit 0 on an otherwise-healthy machine:\n' + r1.out);
    assert.match(r1.out, /FIXED \[migrate-devswarm-store\] migrated: 1 workspace/, 'first run migrates the descriptor:\n' + r1.out);
    assert.doesNotMatch(r1.out, /FAILED \[migrate-devswarm-store\]/);

    // The descriptor is NEVER deleted (non-destructive) — a re-run must see
    // `pending` correctly flip to false and report a clean skip, NOT 'failed'.
    const r2 = runDoctor({ cwd, args: [], env });
    assert.strictEqual(r2.code, 0, 'second run must still exit 0:\n' + r2.out);
    assert.match(r2.out, /skipped \[migrate-devswarm-store\] nothing to migrate/, 'second run is a clean idempotent no-op:\n' + r2.out);
    assert.doesNotMatch(r2.out, /FAILED \[migrate-devswarm-store\]/, 'must never report FAILED once the descriptor is actually migrated');
  } finally { rm(home); rm(cwd); }
});

// ---------------------------------------------------------------------------
// 5. Statusline: install-if-missing vs custom-untouched.
// ---------------------------------------------------------------------------
test('doctor --fix: no statusLine anywhere -> installs (--user)', () => {
  const home = mkTmp('sl-missing');
  const cwd = mkTmp('sl-missing-cwd');
  try {
    const settingsPath = seedUserSettings(home); // {} — no statusLine
    const r = runDoctor({ cwd, args: ['--fix'], env: { HOME: home, USERPROFILE: home } });
    assert.match(r.out, /FIXED \[statusline\]/, 'statusline must be installed when absent:\n' + r.out);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(after.statusLine && /statusline\.js/.test(after.statusLine.command || ''), 'settings.json now points at anti-hall statusline.js');
  } finally { rm(home); rm(cwd); }
});

test('doctor --fix: a CUSTOM statusLine is left untouched (never overridden)', () => {
  const home = mkTmp('sl-custom');
  const cwd = mkTmp('sl-custom-cwd');
  try {
    const settingsPath = seedUserSettings(home, { command: '/my/own/statusline.sh' });
    const r = runDoctor({ cwd, args: ['--fix'], env: { HOME: home, USERPROFILE: home } });
    assert.match(r.out, /skipped \[statusline\]/, 'a custom statusLine must be skipped, not touched:\n' + r.out);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(after.statusLine.command, '/my/own/statusline.sh', 'custom statusLine command unchanged');
  } finally { rm(home); rm(cwd); }
});

// ---------------------------------------------------------------------------
// 6. --dry-run writes no repair artifacts (gate open, statusLine absent).
// ---------------------------------------------------------------------------
test('doctor --dry-run: writes NO repair artifacts (no unit, no statusLine mutation)', { skip: process.platform === 'win32' }, () => {
  const home = mkTmp('dry-home');
  const cwd = makeGitRepo('dry-cwd');
  try {
    const settingsPath = seedUserSettings(home); // {} — a real --fix WOULD add a statusLine
    const r = runDoctor({ cwd, args: ['--dry-run'], env: { HOME: home, USERPROFILE: home, ANTIHALL_DEVSWARM_SUPERVISOR: 'on', DEVSWARM_REPO_ID: 'repo-x' } });
    assert.match(r.out, /Repair \(dry-run/, 'dry-run prints the Repair section:\n' + r.out);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(!after.statusLine, 'dry-run must not add a statusLine');
    assert.ok(!fs.existsSync(ingestUnitPath(home, process.platform)), 'dry-run must not write the ingest unit');
  } finally { rm(home); rm(cwd); }
});

// ---------------------------------------------------------------------------
// 7. Backward-compat: --check is PURE read-only (no Repair section, exit 0).
// ---------------------------------------------------------------------------
test('doctor --check: no Repair section, exits 0 on a clean fake machine (read-only)', () => {
  const home = mkTmp('check-home');
  const cwd = mkTmp('check-cwd');
  try {
    const r = runDoctor({ cwd, args: ['--check'], env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, '--check exits 0:\n' + r.out);
    assert.doesNotMatch(r.out, /\nRepair/, '--check must NOT run the repair pass');
  } finally { rm(home); rm(cwd); }
});

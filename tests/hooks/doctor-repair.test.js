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
const STORE_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js');
const DEVSWARM_SCRIPT_FOR_TEST = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'scripts', 'devswarm.js');

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
// makeMarketplaceFixture — a throwaway dir shaped like install-devswarm-ingest.js's
// resolveStableScript() expects (plugins/anti-hall/companion/devswarm-ingest.js
// under the marketplace root), pointed at via ANTIHALL_MARKETPLACE_DIR (the same
// test-only override resolveStableScript itself documents honoring) instead of
// faking a real ~/.claude/plugins/marketplaces/anti-hall on the test machine.
function makeMarketplaceFixture(tag) {
  const dir = mkTmp('mp-' + tag);
  const scriptDir = path.join(dir, 'plugins', 'anti-hall', 'companion');
  fs.mkdirSync(scriptDir, { recursive: true });
  const scriptPath = path.join(scriptDir, 'devswarm-ingest.js');
  fs.writeFileSync(scriptPath, '// fixture stable ingest daemon script\n');
  return { dir, scriptPath };
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
// 1b. classifyIngestUnit — v0.56.0 config-drift ('unstable-script'): a baked
// ExecStart script that still EXISTS but is not install-devswarm-ingest.js's
// CURRENT resolveStableScript() result (parity with update.js's healIngestDaemon,
// which reuses this exact classify helper). Opt-in on `env` — see the doc comment
// on classifyIngestUnit in doctor-repair.js for why.
// ---------------------------------------------------------------------------
test('classifyIngestUnit: script exists but drifted from the current stable marketplace path (env passed) -> unstable-script', () => {
  const mp = makeMarketplaceFixture('drift-a');
  try {
    const result = repair.classifyIngestUnit({
      workingDir: REPO_ROOT, scriptPath: INGEST_JS, home: os.homedir(),
      env: { ANTIHALL_MARKETPLACE_DIR: mp.dir },
    });
    assert.strictEqual(result, 'unstable-script');
  } finally { rm(mp.dir); }
});

test('classifyIngestUnit: script IS the current stable marketplace path (env passed) -> ok', () => {
  const mp = makeMarketplaceFixture('drift-b');
  try {
    const result = repair.classifyIngestUnit({
      workingDir: REPO_ROOT, scriptPath: mp.scriptPath, home: os.homedir(),
      env: { ANTIHALL_MARKETPLACE_DIR: mp.dir },
    });
    assert.strictEqual(result, 'ok');
  } finally { rm(mp.dir); }
});

test('classifyIngestUnit: drifted script but NO env passed -> stays ok (opt-in preserves pre-v0.56.0 existence-only check)', () => {
  const mp = makeMarketplaceFixture('drift-c');
  try {
    // Identical to the drift case above MINUS `env` — must NOT flag drift, so a
    // bare low-level classify call (as every pre-v0.56.0 caller/test makes) is
    // unaffected by whatever marketplace clone happens to exist on the machine.
    const result = repair.classifyIngestUnit({ workingDir: REPO_ROOT, scriptPath: INGEST_JS, home: os.homedir() });
    assert.strictEqual(result, 'ok');
  } finally { rm(mp.dir); }
});

test('classifyIngestUnit: env passed but no marketplace clone resolvable (dev-mode) -> stays ok, nothing to compare against', () => {
  const home = mkTmp('drift-d-home');
  try {
    const result = repair.classifyIngestUnit({
      workingDir: REPO_ROOT, scriptPath: INGEST_JS, home,
      env: {}, // no ANTIHALL_MARKETPLACE_DIR, and this fixture home has no ~/.claude/plugins/marketplaces/anti-hall
    });
    assert.strictEqual(result, 'ok');
  } finally { rm(home); }
});

test('classifyIngestUnit: resolveStableScript raises -> fail-open, never throws, no drift falsely applied', () => {
  const mp = makeMarketplaceFixture('drift-e');
  const cacheKey = require.resolve(INGEST_JS);
  const original = require.cache[cacheKey].exports.resolveStableScript;
  require.cache[cacheKey].exports.resolveStableScript = () => { throw new Error('simulated resolveStableScript failure'); };
  try {
    const result = repair.classifyIngestUnit({
      workingDir: REPO_ROOT, scriptPath: INGEST_JS, home: os.homedir(),
      env: { ANTIHALL_MARKETPLACE_DIR: mp.dir },
    });
    assert.strictEqual(result, 'ok', 'a throwing resolveStableScript must fail open (never propagate, never falsely flag drift)');
  } finally {
    require.cache[cacheKey].exports.resolveStableScript = original;
    rm(mp.dir);
  }
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
// 6b. v0.56.0 config-drift (unstable-script) end-to-end through doctor --fix /
// --dry-run — parity with update.js's healIngestDaemon (same classify, same
// gate, same reinstall). (a) a drifted unit is migrate-invoked (gate open) /
// GATED with a distinct reason (gate closed); (b) an already-current unit is
// left alone (no thrash).
// ---------------------------------------------------------------------------
test('(a) doctor --fix: unstable-script unit, DevSwarm INACTIVE -> GATED with the drift reason, no unit rewritten', { skip: process.platform === 'win32' }, () => {
  const home = mkTmp('drift-gated');
  const cwd = makeGitRepo('drift-gated-cwd');
  // Bake the SAME canonical path resolveWorktree(cwd) will compute inside the
  // doctor subprocess (realpath-resolved — macOS's TMPDIR is a /var -> /private/var
  // symlink, so a raw `cwd` here would never string-match `samePath` against it).
  const wt = ingest.resolveWorktree(cwd) || cwd;
  const mp = makeMarketplaceFixture('drift-gated');
  try {
    seedUserSettings(home);
    const platform = process.platform;
    const unitPath = ingestUnitPath(home, platform);
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    // scriptPath = INGEST_JS (an existing file, but NOT the fixture's "stable" path).
    const body = platform === 'darwin'
      ? ingest.buildPlist({ exec: process.execPath, script: INGEST_JS, log: path.join(home, 'l.log'), workdir: wt })
      : ingest.buildService({ exec: process.execPath, script: INGEST_JS, workdir: wt });
    fs.writeFileSync(unitPath, body);
    const before = fs.readFileSync(unitPath, 'utf8');

    const r = runDoctor({ cwd, args: ['--fix'], env: { HOME: home, USERPROFILE: home, ANTIHALL_MARKETPLACE_DIR: mp.dir } });
    assert.match(r.out, /GATED \[ingest\]/, 'a drifted unit must be GATED when the DevSwarm gate is closed:\n' + r.out);
    assert.match(r.out, /ExecStart script is not the current stable build/, 'the drift reason must be distinct from "missing":\n' + r.out);
    assert.strictEqual(fs.readFileSync(unitPath, 'utf8'), before, 'a gated repair must never rewrite the unit');
  } finally { rm(home); rm(cwd); rm(mp.dir); }
});

test('(a) doctor --dry-run: unstable-script unit, DevSwarm ACTIVE + worktree -> gate OPENS (would re-install), reason carried, still no artifact mutation', { skip: process.platform === 'win32' }, () => {
  const home = mkTmp('drift-open');
  const cwd = makeGitRepo('drift-open-cwd');
  const wt = ingest.resolveWorktree(cwd) || cwd; // realpath-resolved, matches the subprocess's own resolveWorktree(cwd)
  const mp = makeMarketplaceFixture('drift-open');
  try {
    seedUserSettings(home);
    const platform = process.platform;
    const unitPath = ingestUnitPath(home, platform);
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    const body = platform === 'darwin'
      ? ingest.buildPlist({ exec: process.execPath, script: INGEST_JS, log: path.join(home, 'l.log'), workdir: wt })
      : ingest.buildService({ exec: process.execPath, script: INGEST_JS, workdir: wt });
    fs.writeFileSync(unitPath, body);
    const before = fs.readFileSync(unitPath, 'utf8');

    const r = runDoctor({
      cwd, args: ['--dry-run'],
      env: { HOME: home, USERPROFILE: home, ANTIHALL_DEVSWARM_SUPERVISOR: 'on', DEVSWARM_REPO_ID: 'repo-x', ANTIHALL_MARKETPLACE_DIR: mp.dir },
    });
    assert.match(r.out, /would \(re\)install the ingest daemon from .*\(unstable-script\)/, 'gate must OPEN (would-install) for a drifted-but-present script:\n' + r.out);
    assert.doesNotMatch(r.out, /GATED \[ingest\]/, 'must NOT be gated when the gate is open');
    assert.strictEqual(fs.readFileSync(unitPath, 'utf8'), before, 'dry-run must not rewrite the unit');
  } finally { rm(home); rm(cwd); rm(mp.dir); }
});

test('(b) doctor --dry-run: script already IS the current stable marketplace path -> classified ok, NO reinstall attempted (no thrash)', { skip: process.platform === 'win32' }, () => {
  const home = mkTmp('drift-nothrash');
  const cwd = makeGitRepo('drift-nothrash-cwd');
  const wt = ingest.resolveWorktree(cwd) || cwd; // realpath-resolved, matches the subprocess's own resolveWorktree(cwd)
  const mp = makeMarketplaceFixture('drift-nothrash');
  try {
    seedUserSettings(home);
    const platform = process.platform;
    const unitPath = ingestUnitPath(home, platform);
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    // scriptPath = mp.scriptPath — exactly the path resolveStableScript resolves to.
    const body = platform === 'darwin'
      ? ingest.buildPlist({ exec: process.execPath, script: mp.scriptPath, log: path.join(home, 'l.log'), workdir: wt })
      : ingest.buildService({ exec: process.execPath, script: mp.scriptPath, workdir: wt });
    fs.writeFileSync(unitPath, body);

    const r = runDoctor({
      cwd, args: ['--dry-run'],
      env: { HOME: home, USERPROFILE: home, ANTIHALL_DEVSWARM_SUPERVISOR: 'on', DEVSWARM_REPO_ID: 'repo-x', ANTIHALL_MARKETPLACE_DIR: mp.dir },
    });
    assert.match(r.out, /skipped \[ingest\] ingest daemon installed and healthy/, 'a script matching the current stable path must classify ok, no thrash:\n' + r.out);
    assert.doesNotMatch(r.out, /would \(re\)install the ingest daemon/, 'must NOT attempt a reinstall when already current:\n' + r.out);
  } finally { rm(home); rm(cwd); rm(mp.dir); }
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

// ---------------------------------------------------------------------------
// 8. Reconcile (v0.58.0's `devswarm.js reconcile` verb, auto-run here as a
// GATED repair — v0.58.1). Reconcile itself never touches launchd/systemd (it
// only spawns per-worktree `inbox pull` subprocesses of THIS SAME plugin's own
// devswarm.js against the fake HOME's own store), BUT `gateOpen` is shared
// across ALL GATED repairs in one runRepairs() pass — a real (non-dry-run)
// `doctor --fix` with the gate open ALSO fires the ingest/supervisor GATED
// fixes for real, and `launchctl load`/`systemctl` register against the REAL
// user session regardless of a HOME env override (confirmed the hard way — an
// earlier draft of this suite left real orphaned `com.anti-hall.devswarm-
// ingest.*` launchd jobs running on the dev machine after the fake HOME tmpdir
// was cleaned up). So the "real FIXED run" case below calls
// `repair.runRepairs()` IN-PROCESS with `platform:'win32'` — ingest/supervisor/
// reap-legacy-ingest all take their documented win32-skip branch (no spawn),
// while reconcile (which does not gate on platform) still runs for real. Never
// use a real, non-dry-run `doctor --fix` subprocess with the gate open here.
// ---------------------------------------------------------------------------
function storeDirExists(home) { return fs.existsSync(path.join(home, '.anti-hall', 'devswarm', 'store')); }

test('doctor --fix: DevSwarm INACTIVE -> reconcile is GATED, exact manual command shown, store never opened', () => {
  const home = mkTmp('recon-gated');
  const cwd = makeGitRepo('recon-gated-cwd');
  try {
    seedUserSettings(home);
    const r = runDoctor({ cwd, args: ['--fix'], env: { HOME: home, USERPROFILE: home } });
    assert.match(r.out, /GATED \[reconcile\]/, 'reconcile must be GATED when the DevSwarm gate is closed:\n' + r.out);
    assert.match(r.out, /Run manually from the worktree: node plugins\/anti-hall\/scripts\/devswarm\.js reconcile/);
    assert.ok(!storeDirExists(home), 'a gated repair must never open/create the shared store');
  } finally { rm(home); rm(cwd); }
});

test('doctor --dry-run: DevSwarm ACTIVE + git worktree -> gate OPENS (would run reconcile), still writes nothing', () => {
  const home = mkTmp('recon-dry');
  const cwd = makeGitRepo('recon-dry-cwd');
  try {
    seedUserSettings(home);
    const r = runDoctor({ cwd, args: ['--dry-run'], env: { HOME: home, USERPROFILE: home, ANTIHALL_DEVSWARM_SUPERVISOR: 'on', DEVSWARM_REPO_ID: 'repo-x' } });
    assert.match(r.out, /\[dry-run\] would run reconcile \(drain stranded per-worktree native queues into the shared store\)/, 'gate must OPEN (would-run) with active DevSwarm + worktree:\n' + r.out);
    assert.doesNotMatch(r.out, /GATED \[reconcile\]/, 'must NOT be gated when the gate is open');
    assert.ok(!storeDirExists(home), 'dry-run must never open/create the shared store (no per-worktree drain is ever spawned)');
  } finally { rm(home); rm(cwd); }
});

test('runRepairs (in-process, platform=win32 to skip the OTHER daemon-touching GATED repairs — see safety note above): DevSwarm ACTIVE + git worktree -> reconcile actually FIXES (real run, empty registry -> 0 drained)', () => {
  const home = mkTmp('recon-open');
  const cwd = makeGitRepo('recon-open-cwd');
  // Backend-agnostic instrumentation (CI fix, node 18/20 red): the sqlite
  // backend eagerly `mkdirSync`s the store dir on open (devswarm-store.js
  // openSqlite), so `storeDirExists()` used to prove "the store was really
  // opened" — but the journal backend (the ONLY backend on node 18/20, which
  // lack node:sqlite) performs ZERO fs writes for an all-read pass against an
  // EMPTY registry (its mkdir only runs inside `append()`, on an actual
  // write). For this exact empty-registry/0-drained scenario the journal
  // backend leaves no directory artifact at all even though openStore WAS
  // genuinely called — so asserting on a directory is backend-dependent and
  // false on node 18/20. Assert on the production primitive itself instead
  // (same monkeypatch pattern as classifyIngestUnit's resolveStableScript
  // override above): wrap store.openStore to record that it was actually
  // invoked, then delegate to the real implementation. True on BOTH
  // backends, and still distinguishes this real run from the gated/dry-run
  // cases above, which never call openStore at all.
  const storeCacheKey = require.resolve(STORE_JS);
  require(STORE_JS); // ensure cached under storeCacheKey before patching
  const originalOpenStore = require.cache[storeCacheKey].exports.openStore;
  let openStoreCalled = false;
  require.cache[storeCacheKey].exports.openStore = (opts) => {
    openStoreCalled = true;
    return originalOpenStore(opts);
  };
  try {
    const env = { ANTIHALL_DEVSWARM_SUPERVISOR: 'on', DEVSWARM_REPO_ID: 'repo-x' };
    const results = repair.runRepairs({ cwd, env, home, dryRun: false, platform: 'win32' });
    const r = results.find((x) => x.id === 'reconcile');
    assert.ok(r, 'a reconcile repair result must be present:\n' + JSON.stringify(results, null, 2));
    assert.strictEqual(r.status, 'fixed', 'reconcile must actually run and succeed when the gate is open:\n' + JSON.stringify(r));
    assert.match(r.msg, /reconciled 0 worktree\(s\) — imported 0 message\(s\) into the shared store/);
    assert.strictEqual(openStoreCalled, true, 'a real reconcile run DOES open the shared store (unlike gated/dry-run)');
  } finally {
    require.cache[storeCacheKey].exports.openStore = originalOpenStore;
    rm(home); rm(cwd);
  }
});

// P1 fix (v0.58.1): doctor's GATED reconcile repair used to read only
// `result.ok` — and cmdReconcile used to ALWAYS return ok:true regardless of
// whether any target actually lost messages, so a lossy auto-repair was
// reported as `status:'fixed'` (mutating nothing, telling the user everything
// is fine, while messages were silently gone). cmdReconcile now returns
// ok:false + a `lost` total whenever any target reports a shortfall; this
// proves doctor's repair layer honors that and reports `failed`, with the
// loss count in the message — never silently upgraded to `fixed`.
test('doctor --fix: reconcile with a REAL per-worktree message loss -> reported as FAILED (never "fixed"), loss count surfaced in the message', () => {
  const home = mkTmp('recon-lossy');
  const cwd = makeGitRepo('recon-lossy-cwd');
  const devswarmCacheKey = require.resolve(DEVSWARM_SCRIPT_FOR_TEST);
  require(DEVSWARM_SCRIPT_FOR_TEST); // ensure cached before patching
  const originalRun = require.cache[devswarmCacheKey].exports.run;
  require.cache[devswarmCacheKey].exports.run = (argv) => {
    if (argv[0] === 'reconcile') {
      return {
        code: 2,
        result: {
          ok: false, action: 'reconcile', repoKey: 'fake-repo', count: 1, imported: 0, lost: 2,
          results: [{ id: 'child-lossy', worktreePath: '/wt/lossy', ok: false, imported: 0, duplicate: 0, nativeCount: 2, lost: 2, locked: true, error: null }],
        },
      };
    }
    return originalRun(argv);
  };
  try {
    const env = { ANTIHALL_DEVSWARM_SUPERVISOR: 'on', DEVSWARM_REPO_ID: 'repo-x' };
    const results = repair.runRepairs({ cwd, env, home, dryRun: false, platform: 'win32' });
    const r = results.find((x) => x.id === 'reconcile');
    assert.ok(r, 'a reconcile repair result must be present:\n' + JSON.stringify(results, null, 2));
    assert.strictEqual(r.status, 'failed', 'a lossy reconcile must NEVER be reported as fixed:\n' + JSON.stringify(r));
    assert.match(r.msg, /LOST 2 message/i, 'the loss count must be surfaced in the repair message, not swallowed into "unknown error":\n' + r.msg);
  } finally {
    require.cache[devswarmCacheKey].exports.run = originalRun;
    rm(home); rm(cwd);
  }
});

test('doctor --check: DevSwarm ACTIVE + git worktree -> reconcile is skipped entirely (pure read-only, no Repair section at all)', () => {
  const home = mkTmp('recon-check');
  const cwd = makeGitRepo('recon-check-cwd');
  try {
    seedUserSettings(home);
    const r = runDoctor({ cwd, args: ['--check'], env: { HOME: home, USERPROFILE: home, ANTIHALL_DEVSWARM_SUPERVISOR: 'on', DEVSWARM_REPO_ID: 'repo-x' } });
    assert.strictEqual(r.code, 0, '--check exits 0:\n' + r.out);
    assert.doesNotMatch(r.out, /\nRepair/, '--check must NOT run the repair pass, even with the DevSwarm gate open');
    assert.doesNotMatch(r.out, /\[reconcile\]/, '--check must never mention reconcile');
    assert.ok(!storeDirExists(home), '--check must never open/create the shared store');
  } finally { rm(home); rm(cwd); }
});

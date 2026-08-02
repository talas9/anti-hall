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
const cli = require(DEVSWARM_SCRIPT_FOR_TEST);
const storeLib = require(STORE_JS);
const repokey = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-repokey.js'));

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
    // Claim 5 H1: install-shape 'ok' alone is no longer enough to report healthy —
    // back this fixture with a genuinely fresh heartbeat + live-pid lock holder so
    // "no thrash" is testing what it claims (an actually-alive, up-to-date daemon),
    // not just an install-shape coincidence.
    const repoKey = repokey.repoKeyForWorktree(wt);
    const hb = heartbeatPathFor(home, repoKey);
    const lock = projectLockPathFor(home, repoKey);
    fs.mkdirSync(path.dirname(hb), { recursive: true });
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(hb, JSON.stringify({ ts: Date.now(), pid: process.pid }));
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));

    const r = runDoctor({
      cwd, args: ['--dry-run'],
      env: { HOME: home, USERPROFILE: home, ANTIHALL_DEVSWARM_SUPERVISOR: 'on', DEVSWARM_REPO_ID: 'repo-x', ANTIHALL_MARKETPLACE_DIR: mp.dir },
    });
    assert.match(r.out, /skipped \[ingest\] ingest daemon installed and healthy/, 'a script matching the current stable path AND alive must classify ok, no thrash:\n' + r.out);
    assert.doesNotMatch(r.out, /would \(re\)install the ingest daemon/, 'must NOT attempt a reinstall when already current:\n' + r.out);
  } finally { rm(home); rm(cwd); rm(mp.dir); }
});

// ---------------------------------------------------------------------------
// 6c. Claim 5 H1 — daemon-LIVENESS gate. classifyIngestUnit is install-SHAPE
// only (WorkingDirectory/ExecStart on disk); a well-formed unit whose daemon
// is dead/wedged must NOT be reported skipped/healthy. These tests use a
// legacy-shaped (base LABEL/UNIT, no suffix) fixture unit — install-shape
// 'ok' via the SAME construction as the existing "healthy fixture" test above
// — and control ONLY the heartbeat/lock files projectDaemonHealthy reads, so
// the liveness signal alone drives the outcome.
// ---------------------------------------------------------------------------
function heartbeatPathFor(home, repoKey) {
  return path.join(home, '.anti-hall', 'devswarm', 'heartbeats', 'ingest-' + repoKey + '.json');
}
function projectLockPathFor(home, repoKey) {
  return path.join(home, '.anti-hall', 'devswarm', 'locks', 'ingest-project-' + repoKey + '.lock');
}
function writeOkIngestUnitFixture(home, cwd) {
  const platform = process.platform;
  const wt = ingest.resolveWorktree(cwd) || cwd; // realpath-resolved, matches the subprocess's own resolveWorktree(cwd)
  const unitPath = ingestUnitPath(home, platform);
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  const body = platform === 'darwin'
    ? ingest.buildPlist({ exec: process.execPath, script: INGEST_JS, log: path.join(home, 'l.log'), workdir: wt })
    : ingest.buildService({ exec: process.execPath, script: INGEST_JS, workdir: wt });
  fs.writeFileSync(unitPath, body);
  return { unitPath, repoKey: repokey.repoKeyForWorktree(wt) };
}

test('doctor --fix: install-shape ok but NO heartbeat/lock at all (daemon never ran) -> GATED as NOT ALIVE, never reported healthy', { skip: process.platform === 'win32' }, () => {
  const home = mkTmp('live-none-gated');
  const cwd = makeGitRepo('live-none-gated-cwd');
  try {
    seedUserSettings(home);
    const { unitPath } = writeOkIngestUnitFixture(home, cwd);
    const before = fs.readFileSync(unitPath, 'utf8');

    const r = runDoctor({ cwd, args: ['--fix'], env: { HOME: home, USERPROFILE: home } });
    assert.doesNotMatch(r.out, /ingest daemon installed and healthy/, 'a dead daemon must never be reported healthy:\n' + r.out);
    assert.match(r.out, /GATED \[ingest\]/, 'a dead daemon behind a closed gate must be GATED, not skipped:\n' + r.out);
    assert.match(r.out, /NOT ALIVE/, 'the gated reason must call out liveness, not install-shape:\n' + r.out);
    assert.strictEqual(fs.readFileSync(unitPath, 'utf8'), before, 'a gated repair must never rewrite the unit');
  } finally { rm(home); rm(cwd); }
});

test('doctor --dry-run: install-shape ok but STALE heartbeat (daemon crashed after its last write) -> gate OPENS, would reinstall as dead-daemon', { skip: process.platform === 'win32' }, () => {
  const home = mkTmp('live-stale-open');
  const cwd = makeGitRepo('live-stale-open-cwd');
  try {
    seedUserSettings(home);
    const { unitPath, repoKey } = writeOkIngestUnitFixture(home, cwd);
    const hb = heartbeatPathFor(home, repoKey);
    fs.mkdirSync(path.dirname(hb), { recursive: true });
    // 10 minutes old — well past the 3-minute HEARTBEAT_STALE window.
    fs.writeFileSync(hb, JSON.stringify({ ts: Date.now() - 10 * 60 * 1000, pid: 999999 }));
    const before = fs.readFileSync(unitPath, 'utf8');

    const r = runDoctor({ cwd, args: ['--dry-run'], env: { HOME: home, USERPROFILE: home, ANTIHALL_DEVSWARM_SUPERVISOR: 'on', DEVSWARM_REPO_ID: 'repo-x' } });
    assert.match(r.out, /would \(re\)install the ingest daemon from .*\(dead-daemon\)/, 'a stale heartbeat must trigger the dead-daemon reinstall path:\n' + r.out);
    assert.doesNotMatch(r.out, /GATED \[ingest\]/, 'must NOT be gated when the gate is open');
    assert.doesNotMatch(r.out, /ingest daemon installed and healthy/);
    assert.strictEqual(fs.readFileSync(unitPath, 'utf8'), before, 'dry-run must never rewrite the unit');
  } finally { rm(home); rm(cwd); }
});

test('doctor --fix: install-shape ok + FRESH heartbeat + a live-pid lock holder -> reported healthy, no reinstall (liveness true path)', { skip: process.platform === 'win32' }, () => {
  const home = mkTmp('live-ok');
  const cwd = makeGitRepo('live-ok-cwd');
  try {
    seedUserSettings(home);
    const { unitPath, repoKey } = writeOkIngestUnitFixture(home, cwd);
    const hb = heartbeatPathFor(home, repoKey);
    const lock = projectLockPathFor(home, repoKey);
    fs.mkdirSync(path.dirname(hb), { recursive: true });
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(hb, JSON.stringify({ ts: Date.now(), pid: process.pid }));
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const before = fs.readFileSync(unitPath, 'utf8');

    const r = runDoctor({ cwd, args: ['--fix'], env: { HOME: home, USERPROFILE: home } });
    assert.match(r.out, /skipped \[ingest\] ingest daemon installed and healthy/, 'a fresh heartbeat + live lock holder must classify healthy:\n' + r.out);
    assert.doesNotMatch(r.out, /GATED \[ingest\]/);
    assert.doesNotMatch(r.out, /NOT ALIVE/);
    assert.strictEqual(fs.readFileSync(unitPath, 'utf8'), before, 'a healthy daemon must never be reinstalled');
  } finally { rm(home); rm(cwd); }
});

test('doctor --check: install-shape ok but dead daemon -> --check stays pure read-only (no Repair section, no liveness mention)', { skip: process.platform === 'win32' }, () => {
  const home = mkTmp('live-check');
  const cwd = makeGitRepo('live-check-cwd');
  try {
    seedUserSettings(home);
    const r = runDoctor({ cwd, args: ['--check'], env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, '--check exits 0:\n' + r.out);
    assert.doesNotMatch(r.out, /\nRepair/, '--check must never run the repair pass, even with a dead daemon');
    assert.doesNotMatch(r.out, /NOT ALIVE/);
  } finally { rm(home); rm(cwd); }
});

// ---------------------------------------------------------------------------
// 6d. v0.66 — "ALIVE BUT INGESTING NOTHING". The daemon wrote its heartbeat
// BEFORE each monitor call, unconditionally, so a daemon whose every
// `hivecontrol workspace monitor` spawn failed ENOENT (bare binary name + the
// scheduler's minimal PATH) still satisfied the liveness gate above and doctor
// reported it "installed and healthy" while it ingested exactly nothing. The
// heartbeat now carries the monitor OUTCOME; doctor must FAIL on it — and must
// stay silent for a legacy heartbeat that predates those fields.
// ---------------------------------------------------------------------------

test('monitorFaultFor: a LEGACY heartbeat (no monitor fields) is UNKNOWN -> never a fault (fail-open)', () => {
  const home = mkTmp('mf-legacy');
  try {
    const repoKey = 'proj-abc123';
    const hb = heartbeatPathFor(home, repoKey);
    fs.mkdirSync(path.dirname(hb), { recursive: true });
    fs.writeFileSync(hb, JSON.stringify({ ts: Date.now(), pid: process.pid, workspaceId: 'p' }));
    assert.strictEqual(repair.monitorFaultFor(home, repoKey, Date.now()), null,
      'an older daemon that never wrote these fields must never be condemned');
    // Missing file / unparsable JSON / no repoKey are all UNKNOWN too.
    assert.strictEqual(repair.monitorFaultFor(home, 'no-such-key', Date.now()), null);
    fs.writeFileSync(hb, 'not json');
    assert.strictEqual(repair.monitorFaultFor(home, repoKey, Date.now()), null);
    assert.strictEqual(repair.monitorFaultFor(home, null, Date.now()), null);
  } finally { rm(home); }
});

test('monitorFaultFor: healthy counters -> null; a below-threshold blip -> null; sustained failures -> FAULT', () => {
  const home = mkTmp('mf-thresh');
  try {
    const repoKey = 'proj-abc123';
    const hb = heartbeatPathFor(home, repoKey);
    fs.mkdirSync(path.dirname(hb), { recursive: true });
    const now = Date.now();
    const write = (o) => fs.writeFileSync(hb, JSON.stringify(Object.assign({ ts: now, pid: process.pid }, o)));

    write({ consecutiveMonitorFailures: 0, lastMonitorOkMs: now - 1000 });
    assert.strictEqual(repair.monitorFaultFor(home, repoKey, now), null, 'a draining daemon is never a fault');

    write({ consecutiveMonitorFailures: 1, lastMonitorOkMs: now - 1000 });
    assert.strictEqual(repair.monitorFaultFor(home, repoKey, now), null, 'a single transient blip is not a fault');

    write({
      consecutiveMonitorFailures: repair.MONITOR_FAILURE_FAIL_THRESHOLD,
      lastMonitorOkMs: null, lastMonitorErrorCode: 'ENOENT',
      hivecontrolBin: 'hivecontrol', hivecontrolSource: 'path',
      daemonPath: '/usr/bin:/bin:/usr/sbin:/sbin',
    });
    const fault = repair.monitorFaultFor(home, repoKey, now);
    assert.ok(fault, 'sustained failures ARE a fault');
    assert.strictEqual(fault.code, 'ENOENT');
    assert.strictEqual(fault.daemonPath, '/usr/bin:/bin:/usr/sbin:/sbin');
    const reason = repair.monitorFaultReason(fault, '/w');
    assert.match(reason, /RUNNING but/, 'the reason distinguishes this from a dead daemon');
    assert.match(reason, /hivecontrol/, 'the reason names the resolved binary');
    assert.match(reason, /\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/, "the reason names the daemon's actual PATH");
    assert.match(reason, /ANTIHALL_DEVSWARM_HIVECONTROL/, 'the reason names the remedy');

    // Second trigger: a positively STALE last-success while still failing.
    write({ consecutiveMonitorFailures: 1, lastMonitorOkMs: now - (repair.MONITOR_OK_STALE_MS + 60000) });
    assert.ok(repair.monitorFaultFor(home, repoKey, now), 'a long-stale last-success while failing is also a fault');
  } finally { rm(home); }
});

test('doctor --fix: alive + heartbeating but MONITOR FAILING -> reported as a FAILURE, never healthy', { skip: process.platform === 'win32' }, () => {
  const home = mkTmp('mf-alive-failing');
  const cwd = makeGitRepo('mf-alive-failing-cwd');
  try {
    seedUserSettings(home);
    const { unitPath, repoKey } = writeOkIngestUnitFixture(home, cwd);
    const hb = heartbeatPathFor(home, repoKey);
    const lock = projectLockPathFor(home, repoKey);
    fs.mkdirSync(path.dirname(hb), { recursive: true });
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    // FRESH heartbeat + a live-pid lock (this daemon passes the liveness gate)
    // — but every monitor call is failing with a configuration error.
    fs.writeFileSync(hb, JSON.stringify({
      ts: Date.now(), pid: process.pid, workspaceId: 'p',
      consecutiveMonitorFailures: 120, lastMonitorOkMs: null, lastMonitorErrorCode: 'ENOENT',
      lastMonitorError: 'spawnSync hivecontrol ENOENT',
      hivecontrolBin: 'hivecontrol', hivecontrolSource: 'path',
      daemonPath: '/usr/bin:/bin:/usr/sbin:/sbin',
    }));
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const before = fs.readFileSync(unitPath, 'utf8');

    const r = runDoctor({ cwd, args: ['--fix'], env: { HOME: home, USERPROFILE: home } });
    assert.doesNotMatch(r.out, /ingest daemon installed and healthy/,
      'a daemon that ingests nothing must NEVER be reported healthy:\n' + r.out);
    assert.match(r.out, /GATED \[ingest\]/, 'behind a closed gate it is GATED with the real reason:\n' + r.out);
    assert.match(r.out, /RUNNING but its .*monitor.* calls are FAILING/, 'names the actual fault:\n' + r.out);
    assert.match(r.out, /ENOENT/, 'names the error code:\n' + r.out);
    assert.match(r.out, /daemon PATH=\/usr\/bin:\/bin/, "names the daemon's actual PATH:\n" + r.out);
    assert.strictEqual(fs.readFileSync(unitPath, 'utf8'), before, 'a gated repair must never rewrite the unit');
  } finally { rm(home); rm(cwd); }
});

test('doctor --fix: alive + monitor SUCCEEDING -> still reported healthy (no false positive)', { skip: process.platform === 'win32' }, () => {
  const home = mkTmp('mf-alive-ok');
  const cwd = makeGitRepo('mf-alive-ok-cwd');
  try {
    seedUserSettings(home);
    const { repoKey } = writeOkIngestUnitFixture(home, cwd);
    const hb = heartbeatPathFor(home, repoKey);
    const lock = projectLockPathFor(home, repoKey);
    fs.mkdirSync(path.dirname(hb), { recursive: true });
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(hb, JSON.stringify({
      ts: Date.now(), pid: process.pid,
      consecutiveMonitorFailures: 0, lastMonitorOkMs: Date.now() - 2000,
      hivecontrolBin: '/opt/dv/bin/hivecontrol', hivecontrolSource: 'env',
    }));
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));

    const r = runDoctor({ cwd, args: ['--fix'], env: { HOME: home, USERPROFILE: home } });
    assert.match(r.out, /skipped \[ingest\] ingest daemon installed and healthy/,
      'a genuinely draining daemon stays healthy:\n' + r.out);
    assert.doesNotMatch(r.out, /calls are FAILING/);
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

// ---------------------------------------------------------------------------
// heal-registry-rows (Claim 3 self-heal MIGRATION) — AUTO-SAFE, no DevSwarm
// gate needed (pure store read+write, no daemon/scheduler side effect).
// doctor-repair.js's own enumeration wiring around devswarm.js's exported
// healRegistry: sweeps every per-project store found via devswarm-store.js's
// listStoreHashes. The heal DECISION itself (rehomeMiskeyedRow) is already
// covered by devswarm-lifecycle.test.js's own Claim 3 tests — these tests
// prove the doctor INTEGRATION: enumeration across stores, idempotency
// through the runRepairs() entry point, dry-run never mutating, and a
// synthetic mis-keyed row rehomed with zero message loss.
// ---------------------------------------------------------------------------

// NOTE: no `backend` override anywhere below — doctor-repair.js's real
// heal-registry-rows call (dw.healRegistry(home, repoKey, { cwd, env })) never
// forces a backend either, so these tests must resolve the SAME auto-selected
// backend (sqlite when node:sqlite is available, journal otherwise) as the
// production code path, seed/verify through it consistently.
function seedRegistryRow(home, repoKey, desc) {
  const s = storeLib.openStore({ home, hash: repoKey });
  try { s.upsertRegistry(desc); } finally { s.close(); }
}

test('runRepairs: heal-registry-rows -> no DevSwarm store at all -> skipped, "0 store(s)", never creates one', () => {
  const home = mkTmp('heal-none');
  const cwd = makeGitRepo('heal-none-cwd');
  try {
    const results = repair.runRepairs({ cwd, env: {}, home, dryRun: false, platform: 'win32' });
    const r = results.find((x) => x.id === 'heal-registry-rows');
    assert.ok(r, 'a heal-registry-rows result must be present:\n' + JSON.stringify(results, null, 2));
    assert.strictEqual(r.status, 'skipped');
    assert.match(r.msg, /0 store\(s\)/);
    assert.ok(!storeDirExists(home), 'nothing to heal must never create a store dir');
  } finally { rm(home); rm(cwd); }
});

test('runRepairs: heal-registry-rows --dry-run reports the action and never mutates the store', () => {
  const home = mkTmp('heal-dry');
  const repoA = makeGitRepo('heal-dry-a');
  const repoB = makeGitRepo('heal-dry-b');
  try {
    const repoKeyA = repokey.repoKeyForWorktree(repoA);
    const reg = cli.run(['register', 'z', '--worktree', repoB, '--session', 's2'], { home, env: {}, cwd: repoB });
    assert.strictEqual(reg.result.ok, true);
    // A stray copy of 'z' also physically lives in store A (mis-keyed).
    seedRegistryRow(home, repoKeyA, { id: 'z', worktreePath: repoB, sessionId: 's2' });

    const results = repair.runRepairs({ cwd: repoA, env: {}, home, dryRun: true, platform: 'win32' });
    const r = results.find((x) => x.id === 'heal-registry-rows');
    assert.ok(r, 'a heal-registry-rows result must be present:\n' + JSON.stringify(results, null, 2));
    assert.strictEqual(r.status, 'skipped');
    assert.match(r.msg, /\[dry-run\] would sweep/);

    const sA = storeLib.openStore({ home, hash: repoKeyA });
    try {
      assert.strictEqual((sA.listRegistry() || []).some((x) => x.id === 'z'), true, 'dry-run must never mutate the store — the stray row must still be there');
    } finally { sA.close(); }
  } finally { rm(home); rm(repoA); rm(repoB); }
});

test('runRepairs: heal-registry-rows REHOMES a synthetic mis-keyed row across per-project stores with ZERO message loss (real --fix run), then IS IDEMPOTENT on a second pass', () => {
  const home = mkTmp('heal-fix');
  const repoA = makeGitRepo('heal-fix-a');
  const repoB = makeGitRepo('heal-fix-b');
  try {
    const repoKeyA = repokey.repoKeyForWorktree(repoA);
    const repoKeyB = repokey.repoKeyForWorktree(repoB);

    // 'z' is correctly registered at repoB — its true, structural home.
    const reg = cli.run(['register', 'z', '--worktree', repoB, '--session', 's2'], { home, env: {}, cwd: repoB });
    assert.strictEqual(reg.result.ok, true);

    // A STRAY registry row for 'z' ALSO physically lives in store A — this is
    // the exact breakage class the migration heals — plus a pending message
    // that arrived into the WRONG bucket, which must survive intact.
    seedRegistryRow(home, repoKeyA, { id: 'z', worktreePath: repoB, sessionId: 's2' });
    const sA0 = storeLib.openStore({ home, hash: repoKeyA });
    try {
      sA0.appendMeshRow({
        workspaceId: 'z', ts: Date.now(), hash: 'doctor-stray-hash-1', body: 'doctor stray message',
        sender: 'someone', recipient: 'z', mtype: 'direct', urgency: 'normal', isHeartbeat: false,
      });
    } finally { sA0.close(); }

    const results = repair.runRepairs({ cwd: repoA, env: {}, home, dryRun: false, platform: 'win32' });
    const r = results.find((x) => x.id === 'heal-registry-rows');
    assert.ok(r, 'a heal-registry-rows result must be present:\n' + JSON.stringify(results, null, 2));
    assert.strictEqual(r.status, 'fixed', JSON.stringify(r));
    assert.match(r.msg, /rehomed 1/);
    assert.match(r.msg, /z@/, 'the healed row id + its (wrong) store key must be reported: ' + r.msg);

    const sA = storeLib.openStore({ home, hash: repoKeyA });
    try {
      assert.strictEqual((sA.listRegistry() || []).some((x) => x.id === 'z'), false, 'the mis-keyed registry row must be gone from the wrong store');
    } finally { sA.close(); }
    const sB = storeLib.openStore({ home, hash: repoKeyB });
    try {
      const msgs = sB.listMessages('z');
      assert.ok(msgs.some((m) => m.body === 'doctor stray message'), 'the stray message must have migrated into the correct store — zero loss');
      assert.ok((sB.listRegistry() || []).some((x) => x.id === 'z'), 'the registry row must now live in the correct store');
    } finally { sB.close(); }

    // Idempotency THROUGH THE DOCTOR ENTRY POINT: a second --fix pass over the
    // now-healed stores must heal/rehome nothing further.
    const second = repair.runRepairs({ cwd: repoA, env: {}, home, dryRun: false, platform: 'win32' });
    const r2 = second.find((x) => x.id === 'heal-registry-rows');
    assert.ok(r2, 'a heal-registry-rows result must be present on the second pass');
    assert.strictEqual(r2.status, 'skipped', 'a second pass over an already-healed set of stores must heal nothing further:\n' + JSON.stringify(r2));
    assert.match(r2.msg, /nothing mis-keyed\/stale/);
  } finally { rm(home); rm(repoA); rm(repoB); }
});

// ---------------------------------------------------------------------------
// wake-monitor (Monitor-based idle-wake) — REPORT-ONLY, mirrors the reaper
// block. Arming requires the agent-only `Monitor` tool, so this NEVER
// registers a migrationFix (a hook/CLI cannot call that tool) — status is
// ALWAYS 'skipped', regardless of shipped/live state; only the message
// changes. Reuses doctor-devswarm.js's own wakeMonitorShipped/
// wakeMonitorLiveCheck (verified directly in tests/companion/doctor-
// devswarm.test.js) so this is purely a wiring test: the entry exists, is
// always status:'skipped', and never becomes 'fixed'/'gated'/'failed'.
// ---------------------------------------------------------------------------
test('wake-monitor: REPORT-ONLY entry present on a plain --dry-run pass, status always "skipped" (never a fake auto-fix)', () => {
  const home = mkTmp('wakemon-report');
  const repo = makeGitRepo('wakemon-report');
  try {
    const results = repair.runRepairs({ cwd: repo, env: {}, home, dryRun: true, platform: 'win32' });
    const r = results.find((x) => x.id === 'wake-monitor');
    assert.ok(r, 'a wake-monitor result must be present:\n' + JSON.stringify(results, null, 2));
    assert.strictEqual(r.action, 'none', 'no action is ever registered — never a migrationFix');
    assert.strictEqual(r.status, 'skipped');
    assert.match(r.msg, /wake-monitor/);
  } finally { rm(home); rm(repo); }
});

test('wake-monitor: REPORT-ONLY entry present even on a real (non-dry-run) pass, status stays "skipped"', () => {
  const home = mkTmp('wakemon-report-real');
  const repo = makeGitRepo('wakemon-report-real');
  try {
    const results = repair.runRepairs({ cwd: repo, env: { DEVSWARM_REPO_ID: 'r1' }, home, dryRun: false, platform: 'win32' });
    const r = results.find((x) => x.id === 'wake-monitor');
    assert.ok(r, 'a wake-monitor result must be present');
    assert.strictEqual(r.status, 'skipped', 'wake-monitor never reports fixed/gated/failed — it can never actually arm anything');
  } finally { rm(home); rm(repo); }
});

test('wake-monitor: reports the exact manual arm command when shipped but not live (DevSwarm-active session)', () => {
  const home = mkTmp('wakemon-report-armcmd');
  const repo = makeGitRepo('wakemon-report-armcmd');
  try {
    // P2 fix regression guard: the wake-monitor block now sits behind the same
    // gateOpen every neighbouring DevSwarm repair uses, so the real
    // shipped/live check (and its git-spawning identity resolution) only runs
    // for a DevSwarm-active session — hence DEVSWARM_REPO_ID here.
    const results = repair.runRepairs({ cwd: repo, env: { DEVSWARM_REPO_ID: 'r1' }, home, dryRun: true, platform: 'win32' });
    const r = results.find((x) => x.id === 'wake-monitor');
    assert.ok(r);
    // On a real checkout of this repo the watcher is genuinely shipped; no
    // lock was seeded under this throwaway `home`, so it must report NOT
    // live and hand back the exact `Monitor`-tool arm command.
    assert.match(r.msg, /NOT live|could not resolve/);
    assert.match(r.msg, /Monitor.*tool/);
  } finally { rm(home); rm(repo); }
});

test('wake-monitor: gate CLOSED (non-DevSwarm session) never spawns the live-check or tells the user to arm it', () => {
  const home = mkTmp('wakemon-gated');
  const repo = makeGitRepo('wakemon-gated');
  try {
    const results = repair.runRepairs({ cwd: repo, env: {}, home, dryRun: true, platform: 'win32' });
    const r = results.find((x) => x.id === 'wake-monitor');
    assert.ok(r, 'a wake-monitor result must still be present (report-only entry), just gated');
    assert.strictEqual(r.action, 'none');
    assert.strictEqual(r.status, 'skipped');
    assert.doesNotMatch(r.msg, /arm it/, 'a non-DevSwarm session must never be told to arm the wake-monitor');
    assert.doesNotMatch(r.msg, /NOT live/, 'gate-closed must never run the live-check at all');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// 9. install-vs-source integrity (CHECK 1: install-divergence, CHECK 2:
// monitors-json) — REPORT-ONLY, UNGATED (unlike wake-monitor above, these are
// not DevSwarm-specific: they run regardless of gateOpen/DevSwarm-active
// state, same posture as the reaper report-only block). Reuses doctor-
// devswarm.js's installDivergenceCheck/monitorsJsonPresenceCheck so this can
// never drift from the doctor-diagnostic verdict computed the same way.
// ---------------------------------------------------------------------------

test('install-divergence + monitors-json: present regardless of DevSwarm gate state (non-DevSwarm session)', () => {
  const home = mkTmp('installdiv-ungated');
  const repo = makeGitRepo('installdiv-ungated-cwd');
  try {
    // No ANTIHALL_MARKETPLACE_DIR and no real ~/.claude/plugins/marketplaces
    // under this throwaway home -> the marketplace clone genuinely absent.
    const results = repair.runRepairs({ cwd: repo, env: {}, home, dryRun: true, platform: 'win32' });
    const divergence = results.find((x) => x.id === 'install-divergence');
    const monitorsJson = results.find((x) => x.id === 'monitors-json');
    assert.ok(divergence, 'an install-divergence result must be present even in a non-DevSwarm session:\n' + JSON.stringify(results, null, 2));
    assert.ok(monitorsJson, 'a monitors-json result must be present even in a non-DevSwarm session');
    assert.strictEqual(divergence.action, 'none');
    assert.strictEqual(divergence.status, 'skipped');
    assert.match(divergence.msg, /no marketplace clone present — nothing to compare/, 'no clone under this fixture home -> clean no-op:\n' + divergence.msg);
    assert.strictEqual(monitorsJson.action, 'none');
    assert.strictEqual(monitorsJson.status, 'skipped');
    // PLUGIN_ROOT here is the REAL, checked-out plugin tree (doctor-repair.js's
    // own installed root), which genuinely ships monitors/monitors.json.
    assert.match(monitorsJson.msg, /present in the installed plugin root/, monitorsJson.msg);
  } finally { rm(home); rm(repo); }
});

test('install-divergence: a REAL marketplace clone with divergent watcher content at the SAME version as the installed root -> DETECTED', () => {
  const home = mkTmp('installdiv-detect');
  const repo = makeGitRepo('installdiv-detect-cwd');
  const mpBase = mkTmp('installdiv-detect-mp');
  try {
    // Build a marketplace clone fixture SAME-SHAPED as the real installed
    // root (doctor-repair.js's own PLUGIN_ROOT) but with a divergent watcher
    // and the SAME version — the exact shape of a cache dir populated
    // mid-release that syncCache will never overwrite.
    const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugins', 'anti-hall');
    const realVersion = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    const mpPluginDir = path.join(mpBase, 'plugins', 'anti-hall');
    fs.cpSync(PLUGIN_ROOT, mpPluginDir, { recursive: true });
    fs.mkdirSync(path.join(mpPluginDir, 'companion', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(mpPluginDir, 'companion', 'lib', 'devswarm-wake-watch.js'), '// FINAL post-fix watcher, different from installed\n');

    const results = repair.runRepairs({ cwd: repo, env: { ANTIHALL_MARKETPLACE_DIR: mpBase }, home, dryRun: true, platform: 'win32' });
    const divergence = results.find((x) => x.id === 'install-divergence');
    assert.ok(divergence);
    assert.match(divergence.msg, /DIFFERS from the marketplace clone at the SAME version/, divergence.msg);
    assert.match(divergence.msg, new RegExp(realVersion.replace(/\./g, '\\.')));
    assert.match(divergence.msg, /version bump is required/);
  } finally { rm(home); rm(repo); rm(mpBase); }
});

// ---------------------------------------------------------------------------
// Codex "is it wired" upgrade regression — a prior version of scanCodex()
// (and doctor.js's read-only mirror) used a COARSE "does the
// '/plugins/anti-hall/hooks/' fragment appear ANYWHERE in hooks.json" test.
// That made an EXISTING Codex install with only the OLDER event set (missing
// a newly-added event, e.g. the PostToolUse reply-tracker hook) still match
// on its older events and get reported "already wired" — so `doctor --fix`
// never re-ran the installer to add the new event, leaving the user
// permanently under-wired across upgrades. scanCodex() now requires EVERY
// event key in install-codex.js's ANTI_HALL_HOOKS to have a matching
// anti-hall-owned group actually present, so a missing event is caught.
// ---------------------------------------------------------------------------
const CODEX_INSTALLER_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'codex', 'install-codex.js');

// buildCodexHooksFixture(dir, {dropEvents}) — writes a .codex/config.toml +
// hooks.json into `dir` by actually running the REAL installer (so every
// anti-hall-owned group is byte-identical to what a real install produces),
// then optionally deletes given event keys entirely to simulate an OLDER
// install that pre-dates those events.
function buildCodexHooksFixture(dir, { dropEvents = [] } = {}) {
  const r = cp.spawnSync(process.execPath, [CODEX_INSTALLER_JS], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'fixture installer run failed: ' + (r.stderr || r.stdout));
  const hooksPath = path.join(dir, '.codex', 'hooks.json');
  if (dropEvents.length) {
    const cfg = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    for (const ev of dropEvents) delete cfg.hooks[ev];
    fs.writeFileSync(hooksPath, JSON.stringify(cfg, null, 2) + '\n');
  }
  return hooksPath;
}

test('scanCodex: fresh install with the FULL current event set -> wired true (no regression on the fully-wired case)', () => {
  const cwd = mkTmp('codex-scan-fresh');
  const home = mkTmp('codex-scan-fresh-home');
  try {
    buildCodexHooksFixture(cwd, {});
    const scan = repair.scanCodex(cwd, home);
    const project = scan.find((s) => s.label === 'project');
    assert.ok(project, 'expected a project-scope scan result:\n' + JSON.stringify(scan));
    assert.strictEqual(project.wired, true, 'a freshly installed hooks.json (every current event) must report wired:true');
  } finally { rm(cwd); rm(home); }
});

test('scanCodex: OLDER install missing the newly-added PostToolUse event -> wired false (upgrade must be detected, not silently "already wired")', () => {
  const cwd = mkTmp('codex-scan-stale');
  const home = mkTmp('codex-scan-stale-home');
  try {
    // Simulate a pre-upgrade install: SessionStart/UserPromptSubmit/PreToolUse/
    // Stop are registered (the OLD event set) but PostToolUse — added later for
    // devswarm-parent-reply-tracker.js — never got wired because it didn't
    // exist yet at install time.
    buildCodexHooksFixture(cwd, { dropEvents: ['PostToolUse'] });
    const scan = repair.scanCodex(cwd, home);
    const project = scan.find((s) => s.label === 'project');
    assert.ok(project);
    assert.strictEqual(project.wired, false, 'missing the PostToolUse event must report wired:false, not true (this was the bug — a coarse substring test matched on the surviving older events)');
  } finally { rm(cwd); rm(home); }
});

test('doctor --fix: fresh/fully-wired Codex install -> reports "already wired", does NOT spuriously re-run the installer', () => {
  const home = mkTmp('codex-fix-fresh-home');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-repair-codex-fix-fresh-cwd-'));
  try {
    seedUserSettings(home, { command: 'custom-noop' }); // custom SL so the unrelated statusline repair never fails this test
    buildCodexHooksFixture(cwd, {});
    const before = fs.readFileSync(path.join(cwd, '.codex', 'hooks.json'), 'utf8');
    const r = runDoctor({ cwd, args: ['--fix'], env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /anti-hall codex hooks already wired \(project\)/, r.out);
    const after = fs.readFileSync(path.join(cwd, '.codex', 'hooks.json'), 'utf8');
    assert.strictEqual(after, before, 'a fully-wired install must not be rewritten by --fix');
  } finally { rm(home); rm(cwd); }
});

test('doctor --fix: EXISTING Codex install upgraded past a new hook event -> re-runs the installer and adds the missing PostToolUse hook (regression for the unbounded-Stop-block bug)', () => {
  const home = mkTmp('codex-fix-upgrade-home');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-repair-codex-fix-upgrade-cwd-'));
  try {
    seedUserSettings(home, { command: 'custom-noop' }); // custom SL so the unrelated statusline repair never fails this test
    buildCodexHooksFixture(cwd, { dropEvents: ['PostToolUse'] });
    const hooksPath = path.join(cwd, '.codex', 'hooks.json');
    const beforeCfg = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.strictEqual(beforeCfg.hooks.PostToolUse, undefined, 'fixture setup sanity: PostToolUse must be absent before repair');

    const r = runDoctor({ cwd, args: ['--fix'], env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, r.out);
    // Must NOT claim "already wired" for a scope that was missing an event —
    // it must report the installer actually ran and re-wired it.
    assert.doesNotMatch(r.out, /anti-hall codex hooks already wired \(project\)/, r.out);
    assert.match(r.out, /wired anti-hall codex hooks \(project\)/, r.out);

    const afterCfg = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const postCommands = (afterCfg.hooks.PostToolUse || []).flatMap((g) => (g.hooks || []).map((h) => h.command));
    assert.ok(postCommands.some((c) => /devswarm-parent-reply-tracker\.js/.test(c)), 'the missing PostToolUse reply-tracker hook must be added by the repair-triggered re-install:\n' + JSON.stringify(afterCfg.hooks, null, 2));

    // The pre-existing (older) events must survive the re-install untouched in
    // shape (mergeHooks() is additive per-event — re-running the installer on
    // an existing install must not clobber events it already knew about).
    const preCommands = (afterCfg.hooks.PreToolUse || []).flatMap((g) => (g.hooks || []).map((h) => h.command));
    assert.ok(preCommands.some((c) => /git-guard\.js/.test(c)), 'pre-existing PreToolUse hooks must survive the repair-triggered re-install');
  } finally { rm(home); rm(cwd); }
});

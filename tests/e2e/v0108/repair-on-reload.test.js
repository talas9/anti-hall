'use strict';
// v0.108.0 contract 4 — repair-on-reload (hooks/repair-on-reload.js, on
// SessionStart AND UserPromptSubmit): when any DEFAULT migration is not yet
// stamped for the RUNNING plugin version, spawn ONE detached
// `doctor.js --repair --quiet` and return immediately; when every migration
// is stamped for the running version, it is a no-op that touches nothing.
//
// The "already repaired" record is the SAME per-migration marker store that
// migrations.js / update.js / doctor share (~/.anti-hall/update-sweep-state.json,
// `{<key>: {completedVersion}}`) — the hook keeps no second version stamp.
// The detached doctor --repair run happens against the isolated fixture HOME
// (its installers dry-run under a tmp HOME); each test kills the child it
// spawned.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeHome, rm, runHook, antiHallDir } = require('./lib.js');

const REPO = path.join(__dirname, '..', '..', '..');
const migrations = require(path.join(REPO, 'plugins', 'anti-hall', 'companion', 'lib', 'migrations.js'));
const RUNNING_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'plugins', 'anti-hall', '.claude-plugin', 'plugin.json'), 'utf8')).version;

const HOOK = 'repair-on-reload.js';
const SESSION_START = { hook_event_name: 'SessionStart', session_id: 'sess-ror-1' };
const PROMPT = { hook_event_name: 'UserPromptSubmit', session_id: 'sess-ror-1', prompt: 'hi' };

function lockFile(home) { return path.join(antiHallDir(home), 'repair-on-reload.lock'); }
function logsDir(home) { return path.join(antiHallDir(home), 'logs'); }
function markAll(home, version) {
  const state = {};
  for (const m of migrations.defaultMigrations()) state[m.key] = { completedVersion: version, completedTs: Date.now() };
  fs.mkdirSync(antiHallDir(home), { recursive: true });
  fs.writeFileSync(path.join(antiHallDir(home), 'update-sweep-state.json'), JSON.stringify(state));
}
function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  let v = fn();
  while (!v && Date.now() < deadline) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); v = fn(); }
  return v;
}
function killLockHolder(home) {
  try { const l = JSON.parse(fs.readFileSync(lockFile(home), 'utf8')); if (Number.isInteger(l.pid)) process.kill(l.pid, 'SIGKILL'); } catch (_) { /* gone */ }
}
function repairLog(home) {
  try { return fs.readdirSync(logsDir(home)).find((f) => f.startsWith('repair-on-reload-')) || null; } catch (_) { return null; }
}

test('markers stamped for an OLDER version (plugin updated/reloaded) => one detached repair, hook returns fast', () => {
  const home = makeHome();
  try {
    markAll(home, '0.1.0');
    const start = Date.now();
    const r = runHook(HOOK, SESSION_START, home);
    const elapsed = Date.now() - start;
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), '', 'the hook never injects context');
    assert.ok(elapsed < 5000, `hook took ${elapsed}ms; the repair must be detached, not inline`);
    assert.ok(fs.existsSync(lockFile(home)), 'a pending repair takes the lock');
    assert.ok(waitFor(() => repairLog(home), 3000), 'the detached doctor --repair run writes its log');
    killLockHolder(home);
  } finally { rm(home); }
});

test('first-ever session (no marker store at all) => a repair is triggered', () => {
  const home = makeHome();
  try {
    const r = runHook(HOOK, SESSION_START, home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(waitFor(() => repairLog(home), 3000), 'every default migration is pending -> repair spawned');
    killLockHolder(home);
  } finally { rm(home); }
});

test('UserPromptSubmit after a /reload-plugins takes the same path (the reload fallback)', () => {
  const home = makeHome();
  try {
    markAll(home, '0.1.0');
    const r = runHook(HOOK, PROMPT, home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(waitFor(() => repairLog(home), 3000));
    killLockHolder(home);
  } finally { rm(home); }
});

test('every migration stamped for the running version => no-op: no lock, no spawn, and cheap', () => {
  const home = makeHome();
  try {
    markAll(home, RUNNING_VERSION);
    // Budget the hook's OWN work: subtract a bare `node` startup measured the
    // same way, so machine load / node boot time is not charged to the hook.
    const t0 = Date.now();
    spawnSync(process.execPath, ['-e', ''], { env: { PATH: process.env.PATH, HOME: home } });
    const baseline = Date.now() - t0;
    const start = Date.now();
    const r = runHook(HOOK, SESSION_START, home);
    const elapsed = Date.now() - start;
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.existsSync(lockFile(home)), false, 'no-op path never touches the lock');
    assert.strictEqual(repairLog(home), null, 'no-op path never spawns a repair');
    assert.ok(elapsed - baseline < 150, `no-op path cost ${elapsed - baseline}ms over a bare node start (${baseline}ms)`);
  } finally { rm(home); }
});

test('ANTIHALL_REPAIR_ON_RELOAD=off disables the hook even with repairs pending', () => {
  const home = makeHome();
  try {
    const r = runHook(HOOK, SESSION_START, home, { ANTIHALL_REPAIR_ON_RELOAD: 'off' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.existsSync(lockFile(home)), false);
    assert.strictEqual(repairLog(home), null);
  } finally { rm(home); }
});

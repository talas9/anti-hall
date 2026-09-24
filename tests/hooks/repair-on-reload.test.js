'use strict';
// repair-on-reload.js (SessionStart + UserPromptSubmit fallback) — item E
// (v0.107.1): "an update OR a reload of the plugin must always fix corrupt or
// stale data." Before this hook, repairs only ran via update.js or a manual
// `doctor --repair`; a plain /reload-plugins, a new session on a new version,
// or an update applied by the plugin manager without our own script ran none
// of them. This hook derives "repair pending" cheaply from the SAME
// per-migration marker store migrations.js/update.js/doctor already share,
// and — only when something is pending and no repair is already in flight —
// spawns `doctor.js --repair --migrations-only --quiet` DETACHED, never
// blocking the turn.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const migrations = require('../../plugins/anti-hall/companion/lib/migrations.js');

const HOOK = 'repair-on-reload.js';
const PLUGIN_JSON = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', '.claude-plugin', 'plugin.json');
const RUNNING_VERSION = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).version;

function sessionStartPayload() { return { hook_event_name: 'SessionStart', session_id: 't' }; }
function userPromptPayload(extra) { return Object.assign({ hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi' }, extra || {}); }

function lockFile(home) { return path.join(home, '.anti-hall', 'repair-on-reload.lock'); }
function logsDir(home) { return path.join(home, '.anti-hall', 'logs'); }

// markAllComplete(home): stamp every DEFAULT migration as completed for the
// CURRENT running version — the exact shape repairPending() must read as
// "nothing pending".
function markAllComplete(home) {
  const state = {};
  for (const m of migrations.defaultMigrations()) {
    state[m.key] = { completedVersion: RUNNING_VERSION, completedTs: Date.now() };
  }
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  fs.writeFileSync(path.join(home, '.anti-hall', 'update-sweep-state.json'), JSON.stringify(state), 'utf8');
}

// waitFor(fn, timeoutMs) -> polls fn() until truthy or timeout; returns the
// last (possibly falsy) value. Used only to observe the DETACHED child's
// side effects (log file appearing) without making the test itself slow.
function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let v = fn();
  while (!v && Date.now() < deadline) {
    // Tiny synchronous sleep via Atomics — no setTimeout needed in a sync test.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    v = fn();
  }
  return v;
}

function killIfAlive(pid) {
  if (!Number.isInteger(pid)) return;
  try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already dead */ }
}

test('same version, everything applied = no-op: no lock, no spawn, exits 0', () => {
  const h = makeHome();
  try {
    markAllComplete(h.home);
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.strictEqual(fs.existsSync(lockFile(h.home)), false, 'no-op path must never touch the lock file');
    assert.strictEqual(fs.existsSync(logsDir(h.home)), false, 'no-op path must never spawn a repair (no logs dir)');
  } finally { h.cleanup(); }
});

test('version change (nothing marked complete) triggers exactly one detached repair run', () => {
  const h = makeHome();
  try {
    // No update-sweep-state.json at all => every default migration is pending.
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.strictEqual(fs.existsSync(lockFile(h.home)), true, 'a pending repair must acquire the lock');
    const lock = JSON.parse(fs.readFileSync(lockFile(h.home), 'utf8'));
    assert.ok(Number.isInteger(lock.pid), 'lock must record a pid');

    // Observe the detached child actually started (its log file appears).
    const dir = logsDir(h.home);
    const found = waitFor(() => {
      try { return fs.readdirSync(dir).find((f) => f.startsWith('repair-on-reload-')); } catch (_) { return null; }
    }, 3000);
    assert.ok(found, 'expected a repair-on-reload-*.log to appear from the detached doctor.js --repair run');

    killIfAlive(lock.pid); // cleanup: this was a REAL doctor.js --repair against a throwaway fixture home
  } finally { h.cleanup(); }
});

test('lock held by a LIVE pid = skip (no second spawn)', () => {
  const h = makeHome();
  try {
    fs.mkdirSync(path.join(h.home, '.anti-hall'), { recursive: true });
    // This TEST process's own pid is definitely alive.
    fs.writeFileSync(lockFile(h.home), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.strictEqual(fs.existsSync(logsDir(h.home)), false, 'a live-held lock must never let a second repair spawn');
    const lock = JSON.parse(fs.readFileSync(lockFile(h.home), 'utf8'));
    assert.strictEqual(lock.pid, process.pid, 'the live lock must be left untouched, not stolen');
  } finally { h.cleanup(); }
});

test('lock held by a DEAD pid is reclaimed and a repair spawns', () => {
  const h = makeHome();
  try {
    fs.mkdirSync(path.join(h.home, '.anti-hall'), { recursive: true });
    // A pid that is astronomically unlikely to be alive on this machine.
    fs.writeFileSync(lockFile(h.home), JSON.stringify({ pid: 999999, startedAt: Date.now() - 999999 }), 'utf8');
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    const dir = logsDir(h.home);
    const found = waitFor(() => {
      try { return fs.readdirSync(dir).find((f) => f.startsWith('repair-on-reload-')); } catch (_) { return null; }
    }, 3000);
    assert.ok(found, 'a dead-pid lock must be reclaimed and a repair spawned');
    const lock = JSON.parse(fs.readFileSync(lockFile(h.home), 'utf8'));
    killIfAlive(lock.pid);
  } finally { h.cleanup(); }
});

test('subagent/sidechain payload (agent_id present) = skip, even with a pending repair', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, userPromptPayload({ agent_id: 'sub-1', agent_type: 'general-purpose' }), { home: h.home });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.strictEqual(fs.existsSync(lockFile(h.home)), false, 'a subagent payload must never acquire the lock');
    assert.strictEqual(fs.existsSync(logsDir(h.home)), false, 'a subagent payload must never spawn a repair');
  } finally { h.cleanup(); }
});

test('ANTIHALL_REPAIR_ON_RELOAD=off disables the hook entirely', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home, env: { ANTIHALL_REPAIR_ON_RELOAD: 'off' } });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.strictEqual(fs.existsSync(lockFile(h.home)), false);
  } finally { h.cleanup(); }
});

test('skip.json repair-on-reload key disables the hook (fail-open escape hatch)', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'repair-on-reload': Date.now() + 60000 });
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.strictEqual(fs.existsSync(lockFile(h.home)), false);
  } finally { h.cleanup(); }
});

// PERFORMANCE (item E requirement): the no-op path must stay well under the
// ~50ms budget — measured here, not merely asserted. CI machines vary, so the
// bound is generous (10x) while still catching a gross regression (e.g. an
// accidental store scan on every turn).
test('PERFORMANCE: no-op path (nothing pending) completes in well under 500ms', () => {
  const h = makeHome();
  try {
    markAllComplete(h.home);
    const t0 = Date.now();
    const r = testHook(HOOK, userPromptPayload(), { home: h.home });
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(elapsed < 500, `no-op path took ${elapsed}ms (includes node startup) — expected comfortably under 500ms`);
  } finally { h.cleanup(); }
});

// resolveDoctorJs (P0 follow-up): this hook's own __dirname is bound to
// whichever cache-version dir the harness loaded for the CURRENT session —
// which can lag a version already synced into the cache by a prior update.js
// run (same staleness class as the update.js re-exec fix). Spawning that
// stale doctor.js would run an OLD repair/migration set. It must resolve to
// the NEWEST semver-named dir under ~/.claude/plugins/cache/anti-hall/anti-hall.
test('spawns the NEWEST cache version\'s doctor.js, not this running hook\'s own sibling copy', () => {
  const h = makeHome();
  try {
    const cacheRoot = path.join(h.home, '.claude', 'plugins', 'cache', 'anti-hall', 'anti-hall');
    const markerPath = path.join(h.home, 'newest-doctor-ran.marker');
    for (const v of ['9.0.0', '9.9.9', 'not-a-version']) {
      fs.mkdirSync(path.join(cacheRoot, v, 'hooks'), { recursive: true });
    }
    // The NEWEST (9.9.9) fake doctor.js writes a distinctive marker; the OLDER
    // (9.0.0) one writes a DIFFERENT marker — proves which one actually ran.
    fs.writeFileSync(path.join(cacheRoot, '9.9.9', 'hooks', 'doctor.js'),
      "require('fs').writeFileSync(" + JSON.stringify(markerPath) + ", 'newest'); process.exit(0);\n", 'utf8');
    fs.writeFileSync(path.join(cacheRoot, '9.0.0', 'hooks', 'doctor.js'),
      "require('fs').writeFileSync(" + JSON.stringify(markerPath) + ", 'older'); process.exit(0);\n", 'utf8');

    const r = testHook(HOOK, sessionStartPayload(), { home: h.home });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);

    const marker = waitFor(() => {
      try { return fs.readFileSync(markerPath, 'utf8'); } catch (_) { return null; }
    }, 3000);
    assert.strictEqual(marker, 'newest', 'the NEWEST cache version\'s doctor.js must be the one spawned, not the older one or this hook\'s own sibling copy');
  } finally { h.cleanup(); }
});

// P1a (0.108.0 audit): the reload hook runs ONLY the stamped data migrations
// (`doctor.js --repair --migrations-only`). A full `doctor --repair` would
// install the statusLine into ~/.claude/settings.json and Codex hooks +
// `[features] hooks = true` into ~/.codex on an unasked first session — that
// stays behind a user-typed `doctor --repair`. The REAL doctor.js runs here
// against a scratch HOME; the test waits for the detached child to exit and
// then proves every file outside ~/.anti-hall is byte-identical.
test('P1a: reload repair touches nothing outside ~/.anti-hall (theme-only settings.json + bare config.toml stay byte-identical)', () => {
  const h = makeHome();
  try {
    const settingsPath = path.join(h.home, '.claude', 'settings.json');
    const tomlPath = path.join(h.home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
    const settingsBefore = '{"theme":"dark"}\n';
    const tomlBefore = '[model]\nname = "x"\n';
    fs.writeFileSync(settingsPath, settingsBefore, 'utf8');
    fs.writeFileSync(tomlPath, tomlBefore, 'utf8');
    const listOutside = () => {
      const out = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (p === path.join(h.home, '.anti-hall')) continue;
          if (e.isDirectory()) walk(p); else out.push(path.relative(h.home, p));
        }
      };
      walk(h.home);
      return out.sort();
    };
    const filesBefore = listOutside();

    const r = testHook(HOOK, sessionStartPayload(), { home: h.home, env: { ANTIHALL_INGEST_DRY_RUN: '1' } });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    const lock = JSON.parse(fs.readFileSync(lockFile(h.home), 'utf8'));
    const exited = waitFor(() => { try { process.kill(lock.pid, 0); return false; } catch (_) { return true; } }, 30000);
    assert.ok(exited, 'the detached migrations-only child must finish');
    const logName = fs.readdirSync(logsDir(h.home)).find((f) => f.startsWith('repair-on-reload-'));
    const log = fs.readFileSync(path.join(logsDir(h.home), logName), 'utf8');
    assert.match(log, /"action":"migrations-only"/, 'the child must be the migrations-only doctor pass: ' + log.slice(0, 300));

    assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), settingsBefore, '~/.claude/settings.json must be byte-identical (no statusLine install)');
    assert.strictEqual(fs.readFileSync(tomlPath, 'utf8'), tomlBefore, '~/.codex/config.toml must be byte-identical (no [features] hooks)');
    assert.deepStrictEqual(listOutside(), filesBefore, 'no new file outside ~/.anti-hall (no codex hooks.json, no .bak)');
  } finally { h.cleanup(); }
});

// A cache dir OLDER than the running version (a dev/--plugin-dir run whose
// cache still holds a previous release) must never be picked: that doctor.js
// predates --migrations-only and would run the full repair instead.
test('never spawns a cache doctor.js OLDER than the running version (falls back to its own sibling)', () => {
  const h = makeHome();
  try {
    const cacheRoot = path.join(h.home, '.claude', 'plugins', 'cache', 'anti-hall', 'anti-hall');
    const markerPath = path.join(h.home, 'old-doctor-ran.marker');
    fs.mkdirSync(path.join(cacheRoot, '0.0.1', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, '0.0.1', 'hooks', 'doctor.js'),
      "require('fs').writeFileSync(" + JSON.stringify(markerPath) + ", 'old'); process.exit(0);\n", 'utf8');
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home, env: { ANTIHALL_INGEST_DRY_RUN: '1' } });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    const lock = JSON.parse(fs.readFileSync(lockFile(h.home), 'utf8'));
    waitFor(() => { try { process.kill(lock.pid, 0); return false; } catch (_) { return true; } }, 30000);
    assert.strictEqual(fs.existsSync(markerPath), false, 'the older cache doctor.js must not be the one spawned');
    const logName = fs.readdirSync(logsDir(h.home)).find((f) => f.startsWith('repair-on-reload-'));
    assert.match(fs.readFileSync(path.join(logsDir(h.home), logName), 'utf8'), /"action":"migrations-only"/);
  } finally { h.cleanup(); }
});

// ---- P1b (0.108.0 audit): the reload loop ---------------------------------
// The hook checked stamps against ITS version but spawned the NEWEST cache's
// doctor, which stamps a NEWER version — so every prompt respawned doctor, with
// no cooldown and one leaked log per spawn.

function bumpMinor(v) { const p = v.split('.').map(Number); return p[0] + '.' + (p[1] + 1) + '.0'; }

// fakeDoctor(dir, counter, stampVersion): a doctor.js that counts its runs and
// (when stampVersion is set) stamps every default migration at that version,
// like a real newer doctor would.
function fakeDoctor(dir, counter, stampVersion) {
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  const keys = migrations.defaultMigrations().map((m) => m.key);
  fs.writeFileSync(path.join(dir, 'hooks', 'doctor.js'),
    "const fs=require('fs'),path=require('path'),os=require('os');\n"
    + 'fs.appendFileSync(' + JSON.stringify(counter) + ", 'run\\n');\n"
    + (stampVersion
      ? 'const st={};for(const k of ' + JSON.stringify(keys) + ')st[k]={completedVersion:' + JSON.stringify(stampVersion) + ',completedTs:Date.now()};\n'
        + "fs.writeFileSync(path.join(os.homedir(),'.anti-hall','update-sweep-state.json'),JSON.stringify(st));\n"
      : ''),
    'utf8');
}
function runs(counter) { try { return fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length; } catch (_) { return 0; } }
function waitChild(home) {
  let pid = null;
  try { pid = JSON.parse(fs.readFileSync(lockFile(home), 'utf8')).pid; } catch (_) { return; }
  waitFor(() => { try { process.kill(pid, 0); return false; } catch (_) { return true; } }, 10000);
}

test('P1b: cache dirs <running> + <newer>, 3 hook runs -> exactly 1 doctor spawn', () => {
  const h = makeHome();
  try {
    const cacheRoot = path.join(h.home, '.claude', 'plugins', 'cache', 'anti-hall', 'anti-hall');
    const counter = path.join(h.home, 'doctor-runs.txt');
    const newer = bumpMinor(RUNNING_VERSION);
    fakeDoctor(path.join(cacheRoot, RUNNING_VERSION), counter, RUNNING_VERSION);
    fakeDoctor(path.join(cacheRoot, newer), counter, newer);
    for (let i = 0; i < 3; i++) {
      const r = testHook(HOOK, userPromptPayload(), { home: h.home });
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      waitChild(h.home);
    }
    assert.strictEqual(runs(counter), 1, 'three prompts must spawn doctor exactly once');
  } finally { h.cleanup(); }
});

test('P1b: stamps at a NEWER version than the running one count as done (no spawn, no cooldown needed)', () => {
  const h = makeHome();
  try {
    const state = {};
    for (const m of migrations.defaultMigrations()) state[m.key] = { completedVersion: bumpMinor(RUNNING_VERSION), completedTs: Date.now() };
    fs.writeFileSync(path.join(h.home, '.anti-hall', 'update-sweep-state.json'), JSON.stringify(state), 'utf8');
    const r = testHook(HOOK, userPromptPayload(), { home: h.home });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.strictEqual(fs.existsSync(lockFile(h.home)), false, 'a newer stamp is done: no lock, no spawn');
    assert.strictEqual(fs.existsSync(logsDir(h.home)), false);
  } finally { h.cleanup(); }
});

test('P1b: a repair that never completes spawns at most once per hour (cooldown after any run)', () => {
  const h = makeHome();
  try {
    const cacheRoot = path.join(h.home, '.claude', 'plugins', 'cache', 'anti-hall', 'anti-hall');
    const counter = path.join(h.home, 'doctor-runs.txt');
    fakeDoctor(path.join(cacheRoot, RUNNING_VERSION), counter, null); // stamps nothing
    for (let i = 0; i < 2; i++) { testHook(HOOK, userPromptPayload(), { home: h.home }); waitChild(h.home); }
    assert.strictEqual(runs(counter), 1, 'second prompt within the hour must not respawn');
    // An hour later the cooldown has elapsed.
    const cd = path.join(h.home, '.anti-hall', 'repair-on-reload.last.json');
    fs.writeFileSync(cd, JSON.stringify({ ts: Date.now() - 61 * 60 * 1000 }), 'utf8');
    testHook(HOOK, userPromptPayload(), { home: h.home }); waitChild(h.home);
    assert.strictEqual(runs(counter), 2, 'after the cooldown a still-pending repair runs again');
  } finally { h.cleanup(); }
});

test('P1b: only the newest 5 repair-on-reload logs are kept; other logs untouched', () => {
  const h = makeHome();
  try {
    const dir = logsDir(h.home);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 7; i++) fs.writeFileSync(path.join(dir, 'repair-on-reload-' + (1000 + i) + '.log'), 'old');
    fs.writeFileSync(path.join(dir, 'other.log'), 'keep');
    const cacheRoot = path.join(h.home, '.claude', 'plugins', 'cache', 'anti-hall', 'anti-hall');
    fakeDoctor(path.join(cacheRoot, RUNNING_VERSION), path.join(h.home, 'c.txt'), null);
    testHook(HOOK, userPromptPayload(), { home: h.home }); waitChild(h.home);
    const left = fs.readdirSync(dir).filter((f) => f.startsWith('repair-on-reload-')).sort();
    assert.strictEqual(left.length, 5, 'exactly 5 logs remain: ' + left.join(','));
    assert.ok(!left.includes('repair-on-reload-1001.log') && !left.includes('repair-on-reload-1003.log'), 'the oldest are pruned');
    assert.ok(fs.existsSync(path.join(dir, 'other.log')), 'unrelated logs are never touched');
  } finally { h.cleanup(); }
});

'use strict';
// devswarm-wake-watch.js — WATCHER HANDOFF (re-arm churn fix, field evidence
// 2026-09-26). Pre-fix, every STALE BUILD detection printed one line and
// exited, requiring the agent to manually re-arm Monitor on the new build
// after EVERY release. Fixed: when the newer build's watcher script exists on
// disk, this process spawns it as a CHILD with stdio 'inherit' and passes
// through exit codes/signals, so Monitor's stream simply continues on the new
// build. Guards: never hand off to the same/older version; at most one
// handoff per process chain (ANTIHALL_WAKE_WATCH_HANDED_OFF); the parent
// releases its lock BEFORE spawning (the child acquires it fresh itself); a
// spawn failure falls back to the pre-fix print-and-exit behavior.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MODULE_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-wake-watch.js');
const { canHandoff, attemptHandoff, formatHandoffLine, HANDOFF_ENV_VAR } = require(MODULE_PATH);

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakewatch-handoff-'));
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

// Same fixture shape as tests/companion/devswarm-wake-watch-stale-version.test.js's
// own layoutPlugins helper (duplicated per that file's own convention — see its
// header comment).
function layoutPlugins(home, { installedVersion, cacheVersions, marketplaceVersion, cacheContent } = {}) {
  const pluginsRoot = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(path.join(pluginsRoot, 'marketplaces', 'anti-hall'), { recursive: true });
  if (installedVersion) {
    fs.mkdirSync(pluginsRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginsRoot, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'anti-hall@anti-hall': [{ scope: 'user', version: installedVersion }] } }), 'utf8');
  }
  for (const v of (cacheVersions || [])) {
    const libDir = path.join(pluginsRoot, 'cache', 'anti-hall', 'anti-hall', v, 'companion', 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, 'devswarm-wake-watch.js'), cacheContent || '// stub for tests\n', 'utf8');
  }
  if (marketplaceVersion) {
    const srcDir = path.join(pluginsRoot, 'marketplaces', 'anti-hall', 'plugins', 'anti-hall', '.claude-plugin');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'plugin.json'), JSON.stringify({ name: 'anti-hall', version: marketplaceVersion }), 'utf8');
  }
  return pluginsRoot;
}

// waitForStdoutMatch — same pattern as the stale-version test file's own
// helper: waits for `pattern` in the child's accumulated stdout (or a hard
// cap), always terminates the child before resolving.
function waitForStdoutMatch(args, spawnOpts, pattern, hardCapMs) {
  hardCapMs = hardCapMs || 8000;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, spawnOpts);
    if (child.stdout) child.stdout.setEncoding('utf8');
    if (child.stderr) child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let settled = false;
    let hardTimer = null;
    let exited = false;
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try { child.kill('SIGTERM'); } catch (_) {}
      resolve({ stdout, stderr, exited });
    }
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk; if (pattern.test(stdout)) finish(); });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => finish());
    child.on('exit', () => { exited = true; finish(); });
    hardTimer = setTimeout(finish, hardCapMs);
  });
}

// ---------------------------------------------------------------------------
// Unit-level: canHandoff / attemptHandoff guards (no real subprocess needed).
// ---------------------------------------------------------------------------

test('canHandoff: newer version -> true', () => {
  assert.strictEqual(canHandoff('0.108.4', '0.108.5', {}), true);
});

test('canHandoff: the SAME version -> false (never hand off to itself)', () => {
  assert.strictEqual(canHandoff('0.108.5', '0.108.5', {}), false);
});

test('canHandoff: an OLDER "newest" version -> false (never regress)', () => {
  assert.strictEqual(canHandoff('0.108.5', '0.108.4', {}), false);
});

test('canHandoff: HANDOFF_ENV_VAR already set -> false (at most one handoff per process chain)', () => {
  assert.strictEqual(canHandoff('0.108.4', '0.108.5', { [HANDOFF_ENV_VAR]: '1' }), false);
});

test('canHandoff: non-semver inputs -> false, never throws', () => {
  assert.strictEqual(canHandoff(null, '0.108.5', {}), false);
  assert.strictEqual(canHandoff('0.108.4', 'not-a-version', {}), false);
});

test('attemptHandoff: the SAME version -> returns null, spawnFn is NEVER called, nothing printed', () => {
  let spawnCalled = false;
  const child = attemptHandoff({
    ownVersion: '0.108.5', newestVersion: '0.108.5', scriptPath: '/does/not/matter.js',
    role: 'child', id: 'kid-1', env: {}, release: () => {},
    spawnFn: () => { spawnCalled = true; return { on() {}, once() {} }; },
  });
  assert.strictEqual(child, null);
  assert.strictEqual(spawnCalled, false, 'the version guard must short-circuit before ever calling spawnFn');
});

test('attemptHandoff: already handed off once (loop guard) -> returns null, spawnFn is NEVER called', () => {
  let spawnCalled = false;
  const child = attemptHandoff({
    ownVersion: '0.108.4', newestVersion: '0.108.5', scriptPath: '/does/not/matter.js',
    role: 'child', id: 'kid-1', env: { [HANDOFF_ENV_VAR]: '1' }, release: () => {},
    spawnFn: () => { spawnCalled = true; return { on() {}, once() {} }; },
  });
  assert.strictEqual(child, null);
  assert.strictEqual(spawnCalled, false);
});

test('attemptHandoff: spawn failure (spawnFn throws synchronously) -> returns null (caller falls back), but the lock IS already released', () => {
  let released = false;
  const child = attemptHandoff({
    ownVersion: '0.108.4', newestVersion: '0.108.5', scriptPath: '/does/not/matter.js',
    role: 'child', id: 'kid-1', env: {}, release: () => { released = true; },
    spawnFn: () => { throw new Error('boom: no such interpreter'); },
  });
  assert.strictEqual(child, null, 'a synchronous spawn failure must make the caller fall back to the pre-fix behavior');
  assert.strictEqual(released, true, 'lock ordering: release() runs BEFORE the (failed) spawn attempt — never a double watcher');
});

test('attemptHandoff: release() is called BEFORE spawnFn (never two watchers)', () => {
  const order = [];
  attemptHandoff({
    ownVersion: '0.108.4', newestVersion: '0.108.5', scriptPath: '/does/not/matter.js',
    role: 'child', id: 'kid-1', env: {}, release: () => { order.push('release'); },
    spawnFn: () => { order.push('spawn'); return { on() {}, once() {} }; },
  });
  assert.deepStrictEqual(order, ['release', 'spawn']);
});

test('attemptHandoff: a genuinely spawned child gets HANDOFF_ENV_VAR=1 stamped on its env (so IT refuses to hand off again)', () => {
  let seenEnv = null;
  attemptHandoff({
    ownVersion: '0.108.4', newestVersion: '0.108.5', scriptPath: '/does/not/matter.js',
    role: 'child', id: 'kid-1', env: { FOO: 'bar' }, release: () => {},
    spawnFn: (cmd, args, opts) => { seenEnv = opts.env; return { on() {}, once() {} }; },
  });
  assert.strictEqual(seenEnv[HANDOFF_ENV_VAR], '1');
  assert.strictEqual(seenEnv.FOO, 'bar', 'must inherit the rest of the parent env');
});

test('formatHandoffLine: names the version', () => {
  assert.strictEqual(formatHandoffLine('0.108.5'), '[wake-watch] handed off to 0.108.5');
});

// ---------------------------------------------------------------------------
// Integration: main() with a REAL newer cached watcher script -> the parent
// prints the handoff line and the child genuinely runs (its own stdout
// reaches this process's stdout via stdio:'inherit').
// ---------------------------------------------------------------------------

// readInstalledPluginVersion() always reads THIS checkout's real
// plugins/anti-hall/.claude-plugin/plugin.json (relative to MODULE_PATH's own
// __dirname), regardless of HOME — so these integration tests run the REAL
// MODULE_PATH in place as the "own" watcher (never a copy: a copy elsewhere
// cannot resolve its sibling `require`s — companion/lib, hooks/lib, etc. —
// which live relative to the real plugin tree, not the fake HOME). Only the
// "newer" cached watcher (a self-contained stub with zero requires) needs to
// live under the fake HOME's cache dir.
function ownVersion() {
  const p = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', '.claude-plugin', 'plugin.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')).version;
}

test('main(): a newer version is present on disk -> prints the ONE handoff line, and the child ACTUALLY RUNS (its stdout is visible via inherit)', async () => {
  const home = tmpHome();
  try {
    const CHILD_MARKER = '[stub-child] alive';
    const NEWER = '9.999.0'; // deliberately far ahead of any real released version
    // The "newer" cached watcher is a trivial, self-contained script (no
    // requires — it does not need to resolve as part of the real plugin
    // tree) that announces itself then blocks forever (simulating a real
    // watcher's poll loop) so the test can positively observe it having
    // started, not just infer it from the parent's own handoff line.
    layoutPlugins(home, {
      cacheVersions: [NEWER],
      marketplaceVersion: NEWER,
      cacheContent: 'process.stdout.write(' + JSON.stringify(CHILD_MARKER + '\n') + ');\nsetInterval(() => {}, 1000);\n',
    });

    const id = 'handoff-child-1';
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEVSWARM_REPO_ID: 'r1',
      DEVSWARM_SOURCE_BRANCH: 'main',
      DEVSWARM_BUILDER_ID: id,
      ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS: '250',
    };
    const res = await waitForStdoutMatch([MODULE_PATH], { env },
      new RegExp('\\[wake-watch\\] handed off to ' + NEWER.replace(/\./g, '\\.') + '[\\s\\S]*' + CHILD_MARKER.replace(/[[\]]/g, '\\$&')), 8000);
    assert.match(res.stdout, new RegExp('\\[wake-watch\\] handed off to ' + NEWER.replace(/\./g, '\\.')), 'parent must print the ONE handoff line; got stdout=' + JSON.stringify(res.stdout));
    assert.doesNotMatch(res.stdout, /STALE BUILD/, 'must never fall back to the old print-and-exit line when the handoff succeeds');
    assert.match(res.stdout, new RegExp(CHILD_MARKER.replace(/[[\]]/g, '\\$&')), 'the CHILD must have actually run (its own stdout visible via stdio:inherit); got stdout=' + JSON.stringify(res.stdout));
  } finally { rm(home); }
});

test('main(): own version already the newest known -> no handoff, no STALE BUILD, watcher stays armed on itself', async () => {
  const home = tmpHome();
  try {
    const OWN = ownVersion();
    layoutPlugins(home, { cacheVersions: [OWN], marketplaceVersion: OWN });

    const id = 'handoff-child-2';
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEVSWARM_REPO_ID: 'r1',
      DEVSWARM_SOURCE_BRANCH: 'main',
      DEVSWARM_BUILDER_ID: id,
      ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS: '250',
    };
    const res = await waitForStdoutMatch([MODULE_PATH], { env }, /armed: watching child handoff-child-2/, 6000);
    assert.match(res.stdout, /\[wake-watch\] armed: watching child handoff-child-2/);
    assert.doesNotMatch(res.stdout, /handed off to/, 'must never hand off to its own current version');
    assert.doesNotMatch(res.stdout, /STALE BUILD/);
    assert.strictEqual(res.exited, false, 'must still be running its own build, unaffected');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// 0.109.5 review P1: after a handoff the parent (a) never persists its stale
// seen-state, (b) exits 128+signo when the child dies by a signal (without
// re-raising into its own handlers), and (c) forwards SIGTERM/SIGINT to the
// child so the child is never orphaned holding the lock.
// ---------------------------------------------------------------------------

const { seenPath, handoffExitCode } = require(MODULE_PATH);

function handoffEnv(home, id, extra) {
  return Object.assign({
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    DEVSWARM_REPO_ID: 'r1',
    DEVSWARM_SOURCE_BRANCH: 'main',
    DEVSWARM_BUILDER_ID: id,
    ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS: '250',
  }, extra || {});
}

// runToExit — spawn, collect stdout, resolve on exit with {code, signal}.
function runToExit(args, spawnOpts, hardCapMs, onStdout) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, spawnOpts);
    let stdout = '';
    let done = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; if (onStdout) onStdout(stdout, child); });
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch (_) {} resolve({ code: null, signal: 'TIMEOUT', stdout }); } }, hardCapMs || 8000);
    child.on('exit', (code, signal) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, signal, stdout }); });
  });
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

test('handoffExitCode: plain code passes through; signal -> 128+signo', () => {
  assert.strictEqual(handoffExitCode(3, null), 3);
  assert.strictEqual(handoffExitCode(null, null), 0);
  assert.strictEqual(handoffExitCode(null, 'SIGTERM'), 128 + os.constants.signals.SIGTERM);
  assert.strictEqual(handoffExitCode(null, 'SIGINT'), 128 + os.constants.signals.SIGINT);
});

test('handoff: the parent NEVER writes its stale seen-state at exit (skipSave)', async () => {
  const home = tmpHome();
  try {
    const id = 'handoff-skipsave-1';
    const seen = seenPath(home, id);
    layoutPlugins(home, {
      cacheVersions: ['9.999.0'], marketplaceVersion: '9.999.0',
      cacheContent: 'const fs=require("fs");const p=process.env.STUB_SEEN_PATH;fs.mkdirSync(require("path").dirname(p),{recursive:true});fs.writeFileSync(p,"CHILD-OWNED");process.exit(0);\n',
    });
    const res = await runToExit([MODULE_PATH], { env: handoffEnv(home, id, { STUB_SEEN_PATH: seen }) }, 8000);
    assert.strictEqual(res.code, 0, 'parent exits with the child code; got ' + JSON.stringify(res));
    assert.strictEqual(fs.readFileSync(seen, 'utf8'), 'CHILD-OWNED', 'the parent must not overwrite the child-owned seen-state');
  } finally { rm(home); }
});

test('handoff: child killed by a signal -> parent exits 128+signo (not re-raised into its own handlers)', async () => {
  const home = tmpHome();
  try {
    layoutPlugins(home, {
      cacheVersions: ['9.999.0'], marketplaceVersion: '9.999.0',
      cacheContent: 'setTimeout(() => process.kill(process.pid, "SIGTERM"), 50); setInterval(() => {}, 1000);\n',
    });
    const res = await runToExit([MODULE_PATH], { env: handoffEnv(home, 'handoff-sig-1') }, 8000);
    assert.strictEqual(res.signal, null, 'parent must exit normally, not by a re-raised signal; got ' + JSON.stringify(res));
    assert.strictEqual(res.code, 128 + os.constants.signals.SIGTERM);
  } finally { rm(home); }
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  test(`handoff: parent receiving ${sig} forwards it to the child (child never orphaned)`, async () => {
    const home = tmpHome();
    try {
      const pidFile = path.join(home, 'child.pid');
      layoutPlugins(home, {
        cacheVersions: ['9.999.0'], marketplaceVersion: '9.999.0',
        cacheContent: 'require("fs").writeFileSync(process.env.STUB_PID_FILE, String(process.pid)); process.stdout.write("[stub-child] alive\\n"); setInterval(() => {}, 1000);\n',
      });
      let sent = false;
      const res = await runToExit([MODULE_PATH], { env: handoffEnv(home, 'handoff-fwd-' + sig, { STUB_PID_FILE: pidFile }) }, 8000, (out, parent) => {
        if (!sent && /\[stub-child\] alive/.test(out)) { sent = true; parent.kill(sig); }
      });
      assert.ok(sent, 'child must have started; got ' + JSON.stringify(res));
      const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.strictEqual(isAlive(childPid), false, 'child must not be orphaned after the parent got ' + sig);
      assert.strictEqual(res.code, 128 + os.constants.signals[sig], 'parent exits 128+signo; got ' + JSON.stringify(res));
    } finally { rm(home); }
  });
}

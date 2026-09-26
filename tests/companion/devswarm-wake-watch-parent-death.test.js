'use strict';
// Regression test for the orphan-watcher field incident (2026-09-26): a real
// companion/lib/devswarm-wake-watch.js process, started by a test's
// intermediate parent 19 hours earlier, was still running with PPID 1 — its
// original parent (the Monitor's shell / the stable-launcher wrapper
// ~/.anti-hall/bin/wake-watch.js) had died and nothing in the watcher ever
// checked. Fix under test: devswarm-wake-watch.js's parentGone() check,
// polled every loop tick, exits the watcher (and releases its lock) once its
// STARTUP parent is gone (reparented onto PPID 1, or process.kill(startPpid,
// 0) throws ESRCH).
//
// Both scenarios here spawn REAL child processes through a real intermediate
// parent process and kill that intermediate — proving the fix against actual
// OS reparenting, not a mocked ppid.

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const wakeWatchPath = path.join(ROOT, 'companion', 'lib', 'devswarm-wake-watch.js');
const stableLauncherPath = path.join(ROOT, 'hooks', 'lib', 'stable-launcher.js');
if (!fs.existsSync(wakeWatchPath) || !fs.existsSync(stableLauncherPath)) {
  throw new Error('ANTIHALL_TEST_PLUGIN_ROOT=' + JSON.stringify(ROOT) + ' is not a plugins/anti-hall-shaped tree');
}
const wakeWatch = require(wakeWatchPath);
const stableLauncher = require(stableLauncherPath);

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakewatch-parentdeath-'));
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

function isAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

async function waitUntil(fn, timeoutMs, stepMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs || 50));
  }
  return !!fn();
}

test('a watcher spawned by an intermediate parent exits and releases its lock once that parent dies', async () => {
  const home = tmpHome();
  const id = 'builder-parentdeath-direct';
  let intermediate = null;
  try {
    const lockPath = wakeWatch.lockPathFor(home, id);
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEVSWARM_REPO_ID: 'r1',
      DEVSWARM_SOURCE_BRANCH: 'main',
      DEVSWARM_BUILDER_ID: id,
      ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS: '80',
      WAKE_WATCH_TARGET: wakeWatchPath,
    };
    // The intermediate process spawns the REAL watcher as its own OS child
    // (never detached), prints the watcher's pid once, then just stays alive
    // so it can be killed independently of the watcher.
    const intermediateSrc =
      'const { spawn } = require("child_process");' +
      'const c = spawn(process.execPath, [process.env.WAKE_WATCH_TARGET], { env: process.env, stdio: ["ignore", "ignore", "ignore"] });' +
      'process.stdout.write("CHILD_PID:" + c.pid + "\\n");' +
      'setInterval(() => {}, 1000);';
    intermediate = spawn(process.execPath, ['-e', intermediateSrc], { env });
    let out = '';
    intermediate.stdout.on('data', (d) => { out += d.toString(); });

    const gotPid = await waitUntil(() => /CHILD_PID:(\d+)/.test(out), 5000, 50);
    assert.ok(gotPid, 'intermediate must report the spawned watcher\'s pid');
    const watcherPid = Number(/CHILD_PID:(\d+)/.exec(out)[1]);
    assert.ok(watcherPid > 0);

    const armed = await waitUntil(() => fs.existsSync(lockPath), 5000, 50);
    assert.ok(armed, 'watcher should have armed and written its own lock file');
    assert.ok(isAlive(watcherPid), 'sanity: watcher is alive before the parent dies');

    // Kill the intermediate — the watcher's ORIGINAL (startup) parent.
    intermediate.kill('SIGKILL');
    await waitUntil(() => !isAlive(intermediate.pid), 2000, 50);

    const exited = await waitUntil(() => !isAlive(watcherPid), 5000, 50);
    assert.ok(exited, 'the orphaned watcher must exit within a few seconds of its parent dying');

    const lockGone = await waitUntil(() => !fs.existsSync(lockPath), 2000, 50);
    assert.ok(lockGone, 'the orphaned watcher must release its own lock file on exit');
  } finally {
    if (intermediate && isAlive(intermediate.pid)) { try { intermediate.kill('SIGKILL'); } catch (_) {} }
    rm(home);
  }
});

test('a watcher spawned via the stable launcher also exits when the launcher wrapper dies', async () => {
  const home = tmpHome();
  const id = 'builder-parentdeath-launcher';
  let launcher = null;
  try {
    // No installed_plugins.json / marketplace laid out under this tmp HOME,
    // so the generated launcher falls back to wakeWatchPath directly.
    const launcherPath = stableLauncher.installLauncher('wakeWatch', wakeWatchPath, home);
    assert.ok(launcherPath && fs.existsSync(launcherPath), 'launcher must install');

    const lockPath = wakeWatch.lockPathFor(home, id);
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEVSWARM_REPO_ID: 'r1',
      DEVSWARM_SOURCE_BRANCH: 'main',
      DEVSWARM_BUILDER_ID: id,
      ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS: '80',
    };
    // The launcher itself is the watcher's direct/startup parent here — spawn
    // it as this test's own child (an ordinary intermediate-parent shape) and
    // kill THE LAUNCHER to model "the launcher wrapper dies".
    launcher = spawn(process.execPath, [launcherPath], { env, stdio: ['ignore', 'ignore', 'ignore'] });

    const armed = await waitUntil(() => fs.existsSync(lockPath), 5000, 50);
    assert.ok(armed, 'watcher (via launcher) should have armed and written its own lock file');
    const watcherPid = JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid;
    assert.ok(Number.isFinite(watcherPid) && watcherPid > 0, 'lock file names the real watcher pid');
    assert.notStrictEqual(watcherPid, launcher.pid, 'the watcher runs as a distinct process from the launcher');
    assert.ok(isAlive(watcherPid), 'sanity: watcher is alive before the launcher dies');

    launcher.kill('SIGKILL');
    await waitUntil(() => !isAlive(launcher.pid), 2000, 50);

    const exited = await waitUntil(() => !isAlive(watcherPid), 5000, 50);
    assert.ok(exited, 'the watcher must exit within a few seconds of the launcher wrapper dying');

    const lockGone = await waitUntil(() => !fs.existsSync(lockPath), 2000, 50);
    assert.ok(lockGone, 'the watcher must release its own lock file on exit');
  } finally {
    if (launcher && isAlive(launcher.pid)) { try { launcher.kill('SIGKILL'); } catch (_) {} }
    rm(home);
  }
});

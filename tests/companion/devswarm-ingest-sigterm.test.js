'use strict';
// Real-process regression test for the "ingest daemon ignores SIGTERM" bug that
// produced 12 duplicate daemons in the field (7-12 days old, only SIGKILL could
// remove them). All the other devswarm-ingest tests run runIngestLoop IN-PROCESS
// with an injected `run`/`sleep`, which cannot exercise the actual failure mode:
// a real OS SIGTERM arriving while the daemon is blocked inside a genuinely
// synchronous `spawnSync` call. Only a real child process can prove a real
// signal actually terminates it.
//
// Isolation: HOME/USERPROFILE point at a throwaway tmp dir — THAT is what
// keeps the daemon's lock/heartbeat/store files off the real ~/.anti-hall;
// devswarm-ingest.js itself never reads ANTIHALL_INGEST_DRY_RUN (that flag
// belongs to install-devswarm-ingest.js's planWrite/planRm/planRun, a
// different file this daemon does not invoke on this path — verified by grep,
// it does not appear anywhere in devswarm-ingest.js). It is set here anyway,
// harmlessly, as defense in depth in case a future code path in this daemon
// ever grows a dependency on the installer. The "hivecontrol" binary is a
// fake shell script (ANTIHALL_DEVSWARM_HIVECONTROL) that just sleeps, so the
// daemon never touches a real hivecontrol/store and spends most of its time
// genuinely blocked inside spawnSync — exactly the window the original bug
// lived in.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const INGEST_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-ingest.js');

function tmpHome(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// A fake `hivecontrol` that sleeps well past the moment we send SIGTERM, so the
// daemon is provably still inside spawnSync's blocking window when the signal
// arrives — then exits with an empty, well-formed batch.
function writeFakeHivecontrol(dir) {
  const p = path.join(dir, 'fake-hivecontrol.sh');
  fs.writeFileSync(p, '#!/bin/sh\nsleep 5\necho "[]"\n');
  fs.chmodSync(p, 0o755);
  return p;
}

function spawnDaemon(home, hivecontrolBin) {
  return spawn(process.execPath, [INGEST_PATH], {
    cwd: home, // not a git worktree -> resolveDaemonWorktree() is null, fail-open
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ANTIHALL_INGEST_DRY_RUN: '1',
      ANTIHALL_DEVSWARM_HIVECONTROL: hivecontrolBin,
      // Short bounded cadence so the test doesn't have to wait out the 30s
      // production default if the fix regresses and we fall through to the
      // spawnSync hardTimeoutMs kill instead of an immediate signal death.
      ANTIHALL_DEVSWARM_MONITOR_TIMEOUT_SEC: '5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('a real SIGTERM sent to the ingest daemon while it is blocked in spawnSync kills it promptly (regression for the duplicate-daemon bug)', (t, done) => {
  const home = tmpHome('anti-hall-ingest-sigterm-');
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fake-hc-'));
  const hivecontrolBin = writeFakeHivecontrol(binDir);
  const child = spawnDaemon(home, hivecontrolBin);
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try { child.kill('SIGKILL'); } catch (_) {}
    rm(home); rm(binDir);
    done(new Error('daemon did not exit within the grace window after SIGTERM — it ignored the signal'));
  }, 8000);
  child.on('exit', () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rm(home); rm(binDir);
    done();
  });
  // Give the daemon a moment to start its loop and enter the blocking spawnSync
  // call (the fake hivecontrol sleeps 5s), then signal it mid-block.
  setTimeout(() => {
    try { child.kill('SIGTERM'); } catch (_) {}
  }, 800);
});

// VACUITY CHECK (reported, not asserted here): temporarily re-adding the removed
// `proc.on('SIGTERM', onSignal); proc.on('SIGINT', onSignal);` registration (and
// its onSignal handler) in devswarm-ingest.js's runIngestLoop, with no other
// change, makes the test above TIME OUT (fail) instead of passing — because the
// re-registered JS listener disables Node's default terminate disposition and
// then never gets a turn of the event loop while spawnSync is blocked on the
// fake hivecontrol's `sleep 5`. This was verified manually; the revert is not
// checked in.

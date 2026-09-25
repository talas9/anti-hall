'use strict';
// 0.108.5 — the ingest daemon must stay alive and heartbeating while
// `hivecontrol workspace monitor` is slow, hung, or failing.
//
// Field incident (2026-09-25, machine load 100+): both ingest daemons logged
// "spawnSync .../hivecontrol ETIMEDOUT", one heartbeat went ~10 min stale, one
// unit restarted repeatedly with no exit reason logged, and a restarted daemon
// sat at lastMonitorOkMs:null + consecutiveMonitorFailures:0 for 15+ min while
// doctor and the banner called it healthy. Root cause: spawnSync's `timeout`
// only SIGTERMs the child and then keeps BLOCKING until the child actually
// exits, so a slow-to-die hivecontrol froze the whole daemon (heartbeat
// included); signal deaths logged nothing; and health had no "no success"
// rule.
//
// Every test isolates HOME (tmp dirs) and ANTI_HALL_LOG_DIR. The fake
// hivecontrol binaries are shell scripts in tmp dirs; nothing touches a real
// hivecontrol, launchd unit, or ~/.anti-hall.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-async-monitor-logs-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;

const INGEST_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-ingest.js');
const ingest = require(INGEST_PATH);
const health = require('../../plugins/anti-hall/companion/lib/ingest-health.js');
const repair = require('../../plugins/anti-hall/hooks/lib/doctor-repair.js');

const POSIX = process.platform !== 'win32';

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-async-monitor-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function fakeHivecontrol(dir, body) {
  const p = path.join(dir, 'fake-hivecontrol.sh');
  fs.writeFileSync(p, '#!/bin/sh\n' + body + '\n');
  fs.chmodSync(p, 0o755);
  return p;
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}
// Proxy fs that records every heartbeat body the daemon writes (tmp -> rename).
function heartbeatSpy(hbPath) {
  const beats = [];
  const spyFs = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'renameSync') {
        return function (src, dest) {
          if (dest === hbPath) { try { beats.push(Object.assign({ at: Date.now() }, JSON.parse(target.readFileSync(src, 'utf8')))); } catch (_) {} }
          return target.renameSync(src, dest);
        };
      }
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
  return { beats, spyFs };
}

// ---------------------------------------------------------------------------
// defaultMonitorRunAsync — the non-blocking runner
// ---------------------------------------------------------------------------

test('defaultMonitorRunAsync: a child that IGNORES SIGTERM is SIGKILLed on time, stdout is kept, and the event loop never blocks', { skip: !POSIX }, async () => {
  const dir = tmpHome();
  try {
    // Prints a batch, then ignores SIGTERM and sleeps 30s (the field shape: a
    // hivecontrol that does not die promptly when the timeout fires).
    const bin = fakeHivecontrol(dir, 'trap "" TERM\necho \'[{"message":"drained-before-kill"}]\'\nsleep 30');
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 20);
    const t0 = Date.now();
    let res;
    // hardTimeoutMs leaves the shell time to start and print even on a loaded box.
    try { res = await ingest.defaultMonitorRunAsync({ hivecontrol: bin, hardTimeoutMs: 4000, killGraceMs: 300 }); } finally { clearInterval(iv); }
    const elapsed = Date.now() - t0;
    assert.equal(res.ok, false, 'a timed-out attempt is a failure');
    assert.equal(res.code, 'ETIMEDOUT');
    assert.match(res.error, /ETIMEDOUT/);
    assert.deepEqual(JSON.parse(res.raw.trim()), [{ message: 'drained-before-kill' }], 'stdout drained before the kill is preserved (destructive read)');
    assert.ok(elapsed >= 4000 && elapsed < 15000, 'bounded by hardTimeout + kill grace, not by the 30s child: took ' + elapsed + 'ms');
    assert.ok(ticks >= 5, 'the event loop kept turning during the call (timers fired ' + ticks + 'x)');
  } finally { rm(dir); }
});

test('defaultMonitorRunAsync: success, non-zero exit (spawnSync parity: still ok), and a missing binary (ENOENT, permanent)', { skip: !POSIX }, async () => {
  const dir = tmpHome();
  try {
    const okBin = fakeHivecontrol(dir, 'echo "[]"');
    const ok = await ingest.defaultMonitorRunAsync({ hivecontrol: okBin, hardTimeoutMs: 5000 });
    assert.equal(ok.ok, true);
    assert.equal(ok.raw.trim(), '[]');
    assert.equal(ok.exitCode, 0);

    const failDir = path.join(dir, 'f'); fs.mkdirSync(failDir);
    const failBin = fakeHivecontrol(failDir, 'echo "[]"\nexit 3');
    const nz = await ingest.defaultMonitorRunAsync({ hivecontrol: failBin, hardTimeoutMs: 5000 });
    assert.equal(nz.ok, true, 'a non-zero exit without a spawn error is not a failure (same contract as the spawnSync runner)');
    assert.equal(nz.exitCode, 3, 'the exit code is still surfaced');

    const missing = await ingest.defaultMonitorRunAsync({ hivecontrol: path.join(dir, 'no-such-binary'), hardTimeoutMs: 5000 });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'ENOENT');
    assert.equal(ingest.monitorFailureCode(missing), 'ENOENT', 'the breaker still classifies it as a permanent config fault');
  } finally { rm(dir); }
});

// P2 fix: stdio used to be ['ignore','pipe','ignore'] — stderr was silently
// discarded, so a non-zero exit (or an external signal) carried no diagnostic
// text at all. stderr is now captured into a bounded (last 2KB) tail and
// folded into the resolved `error` field — WITHOUT changing the ok:true
// spawnSync-parity contract for a plain non-zero exit (still not itself a
// failure — only the field case exit 3 in the fixture above, and the new
// stderr-carrying case below).
test('defaultMonitorRunAsync: stderr from a non-zero exit is captured and surfaced in `error` (ok stays true — spawnSync parity unchanged)', { skip: !POSIX }, async () => {
  const dir = tmpHome();
  try {
    const bin = fakeHivecontrol(dir, 'echo "[]"\n>&2 echo "hivecontrol: workspace lock busy, retry later"\nexit 1');
    const res = await ingest.defaultMonitorRunAsync({ hivecontrol: bin, hardTimeoutMs: 5000 });
    assert.equal(res.ok, true, 'a plain non-zero exit (no spawn error) still stays ok:true — unchanged contract');
    assert.equal(res.exitCode, 1);
    assert.equal(res.raw.trim(), '[]', 'stdout (the destructive queue read) is unaffected by stderr capture');
    assert.match(res.error, /hivecontrol: workspace lock busy, retry later/, 'the stderr text is surfaced in the resolved error, not silently dropped');
    assert.match(res.error, /exited 1/, 'the error also names the exit code');
  } finally { rm(dir); }
});

test('defaultMonitorRunAsync: stderr tail is BOUNDED to the last ~2KB, not accumulated without limit', { skip: !POSIX }, async () => {
  const dir = tmpHome();
  try {
    // Write ~6KB of stderr (well past the 2KB tail bound) followed by a
    // distinctive marker at the very end, then exit non-zero.
    const bin = fakeHivecontrol(dir,
      'i=0\nwhile [ $i -lt 6000 ]; do printf "x" >&2; i=$((i+1)); done\n>&2 printf "END-MARKER"\nexit 1');
    const res = await ingest.defaultMonitorRunAsync({ hivecontrol: bin, hardTimeoutMs: 5000 });
    assert.equal(res.ok, true);
    assert.match(res.error, /END-MARKER/, 'the TAIL (most recent bytes) is kept');
    // The captured segment inside the error message is bounded near the 2KB
    // cap, not the full ~6KB written — proves truncation actually happened.
    const stderrSegment = res.error.split('stderr: ')[1] || '';
    assert.ok(stderrSegment.length <= 2100, 'stderr tail stays bounded near the 2KB cap, got ' + stderrSegment.length + ' bytes');
  } finally { rm(dir); }
});

test('defaultMonitorRunAsync: an external SIGKILL (not our own timeout) surfaces the signal + any stderr, still ok:true', { skip: !POSIX }, async () => {
  const dir = tmpHome();
  try {
    // The fake binary writes ITS OWN pid to a file before sleeping, so the
    // test can kill it directly (process.kill on the real child pid) — an
    // external kill, never routed through this module's own hardTimeoutMs
    // ladder (60s >> the ~300ms this test waits before killing).
    const pidFile = path.join(dir, 'child.pid');
    const bin = fakeHivecontrol(dir, 'echo $$ > ' + pidFile + '\n>&2 echo "about to be killed externally"\nsleep 30');
    const p = ingest.defaultMonitorRunAsync({ hivecontrol: bin, hardTimeoutMs: 60000 });
    assert.ok(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 5000),
      'fake binary wrote its pid in time');
    const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isFinite(childPid) && childPid > 0);
    process.kill(childPid, 'SIGKILL');
    const res = await p;
    assert.equal(res.ok, true, 'an external signal death (no spawn error) stays ok:true — spawnSync parity');
    assert.equal(res.signal, 'SIGKILL');
    assert.match(res.error, /killed by signal SIGKILL/);
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// runIngestLoopAsync — the daemon loop
// ---------------------------------------------------------------------------

test('daemon loop: a HANGING hivecontrol never stalls the heartbeat, the loop keeps going, backoff grows, nothing throws', { skip: !POSIX }, async () => {
  const home = tmpHome();
  try {
    const bin = fakeHivecontrol(home, 'trap "" TERM\nsleep 30');
    const hbPath = ingest.ingestHeartbeatPath(home, 'p');
    const { beats, spyFs } = heartbeatSpy(hbPath);
    const sleeps = [];
    const summary = await ingest.runIngestLoopAsync({
      home, env: { HOME: home, PATH: process.env.PATH }, backend: 'journal', workspaceId: 'p', worktree: null, maxIterations: 4,
      hivecontrol: bin, hardTimeoutMs: 300, restartBackoffMs: 10, runHeartbeatIntervalMs: 50,
      run: (a) => ingest.defaultMonitorRunAsync(Object.assign({}, a, { killGraceMs: 100 })),
      sleep: (ms) => { sleeps.push(ms); return new Promise((r) => setTimeout(r, ms)); },
      io: { storeFs: spyFs, skipLockSweep: true },
    });
    assert.equal(summary.started, true);
    assert.equal(summary.stats.iterations, 4, 'every iteration ran — the daemon did not wedge or exit');
    assert.equal(summary.stats.errors, 4);
    // Heartbeats kept flowing WHILE each hung call was in flight (>= 1 in-flight
    // beat per ~400ms attempt at a 50ms beat interval), not just between calls.
    assert.ok(beats.length >= 4 * 3, 'heartbeats written during in-flight calls too, got ' + beats.length);
    let maxGap = 0;
    for (let i = 1; i < beats.length; i++) maxGap = Math.max(maxGap, beats[i].at - beats[i - 1].at);
    assert.ok(maxGap < 1000, 'no heartbeat gap anywhere near the hang length (max gap ' + maxGap + 'ms)');
    // Every attempt is stamped; failures count up; the error is recorded.
    const last = beats[beats.length - 1];
    assert.ok(Number.isFinite(last.lastMonitorAttemptMs), 'lastMonitorAttemptMs is written');
    assert.equal(last.lastMonitorOkMs, null, 'no success in this run');
    assert.match(String(last.lastMonitorError), /ETIMEDOUT/);
    assert.ok(beats.some((b) => b.consecutiveMonitorFailures === 3), 'consecutive failures are counted in the heartbeat');
    // Exponential backoff from restartBackoffMs (the final iteration does not back off).
    assert.deepEqual(sleeps, [10, 20, 40], 'transient backoff doubles per consecutive failure');
  } finally { rm(home); }
});

test('daemon loop: a SUCCESSFUL poll stamps lastMonitorOkMs and clears the failure state', { skip: !POSIX }, async () => {
  const home = tmpHome();
  try {
    const flag = path.join(home, 'calls');
    // First call hangs past the timeout; later calls succeed quickly.
    const bin = fakeHivecontrol(home,
      'n=$(cat "' + flag + '" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "' + flag + '"\n'
      + 'if [ "$n" = "1" ]; then exec sleep 30; fi\necho "[]"');
    const hbPath = ingest.ingestHeartbeatPath(home, 'p');
    const { beats, spyFs } = heartbeatSpy(hbPath);
    const summary = await ingest.runIngestLoopAsync({
      home, env: { HOME: home, PATH: process.env.PATH }, backend: 'journal', workspaceId: 'p', worktree: null, maxIterations: 3, intervalSec: 0.05,
      hivecontrol: bin, hardTimeoutMs: 2000, restartBackoffMs: 10, runHeartbeatIntervalMs: 50,
      run: (a) => ingest.defaultMonitorRunAsync(Object.assign({}, a, { killGraceMs: 100 })),
      io: { storeFs: spyFs, skipLockSweep: true },
    });
    assert.equal(summary.stats.iterations, 3);
    assert.equal(summary.stats.errors, 1, 'only the first (hung) attempt failed');
    assert.equal(summary.stats.monitorFailures, 0, 'success reset the failure count');
    const last = beats[beats.length - 1];
    assert.ok(Number.isFinite(last.lastMonitorOkMs), 'a success is recorded');
    assert.equal(last.consecutiveMonitorFailures, 0);
    assert.equal(last.lastMonitorError, null, 'the last error is cleared by a success');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// Exit-reason logging
// ---------------------------------------------------------------------------

test('a forced exit (SIGTERM) of the REAL daemon logs its reason and kills the in-flight hivecontrol child', { skip: !POSIX }, async () => {
  const home = tmpHome();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-async-monitor-bin-'));
  const pidFile = path.join(binDir, 'child.pid');
  try {
    const bin = fakeHivecontrol(binDir, 'echo $$ > "' + pidFile + '"\nexec sleep 30');
    const child = spawn(process.execPath, [INGEST_PATH], {
      cwd: home, // not a git worktree -> legacy global lock, fail-open
      env: {
        ...process.env, HOME: home, USERPROFILE: home, ANTI_HALL_LOG_DIR: LOG_DIR,
        ANTIHALL_INGEST_DRY_RUN: '1', ANTIHALL_DEVSWARM_HIVECONTROL: bin,
        ANTIHALL_DEVSWARM_MONITOR_TIMEOUT_SEC: '5',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    assert.ok(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 45000),
      'the daemon spawned its monitor child');
    const hcPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(isAlive(hcPid), 'the monitor child is running');
    child.kill('SIGTERM');
    const r = await Promise.race([exited, new Promise((res) => setTimeout(() => res(null), 15000))]);
    if (!r) { try { child.kill('SIGKILL'); } catch (_) {} }
    assert.ok(r, 'the daemon exited promptly on SIGTERM');
    assert.equal(r.code, 143, 'controlled exit 128+15');
    const log = fs.readFileSync(ingest.logFilePath(home), 'utf8');
    assert.match(log, /ingest daemon exiting \(pid \d+\): received SIGTERM/, 'the exit reason is in the ingest log');
    assert.ok(await waitFor(() => !isAlive(hcPid), 10000), 'the in-flight hivecontrol child was killed, not orphaned');
  } finally { rm(home); rm(binDir); }
});

test('installExitLogging: an uncaught exception logs the error + stack before exit(1); a bare exit still logs its code', () => {
  const home = tmpHome();
  try {
    const proc = new EventEmitter();
    proc.pid = 4242;
    const exits = [];
    proc.exit = (c) => { exits.push(c); };
    ingest.installExitLogging(home, undefined, proc);
    proc.emit('uncaughtException', new Error('kaboom-in-loop'));
    assert.deepEqual(exits, [1]);
    let log = fs.readFileSync(ingest.logFilePath(home), 'utf8');
    assert.match(log, /ingest daemon exiting \(pid 4242\): uncaught exception: kaboom-in-loop/);
    assert.match(log, /at .*devswarm-ingest-async-monitor\.test\.js/, 'the stack is logged');

    const proc2 = new EventEmitter();
    proc2.pid = 4343;
    proc2.exit = () => {};
    ingest.installExitLogging(home, undefined, proc2);
    proc2.emit('exit', 7);
    log = fs.readFileSync(ingest.logFilePath(home), 'utf8');
    assert.match(log, /ingest daemon exiting \(pid 4343\): exit code 7 \(no reason recorded\)/);
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// Health semantics — "no successful poll" is FAILING past the window
// ---------------------------------------------------------------------------

const MIN = 60 * 1000;
function seedDaemon(home, repoKey, fields) {
  const hb = health.ingestHeartbeatPath(home, repoKey);
  fs.mkdirSync(path.dirname(hb), { recursive: true });
  fs.writeFileSync(hb, JSON.stringify(Object.assign({ pid: process.pid }, fields)));
  const lock = health.ingestProjectLockPath(home, repoKey);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 't' }));
}
const liveIo = { isAlive: (pid) => pid === process.pid };

test('health: alive but NO successful poll since start for > 10 min (0 failures — the field shape) reads FAILING, in plain words', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    seedDaemon(home, 'rk', {
      ts: now - 20 * 1000, startedAtMs: now - 15 * MIN, lastMonitorOkMs: null,
      consecutiveMonitorFailures: 0, lastMonitorAttemptMs: now - 30 * 1000,
      lastMonitorError: 'monitor hivecontrol ETIMEDOUT after 40000ms (killed by SIGTERM)', lastMonitorErrorCode: null,
    });
    const h = health.daemonHealth(home, 'rk', { now, io: liveIo, platform: 'darwin' });
    assert.equal(h.status, 'failed', 'no success in 15 min is a failure even with 0 recorded failures');
    assert.equal(h.monitorFault.noOkSinceStart, true);
    assert.equal(h.startingUp, false);
    const banner = health.buildMonitorFaultBanner(h.monitorFault, now);
    assert.match(banner, /no monitor poll has succeeded since the daemon started 15m ago/);
    assert.match(banner, /heartbeat 20s ago/);
    assert.match(banner, /last error: monitor hivecontrol ETIMEDOUT/);
    assert.match(repair.monitorFaultReason(h.monitorFault, '/w'), /no successful poll since start 15m ago; last error: monitor hivecontrol ETIMEDOUT/);
  } finally { rm(home); }
});

test('health: a last success older than the window reads FAILING even with 0 recorded failures (a hung attempt)', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    seedDaemon(home, 'rk', { ts: now, startedAtMs: now - 60 * MIN, lastMonitorOkMs: now - 12 * MIN, consecutiveMonitorFailures: 0 });
    const h = health.daemonHealth(home, 'rk', { now, io: liveIo, platform: 'darwin' });
    assert.equal(h.status, 'failed');
    assert.equal(h.monitorFault.okStale, true);
    assert.match(health.buildMonitorFaultBanner(h.monitorFault, now), /the last successful monitor poll was 12m ago/);
  } finally { rm(home); }
});

test('health: a FRESH start with no success yet reads "starting up" (healthy status, never failing), even after a failure', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    seedDaemon(home, 'rk', { ts: now, startedAtMs: now - 2 * MIN, lastMonitorOkMs: null, consecutiveMonitorFailures: 1, lastMonitorErrorCode: null });
    const h = health.daemonHealth(home, 'rk', { now, io: liveIo, platform: 'darwin' });
    assert.equal(h.status, 'healthy', 'must not trigger a repair/restart of a daemon that just started');
    assert.equal(h.startingUp, true, 'reported as starting up');
    assert.equal(h.monitorFault, null);
  } finally { rm(home); }
});

test('health: a success clears it — not failing, not starting up', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    seedDaemon(home, 'rk', { ts: now, startedAtMs: now - 30 * MIN, lastMonitorOkMs: now - 5000, consecutiveMonitorFailures: 0 });
    const h = health.daemonHealth(home, 'rk', { now, io: liveIo, platform: 'darwin' });
    assert.equal(h.status, 'healthy');
    assert.equal(h.startingUp, false);
    assert.equal(h.monitorFault, null);
  } finally { rm(home); }
});

test('health: the window is the devswarm.monitorNoOkFailMin setting (read from THIS home)', () => {
  const home = tmpHome();
  try {
    fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { monitorNoOkFailMin: 20 } }));
    const now = Date.now();
    seedDaemon(home, 'rk', { ts: now, startedAtMs: now - 15 * MIN, lastMonitorOkMs: null, consecutiveMonitorFailures: 0 });
    const h = health.daemonHealth(home, 'rk', { now, io: liveIo, platform: 'darwin' });
    assert.equal(h.status, 'healthy', '15 min is inside a 20-min window');
    assert.equal(h.startingUp, true);
    assert.equal(repair.monitorNoOkWindowMs(home), 20 * MIN);
  } finally { rm(home); }
});

test('health: a heartbeat without startedAtMs (older daemon) cannot prove "since start" -> UNKNOWN, never failing on that rule', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    seedDaemon(home, 'rk', { ts: now, lastMonitorOkMs: null, consecutiveMonitorFailures: 0 });
    const h = health.daemonHealth(home, 'rk', { now, io: liveIo, platform: 'darwin' });
    assert.equal(h.status, 'healthy');
    assert.equal(h.startingUp, false);
  } finally { rm(home); }
});

test.after(() => rm(LOG_DIR));

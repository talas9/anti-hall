'use strict';
// Duplicate-daemon fix (installer side): `launchctl unload` only unregisters a
// job from launchd's supervision table and signals it — it does NOT wait for
// the process to actually exit. macInstallProject used to `unload` then `load`
// back-to-back with no wait in between, so a slow-to-die (or, pre-fix,
// SIGTERM-ignoring — see devswarm-ingest.js) old daemon was still fully
// running when `load` started a brand-new one right beside it. These tests
// cover the new wait-then-SIGKILL-if-needed behavior, and the paired fix that
// a legacy per-worktree lock is only deleted once its holder is confirmed
// dead. Every test injects process/launchctl probes — never a real spawn or
// real process signal.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const m = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-ingest-wait-'));
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

test('waitForLaunchdUnitGone: no PID to wait for is a pure no-op (never sleeps, never kills)', () => {
  let slept = 0, killed = 0;
  m.waitForLaunchdUnitGone(null, { io: { sleep: () => { slept++; }, kill: () => { killed++; } } });
  m.waitForLaunchdUnitGone(NaN, { io: { sleep: () => { slept++; }, kill: () => { killed++; } } });
  assert.equal(slept, 0);
  assert.equal(killed, 0);
});

test('waitForLaunchdUnitGone: polls until the pid reports dead, then returns without killing', () => {
  let aliveChecks = 0;
  const isAlive = () => { aliveChecks++; return aliveChecks < 3; }; // dead on the 3rd check
  const sleepCalls = [];
  let killed = null;
  m.waitForLaunchdUnitGone(4242, {
    io: {
      isAlive, sleep: (ms) => sleepCalls.push(ms),
      kill: (pid, sig) => { killed = { pid, sig }; },
      now: () => 0, // deadline math never trips (0 + deadlineMs always > 0)
    },
  });
  // 3 checks inside the poll loop (alive, alive, dead — loop exits) plus one
  // final re-check before the kill decision (also dead) = 4.
  assert.equal(aliveChecks, 4, 'polled until the process reported dead, then re-confirmed before skipping the kill');
  assert.equal(sleepCalls.length, 2, 'slept between each poll while still alive');
  assert.equal(killed, null, 'never sent a kill signal — the process died on its own');
});

test('waitForLaunchdUnitGone: SIGKILLs the old pid once the deadline passes for a process that never dies AND still looks like the ingest daemon', () => {
  const isAlive = () => true; // never reports dead
  const sleepCalls = [];
  let killed = null;
  let clock = 0;
  m.waitForLaunchdUnitGone(9001, {
    io: {
      isAlive,
      sleep: (ms) => { sleepCalls.push(ms); clock += ms; },
      kill: (pid, sig) => { killed = { pid, sig }; },
      now: () => clock,
      readCmdline: (pid) => `/usr/bin/node /some/path/companion/devswarm-ingest.js (pid ${pid})`,
      deadlineMs: 1000,
    },
    deadlineMs: 1000,
    pollMs: 200,
  });
  assert.ok(sleepCalls.length >= 5, `polled through the full deadline window, got ${sleepCalls.length} polls`);
  assert.deepEqual(killed, { pid: 9001, sig: 'SIGKILL' }, 'a still-alive pid past the deadline, CONFIRMED still the ingest daemon, is force-killed');
});

// Codex review P1-1: WRONG-PROCESS-SIGKILL guard. `isAlive` only proves SOME
// process holds the pid, not that it is still our daemon — the OS can recycle
// a pid to an unrelated process during the wait window. The guard must
// re-confirm identity via the command line immediately before killing, and
// fail toward NOT killing on any inconclusive read.
// NOTE on `deadlineMs: 0` below: waitForLaunchdUnitGone reads deadlineMs from
// the TOP-LEVEL opts (not opts.io), computing `deadline = now() + deadlineMs`.
// With deadlineMs:0 and a constant now(), `now() < deadline` is false on the
// very FIRST check regardless of isAlive() — the poll loop is skipped
// entirely and control falls straight through to the post-loop kill decision,
// which is exactly the moment these tests want to observe.
test('waitForLaunchdUnitGone: does NOT kill when the pid has been reused by an unrelated command at the deadline (fail toward not killing)', () => {
  let killed = false;
  m.waitForLaunchdUnitGone(4242, {
    io: {
      isAlive: () => true,
      sleep: () => { throw new Error('must not sleep — deadlineMs:0 means the loop is skipped'); },
      kill: () => { killed = true; },
      now: () => 0,
      readCmdline: () => '/usr/bin/some-totally-unrelated-process --flag',
    },
    deadlineMs: 0,
  });
  assert.equal(killed, false, 'a pid whose command line no longer matches the ingest daemon must never be killed — likely pid reuse');
});

test('waitForLaunchdUnitGone: DOES kill when the pid is confirmed still the ingest daemon at the deadline', () => {
  let killed = null;
  m.waitForLaunchdUnitGone(4242, {
    io: {
      isAlive: () => true,
      sleep: () => { throw new Error('must not sleep — deadlineMs:0 means the loop is skipped'); },
      kill: (pid, sig) => { killed = { pid, sig }; },
      now: () => 0,
      readCmdline: () => '/usr/local/bin/node /Users/x/.claude/plugins/marketplaces/anti-hall/plugins/anti-hall/companion/devswarm-ingest.js',
    },
    deadlineMs: 0,
  });
  assert.deepEqual(killed, { pid: 4242, sig: 'SIGKILL' }, 'confirmed-same-process past the deadline is killed');
});

test('waitForLaunchdUnitGone: an inconclusive command-line probe (throws or returns empty/null) never kills', () => {
  let killedThrow = false;
  m.waitForLaunchdUnitGone(4242, {
    io: {
      isAlive: () => true, sleep: () => { throw new Error('must not sleep'); }, now: () => 0,
      kill: () => { killedThrow = true; },
      readCmdline: () => { throw new Error('ps not found'); },
    },
    deadlineMs: 0,
  });
  assert.equal(killedThrow, false, 'a throwing probe must never be treated as confirmation to kill');

  let killedEmpty = false;
  m.waitForLaunchdUnitGone(4242, {
    io: {
      isAlive: () => true, sleep: () => { throw new Error('must not sleep'); }, now: () => 0,
      kill: () => { killedEmpty = true; },
      readCmdline: () => null, // e.g. ps exited non-zero / pid already gone by the time we probe
    },
    deadlineMs: 0,
  });
  assert.equal(killedEmpty, false, 'an empty/null probe result must never be treated as confirmation to kill');
});

// Codex review round 2 on P1-1: a bare `cmdline.includes('devswarm-ingest')`
// substring check is ITSELF a wrong-process hazard — it also matches
// `tail -f ~/.anti-hall/devswarm-ingest.log`, an editor open on the script,
// or a grep for the name landing on a reused pid. looksLikeIngestDaemonCmdline
// requires the process SHAPE instead: argv[0]'s basename is node/nodejs AND
// some later argument ends with /companion/devswarm-ingest.js.
test('looksLikeIngestDaemonCmdline: matches the real daemon regardless of install location (marketplace copy or repo checkout)', () => {
  assert.equal(m.looksLikeIngestDaemonCmdline(
    'node /Users/x/.claude/plugins/marketplaces/anti-hall/plugins/anti-hall/companion/devswarm-ingest.js',
  ), true, 'marketplace install path');
  assert.equal(m.looksLikeIngestDaemonCmdline(
    '/Users/x/.nvm/versions/node/v24.14.0/bin/node /Users/x/Projects/anti-hall/plugins/anti-hall/companion/devswarm-ingest.js',
  ), true, 'repo checkout path, absolute node binary — must ALSO match, or reclaiming this shape regresses to duplicate daemons');
});

test('looksLikeIngestDaemonCmdline: rejects a non-node command that merely mentions the name/log/script (tail/vim/grep false-positive fix)', () => {
  assert.equal(m.looksLikeIngestDaemonCmdline('tail -f /Users/x/.anti-hall/devswarm-ingest.log'), false, 'tailing the log file');
  assert.equal(m.looksLikeIngestDaemonCmdline(
    'vim /Users/x/Projects/anti-hall/plugins/anti-hall/companion/devswarm-ingest.js',
  ), false, 'editing the script');
  assert.equal(m.looksLikeIngestDaemonCmdline('grep devswarm-ingest foo'), false, 'grepping for the name');
});

test('looksLikeIngestDaemonCmdline: rejects a node process running a DIFFERENT script, even one that mentions the name as an argument', () => {
  assert.equal(m.looksLikeIngestDaemonCmdline('node /some/other/script.js devswarm-ingest'), false);
});

test('looksLikeIngestDaemonCmdline: fails toward false on garbage/empty/non-string input', () => {
  assert.equal(m.looksLikeIngestDaemonCmdline(''), false);
  assert.equal(m.looksLikeIngestDaemonCmdline('   '), false);
  assert.equal(m.looksLikeIngestDaemonCmdline('node'), false, 'no script argument at all');
  assert.equal(m.looksLikeIngestDaemonCmdline(null), false);
  assert.equal(m.looksLikeIngestDaemonCmdline(undefined), false);
});

test('waitForLaunchdUnitGone end-to-end: a node process running the REAL daemon script from a repo checkout is killed; tail/vim on the matching name is not', () => {
  let killed = null;
  m.waitForLaunchdUnitGone(5150, {
    io: {
      isAlive: () => true, sleep: () => { throw new Error('must not sleep'); }, now: () => 0,
      kill: (pid, sig) => { killed = { pid, sig }; },
      readCmdline: () => '/usr/local/bin/node /Users/x/Projects/anti-hall/plugins/anti-hall/companion/devswarm-ingest.js',
    },
    deadlineMs: 0,
  });
  assert.deepEqual(killed, { pid: 5150, sig: 'SIGKILL' }, 'repo-checkout daemon is still recognized and killed');

  let killedTail = false;
  m.waitForLaunchdUnitGone(5150, {
    io: {
      isAlive: () => true, sleep: () => { throw new Error('must not sleep'); }, now: () => 0,
      kill: () => { killedTail = true; },
      readCmdline: () => 'tail -f /Users/x/.anti-hall/devswarm-ingest.log',
    },
    deadlineMs: 0,
  });
  assert.equal(killedTail, false, 'a reused pid now running `tail -f .../devswarm-ingest.log` must NOT be killed');
});

test('readLaunchdPid: parses the PID out of a mocked `launchctl list <label>` dump', () => {
  const pid = m.readLaunchdPid('com.example.test', {
    io: { run: () => ({ status: 0, stdout: '{\n\t"PID" = 4321;\n\t"Label" = "com.example.test";\n};\n' }) },
  });
  assert.equal(pid, 4321);
});

test('readLaunchdPid: job not loaded (non-zero status, empty stdout) -> null, never throws', () => {
  const pid = m.readLaunchdPid('com.example.test', {
    io: { run: () => ({ status: 113, stdout: '' }) },
  });
  assert.equal(pid, null);
});

test('readLaunchdPid: a throwing run() fails open to null', () => {
  const pid = m.readLaunchdPid('com.example.test', {
    io: { run: () => { throw new Error('boom'); } },
  });
  assert.equal(pid, null);
});

test('macInstallProject: reads the OLD daemon pid via launchctl list and waits (polls isAlive) for it to exit before returning — the wait runs between the (dry-run-protected) unload and load calls', () => {
  const home = tmpHome();
  try {
    const listCalls = [];
    let aliveChecks = 0;
    const isAlive = () => { aliveChecks++; return aliveChecks < 2; }; // alive once, then dead
    // macInstallProject's own unload/load calls go through this module's
    // module-level planRun, which is DRYRUN-protected (NODE_TEST_CONTEXT is set
    // under `node --test`) — so this test, like every other install test in
    // this suite, never spawns a real launchctl process for those two calls.
    // Only the NEW `launchctl list` probe (readLaunchdPid) is routed through
    // the injected io.run seam; the wait itself is proven via aliveChecks.
    m.macInstallProject('/repo/main', 'deadbeef01234567', {
      home,
      io: {
        run: (cmd, args) => {
          listCalls.push({ cmd, args: args.slice() });
          return { status: 0, stdout: '"PID" = 7777;' };
        },
        isAlive,
        sleep: () => {},
        kill: () => { throw new Error('must not be called — the old pid died on its own before the deadline'); },
        now: () => 0,
      },
    });
    assert.equal(listCalls.length, 1, 'readLaunchdPid queried the old job\'s pid exactly once');
    assert.ok(aliveChecks >= 2, 'polled the old pid at least twice before returning (proves the wait ran, not an immediate load)');
  } finally { rm(home); }
});

test('macInstallProject: no prior job loaded (readLaunchdPid -> null) -> load proceeds immediately, isAlive never consulted', () => {
  const home = tmpHome();
  try {
    let isAliveCalls = 0;
    m.macInstallProject('/repo/main', 'cafef00dfeedface', {
      home,
      io: {
        run: (cmd, args) => {
          if (cmd === 'launchctl' && args[0] === 'list') return { status: 113, stdout: '' }; // not loaded
          return { status: 0, stdout: '' };
        },
        isAlive: () => { isAliveCalls++; return false; },
        sleep: () => { throw new Error('must not sleep — nothing to wait for'); },
        kill: () => { throw new Error('must not kill — no prior pid'); },
      },
    });
    assert.equal(isAliveCalls, 0, 'no PID means waitForLaunchdUnitGone never even checks liveness');
  } finally { rm(home); }
});

test('stopLegacyUnitEntry: does NOT delete the legacy lock file while its recorded holder is still alive', () => {
  const home = tmpHome();
  try {
    const hash = 'abc12345';
    const lockDir = path.join(home, '.anti-hall', 'devswarm', 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, 'ingest-' + hash + '.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 55555, ts: 1, token: 't' }));
    const rmCalls = [];
    m.stopLegacyUnitEntry({ label: 'com.example.wt', unit: 'wt', hash, marker: '# wt' }, {
      home, platform: 'darwin',
      io: {
        schedRun: () => ({ status: 0, stdout: '', error: null }), // launchctl unload — mocked, never real
        schedFs: (p) => { rmCalls.push(p); },
        isAlive: (pid) => pid === 55555, // the holder is still alive
      },
    });
    assert.ok(fs.existsSync(lockPath), 'lock file must survive — its holder is still alive');
    assert.equal(rmCalls.includes(lockPath), false, 'schedFs (rm) must never be called on a live holder\'s lock');
  } finally { rm(home); }
});

test('stopLegacyUnitEntry: DOES delete the legacy lock file once its recorded holder is confirmed dead', () => {
  const home = tmpHome();
  try {
    const hash = 'def67890';
    const lockDir = path.join(home, '.anti-hall', 'devswarm', 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, 'ingest-' + hash + '.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 66666, ts: 1, token: 't' }));
    const rmCalls = [];
    m.stopLegacyUnitEntry({ label: 'com.example.wt2', unit: 'wt2', hash, marker: '# wt2' }, {
      home, platform: 'darwin',
      io: {
        schedRun: () => ({ status: 0, stdout: '', error: null }),
        schedFs: (p) => { rmCalls.push(p); fs.rmSync(p, { force: true }); },
        isAlive: (pid) => pid !== 66666, // the holder is confirmed dead
      },
    });
    assert.ok(rmCalls.includes(lockPath), 'a confirmed-dead holder\'s lock is removed');
  } finally { rm(home); }
});

test('stopLegacyUnitEntry: an unparseable/absent lock record is treated as "nothing to protect" — still removed (fail-open, unchanged from before)', () => {
  const home = tmpHome();
  try {
    const hash = 'ghi11223';
    const rmCalls = [];
    m.stopLegacyUnitEntry({ label: 'com.example.wt3', unit: 'wt3', hash, marker: '# wt3' }, {
      home, platform: 'darwin',
      io: {
        schedRun: () => ({ status: 0, stdout: '', error: null }),
        schedFs: (p) => { rmCalls.push(p); },
        isAlive: () => { throw new Error('must not be consulted — there is no pid to check'); },
      },
    });
    const lockPath = path.join(home, '.anti-hall', 'devswarm', 'locks', 'ingest-' + hash + '.lock');
    assert.ok(rmCalls.includes(lockPath), 'the (nonexistent) lock path is still passed to schedFs — no record to protect');
  } finally { rm(home); }
});

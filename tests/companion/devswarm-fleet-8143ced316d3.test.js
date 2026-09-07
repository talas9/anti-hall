'use strict';
// Regression test for defect 8143ced316d3 (P2, Group B): devswarm-pull.js's
// acquireExclLock never re-stamps mtime and never steals from a live pid
// regardless of staleness, so a HUNG-but-alive watcher (pid alive, but no
// longer doing any work) holds its lock forever and a fresh watcher can never
// arm.
//
// Fix under test (companion/lib/devswarm-pull.js): a one-shot opt-in
// `io.allowStaleLiveSteal` lets a caller steal from a live-but-stale holder,
// and the returned `release.restamp()` lets a healthy holder keep proving
// liveness every tick so it is never wrongly stolen from. `io.onRefused(info)`
// surfaces `{ pid, ageMs, version }` on a refusal so devswarm-wake-watch.js's
// REFUSED line can report the holder's pid/age/version. Callers that do not
// opt in (allowStaleLiveSteal unset) see EXACTLY the old behavior.
//
// Points at ANTIHALL_TEST_PLUGIN_ROOT (a `plugins/anti-hall`-shaped tree) so
// this SAME file proves RED against HEAD (pre-fix) and GREEN against the live,
// already-fixed working tree without duplication. Defaults to the real repo
// tree (the current, already-patched working copy).

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

const pullPath = path.join(ROOT, 'companion', 'lib', 'devswarm-pull.js');
const wakeWatchPath = path.join(ROOT, 'companion', 'lib', 'devswarm-wake-watch.js');
if (!fs.existsSync(pullPath) || !fs.existsSync(wakeWatchPath)) {
  throw new Error(
    'ANTIHALL_TEST_PLUGIN_ROOT=' + JSON.stringify(ROOT) + ' is not a plugins/anti-hall-shaped '
    + 'tree — expected to find both:\n  ' + pullPath + '\n  ' + wakeWatchPath
  );
}
const pull = require(pullPath);

function withTmpLock(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-8143ced316d3-'));
  const lockPath = path.join(dir, 'pull-primary.lock');
  try { return fn(lockPath); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('a live-but-stale holder becomes stealable once allowStaleLiveSteal is set and staleMs elapses', () => {
  withTmpLock((lockPath) => {
    let fakeNow = 1_000_000;
    const io1 = { now: () => fakeNow, isAlive: () => true, allowStaleLiveSteal: true, version: '0.96.2' };
    const release1 = pull.acquireExclLock(lockPath, io1, 1000);
    assert.ok(release1, 'first (hung) watcher arms once');

    // Time passes far beyond staleMs; holder pid is still "alive" (hung, not
    // exited) and never re-stamps (models the reported bug scenario before any
    // restamp call is made).
    fakeNow += 10 * 60 * 1000;
    const io2 = { now: () => fakeNow, isAlive: () => true, allowStaleLiveSteal: true, version: '0.97.1' };
    const release2 = pull.acquireExclLock(lockPath, io2, 1000);
    assert.ok(release2, 'a truly stale live-pid holder must become stealable when allowStaleLiveSteal is set');
  });
});

test('a healthy holder that restamps every tick is never stolen from, even well past staleMs elapsed total', () => {
  withTmpLock((lockPath) => {
    let fakeNow = 1_000_000;
    const io1 = { now: () => fakeNow, isAlive: () => true, allowStaleLiveSteal: true, version: '0.97.1' };
    const release1 = pull.acquireExclLock(lockPath, io1, 1000);
    assert.ok(release1, 'first watcher should arm');

    for (let i = 0; i < 5; i++) {
      fakeNow += 500; // well under staleMs=1000 each tick
      assert.strictEqual(release1.restamp(), true, 'restamp should succeed for the current token holder');
    }

    const io2 = { now: () => fakeNow, isAlive: () => true, allowStaleLiveSteal: true };
    const release2 = pull.acquireExclLock(lockPath, io2, 1000);
    assert.strictEqual(release2, null, 'a freshly-restamped healthy holder must never be stolen');
  });
});

test('onRefused surfaces holder pid/age/version on a refusal, and the ousted holder cannot restamp back in', () => {
  withTmpLock((lockPath) => {
    let fakeNow = 1_000_000;
    const io1 = { now: () => fakeNow, isAlive: () => true, allowStaleLiveSteal: true, version: '0.96.2' };
    const release1 = pull.acquireExclLock(lockPath, io1, 1000);
    assert.ok(release1, 'first (hung) watcher arms once');

    // Before it goes stale, a probe must still refuse (protects a genuinely
    // busy-but-healthy holder mid-tick) and report pid/age/version via onRefused.
    fakeNow += 500;
    let refused = null;
    const ioProbeEarly = {
      now: () => fakeNow, isAlive: () => true, allowStaleLiveSteal: true,
      onRefused: (info) => { refused = info; },
    };
    assert.strictEqual(pull.acquireExclLock(lockPath, ioProbeEarly, 1000), null, 'not yet stale -> still refused');
    assert.ok(refused, 'onRefused should fire on a refusal');
    assert.strictEqual(refused.pid, process.pid);
    assert.strictEqual(refused.version, '0.96.2');
    assert.ok(refused.ageMs >= 400, 'age should reflect elapsed time since last stamp');

    // Now push well past staleMs with no restamp in between -> stealable.
    fakeNow += 10000;
    const io2 = { now: () => fakeNow, isAlive: () => true, allowStaleLiveSteal: true, version: '0.97.1' };
    const release2 = pull.acquireExclLock(lockPath, io2, 1000);
    assert.ok(release2, 'a truly stale live-pid holder becomes stealable when allowStaleLiveSteal is set');

    // The old (hung) holder's restamp/release are now no-ops (token mismatch).
    assert.strictEqual(release1.restamp(), false, 'the ousted holder cannot restamp its way back in');
  });
});

test('plain lock default (allowStaleLiveSteal unset) is unchanged: a live-but-stale holder is NEVER stolen', () => {
  withTmpLock((lockPath) => {
    let fakeNow = 1_000_000;
    const release1 = pull.acquireExclLock(lockPath, { now: () => fakeNow, isAlive: () => true }, 1000);
    assert.ok(release1);
    fakeNow += 10 * 60 * 1000;
    const release2 = pull.acquireExclLock(lockPath, { now: () => fakeNow, isAlive: () => true }, 1000);
    assert.strictEqual(release2, null, 'pull.js callers that do not opt in must be completely unaffected by the fix');
  });
});

// ---------------------------------------------------------------------------
// devswarm-wake-watch.js's REFUSED path: onRefused's { pid, ageMs, version }
// must now be surfaced in the detailed stderr line (defect 8143ced316d3).
// ---------------------------------------------------------------------------

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-8143-wakewatch-'));
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

test('wake-watch REFUSED path: stderr reports the live holder pid/age/version, stdout stays closed-vocabulary', () => {
  const home = tmpHome();
  try {
    const { lockPathFor } = require(wakeWatchPath);
    const id = 'builder-8143-test';
    const lockPath = lockPathFor(home, id);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // A LIVE holder (this test process's own pid): definitely alive, with a
    // known version stamped, so onRefused's info is deterministic.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'live-holder', version: '0.96.2' }));

    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEVSWARM_REPO_ID: 'r1',
      DEVSWARM_SOURCE_BRANCH: 'main',
      DEVSWARM_BUILDER_ID: id,
    };
    const res = spawnSync(process.execPath, [wakeWatchPath], { env, encoding: 'utf8', timeout: 5000 });
    assert.strictEqual(res.status, 0);
    // Closed-vocabulary stdout line is unchanged by this fix.
    assert.strictEqual(res.stdout, '[wake-watch] REFUSED TO ARM: lock-held\n');
    // The detailed stderr line must now surface pid/age/version, not just
    // "another watcher already holds the lock".
    assert.match(res.stderr, /holder pid=\d+/);
    assert.match(res.stderr, /age=\d+s/);
    assert.match(res.stderr, new RegExp('holder pid=' + process.pid + ' age='));

    assert.ok(fs.existsSync(lockPath), 'refusal never steals/removes a live lock');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// F fix: the main loop's release.restamp() return value was previously
// discarded entirely — a `false` (lock stolen out from under a healthy-
// looking watcher) never stopped the loop, so two watchers could silently
// believe they held the same lock. Now: re-check once, then print the
// LOCK LOST line to STDERR (never stdout) and exit the loop cleanly (no kill
// of the new holder, no delete of its lock file).
// ---------------------------------------------------------------------------

const wakeWatch = require(wakeWatchPath);

test('F: formatLockLostLine uses the closed-vocabulary REFUSAL_REASONS value', () => {
  assert.strictEqual(
    wakeWatch.formatLockLostLine(wakeWatch.REFUSAL_REASONS.LOCK_HELD),
    '[wake-watch] LOCK LOST: lock-held'
  );
});

test('F (P2): readInstalledPluginVersion resolves the REAL installed plugin.json version, not a companion/lib-relative miss', () => {
  const realManifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'
  ));
  assert.strictEqual(wakeWatch.readInstalledPluginVersion(), realManifest.version,
    'readInstalledPluginVersion must resolve plugins/anti-hall/.claude-plugin/plugin.json, '
    + 'not the non-existent companion/.claude-plugin/plugin.json a single \'..\' resolves to '
    + 'from companion/lib/');
});

test('F: a watcher whose lock is stolen mid-loop prints LOCK LOST to stderr, exits cleanly, and never deletes the new holder\'s lock', async () => {
  const home = tmpHome();
  try {
    const id = 'builder-8143-lockloss-test';
    const lockPath = wakeWatch.lockPathFor(home, id);
    const seenPath = wakeWatch.seenPath(home, id);
    // fl-wave3 fix (item 7): seed a seen-state file with a value NEWER than
    // whatever this exiting watcher's own (fresh-baselined) in-memory `st`
    // would be — modeling the NEW holder (who stole the lock, below) having
    // already advanced past this exiting watcher's stale view. If cleanup()
    // still wrote its own stale state on a lock-lost exit, this seeded value
    // would be clobbered back down to the exiting watcher's lower baseline.
    fs.mkdirSync(require('node:path').dirname(seenPath), { recursive: true });
    fs.writeFileSync(seenPath, JSON.stringify({ lastTotal: 42, lastTotal2: 7 }));
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEVSWARM_REPO_ID: 'r1',
      DEVSWARM_SOURCE_BRANCH: 'main',
      DEVSWARM_BUILDER_ID: id,
      // Fast tick so the test does not need to wait multiple seconds.
      ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS: '80',
    };
    const child = require('node:child_process').spawn(process.execPath, [wakeWatchPath], { env });
    let stderrBuf = '';
    child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    let stdoutBuf = '';
    child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });

    // Wait for the watcher to arm and write its own lock file.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const deadline1 = Date.now() + 5000;
    while (!fs.existsSync(lockPath) && Date.now() < deadline1) {
      await sleep(50);
    }
    assert.ok(fs.existsSync(lockPath), 'watcher should have armed and written its own lock file');
    const ownToken = JSON.parse(fs.readFileSync(lockPath, 'utf8')).token;
    assert.ok(ownToken, 'the watcher\'s own lock must carry a token');

    // fl-wave3 fix (item 7) — timing note: the watcher's OWN loadSeenState()
    // call happens shortly AFTER it writes its lock file (verified: a race
    // where the seenPath seed is overwritten before loadSeenState runs makes
    // this whole test vacuous — the watcher would simply load whatever THIS
    // block writes next as its own initial state). Wait one extra beat past
    // the poll interval so the watcher has definitely loaded the seeded
    // 42/7 baseline before this block simulates the steal.
    await sleep(300);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(seenPath, 'utf8')), { lastTotal: 42, lastTotal2: 7 },
      'sanity: the seeded baseline must still be on disk before the steal (proves no premature overwrite already happened)');

    // Simulate a steal: overwrite the lock file with a DIFFERENT token/pid,
    // as another watcher's acquireExclLock would after a genuine steal. Also
    // model that new holder advancing the seen-state further (its own,
    // fresher progress) BEFORE this exiting watcher's next tick fires.
    const stolenToken = 'stolen-token-xyz';
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now(), token: stolenToken, version: '0.97.1' }));
    fs.writeFileSync(seenPath, JSON.stringify({ lastTotal: 99, lastTotal2: 12 }));

    const exitCode = await new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(null); }, 5000);
    });

    assert.strictEqual(exitCode, 0, 'the watcher must exit cleanly (code 0), not crash, on lock loss');
    assert.match(stderrBuf, /\[wake-watch\] LOCK LOST: lock-held/, 'lock loss must be reported on STDERR');
    assert.ok(!/LOCK LOST/.test(stdoutBuf), 'the lock-lost diagnostic must never land on stdout');

    // The new holder's lock must survive untouched — no delete of the stolen lock.
    const finalLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.strictEqual(finalLock.token, stolenToken, 'the exiting watcher must never delete/overwrite the new holder\'s lock');

    // fl-wave3 fix (item 7): the exiting watcher's cleanup() must NOT have
    // written its own (stale) seen-state over the new holder's fresher value.
    const finalSeen = JSON.parse(fs.readFileSync(seenPath, 'utf8'));
    assert.strictEqual(finalSeen.lastTotal, 99, 'a lock-lost exit must never overwrite the new holder\'s fresher seen-state');
    assert.strictEqual(finalSeen.lastTotal2, 12, 'a lock-lost exit must never overwrite the new holder\'s fresher seen-state (lastTotal2)');
  } finally { rm(home); }
});

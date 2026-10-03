'use strict';
// devswarm-version.js (SessionStart hook) — emits a one-line additionalContext
// when the installed DevSwarm CLI version SEMVER-DRIFTS (major/minor) from
// anti-hall's verified baseline. Patch-only drift and unparseable versions
// stay silent. Never blocks; fail-open + silent on every error or when
// DevSwarm is absent. Repeats are deduped per (installed, baseline) pair.

const { test, after } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK    = 'devswarm-version.js';
const HOOK_ABS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', HOOK);
const PAYLOAD = { hook_event_name: 'SessionStart', session_id: 't' };
const NOW     = Date.now();
const DAY_MS  = 24 * 60 * 60 * 1000;
const BASELINE = '2.5.1';

// Direct module require (no process spawn) — module.exports pure helpers.
// require.main !== module in this context, so main()/process.exit() never fire.
const dv = require(HOOK_ABS);
const refreshModule = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'devswarm-version-refresh.js'));
const { DEVSWARM_BASELINE } = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'devswarm-baseline.js'));

// Write the version cache to the fake home's ~/.anti-hall/devswarm-version.json.
function writeCache(h, obj) {
  h.writeState('devswarm-version.json', obj);
}

// Read the cache back as parsed JSON (or null if absent/malformed).
function readCache(h) {
  try {
    return JSON.parse(fs.readFileSync(path.join(h.antiHall, 'devswarm-version.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

// True when the hook produced a SessionStart additionalContext output.
function hasContext(r) {
  return (
    r.json &&
    r.json.hookSpecificOutput &&
    typeof r.json.hookSpecificOutput.additionalContext === 'string' &&
    r.json.hookSpecificOutput.additionalContext.length > 0
  );
}

// waitFor(predicate, timeoutMs) — synchronous busy-poll used ONLY to wait for
// a detached child (spawned by the hook under test) to finish writing a file
// before the test's fake HOME is torn down. Prevents the detached refresh
// child from recreating ~/.anti-hall via mkdirSync(recursive) AFTER h.cleanup()
// has already rm -rf'd it (the orphan-temp-dir leak this suite used to cause).
function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (predicate()) return true;
    Atomics.wait(sab, 0, 0, 25);
  }
  return predicate();
}

// emptyBinDir() — a fresh temp dir with NOTHING in it, used as PATH for tests
// that trigger the detached refresh child. Guarantees `devswarm`/`hivecontrol`
// resolve to ENOENT deterministically, regardless of whether the real DevSwarm
// CLI happens to be installed on the machine running the suite (hermetic —
// no dependency on the host's real DevSwarm install).
function emptyBinDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-emptybin-'));
}

// deferredHomes — tests that trigger a REAL detached grandchild (hook spawns
// devswarm-version-refresh.js, which itself spawnSyncs devswarm/hivecontrol)
// register their fake HOME here instead of cleaning it up inline. A single
// end-of-suite after() hook (below) then waits — with a MUCH more generous
// budget than any individual test can afford — for that grandchild to finish
// before rm -rf'ing the home. This is what actually fixes the T-3 leak: a
// per-test 5s wait can still lose the race under heavy machine load (this
// dev box routinely runs many parallel Claude sessions per CLAUDE.md), so
// waiting is centralized to the very end where a generous bound costs
// nothing (nothing else in the suite depends on these homes existing).
const deferredHomes = [];
function deferCleanup(h, isDone) {
  deferredHomes.push({ h, isDone });
}
after(() => {
  for (const { h, isDone } of deferredHomes) {
    waitFor(isDone, 20000); // best-effort; cleanup runs regardless below
    h.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Pure helper unit tests (no process spawn) — P1-B semver-aware comparison.
// ─────────────────────────────────────────────────────────────────────────

test('classifyVersionDrift: exact match => no advise, reason match', () => {
  assert.deepStrictEqual(dv.classifyVersionDrift('2.5.1', '2.5.1'), { advise: false, reason: 'match' });
});

test('classifyVersionDrift: patch-only drift => no advise, reason patch', () => {
  assert.deepStrictEqual(dv.classifyVersionDrift('2.5.2', '2.5.1'), { advise: false, reason: 'patch' });
  assert.deepStrictEqual(dv.classifyVersionDrift('2.5.1', '2.5.9'), { advise: false, reason: 'patch' });
});

test('classifyVersionDrift: minor bump => advise, reason newer', () => {
  assert.deepStrictEqual(dv.classifyVersionDrift('2.6.0', '2.5.1'), { advise: true, reason: 'newer' });
});

test('classifyVersionDrift: major bump => advise, reason newer', () => {
  assert.deepStrictEqual(dv.classifyVersionDrift('3.0.0', '2.5.1'), { advise: true, reason: 'newer' });
});

test('classifyVersionDrift: downgrade (installed older, major/minor) => advise, reason older', () => {
  assert.deepStrictEqual(dv.classifyVersionDrift('2.4.9', '2.5.1'), { advise: true, reason: 'older' });
  assert.deepStrictEqual(dv.classifyVersionDrift('1.9.9', '2.5.1'), { advise: true, reason: 'older' });
});

test('classifyVersionDrift: unparseable installed or baseline => no advise, never throws', () => {
  assert.deepStrictEqual(dv.classifyVersionDrift('not-a-version', '2.5.1'), { advise: false, reason: 'unparseable' });
  assert.deepStrictEqual(dv.classifyVersionDrift('2.5.1', 'not-a-version'), { advise: false, reason: 'unparseable' });
  assert.deepStrictEqual(dv.classifyVersionDrift(null, '2.5.1'), { advise: false, reason: 'unparseable' });
  assert.deepStrictEqual(dv.classifyVersionDrift(undefined, '2.5.1'), { advise: false, reason: 'unparseable' });
  assert.deepStrictEqual(dv.classifyVersionDrift('', '2.5.1'), { advise: false, reason: 'unparseable' });
});

test('alreadyAdvised: malformed/missing lastAdvised never suppresses (fail-open)', () => {
  assert.strictEqual(dv.alreadyAdvised({}, '2.6.0', '2.5.1'), false);
  assert.strictEqual(dv.alreadyAdvised({ lastAdvised: null }, '2.6.0', '2.5.1'), false);
  assert.strictEqual(dv.alreadyAdvised({ lastAdvised: 'garbage' }, '2.6.0', '2.5.1'), false);
  assert.strictEqual(dv.alreadyAdvised({ lastAdvised: {} }, '2.6.0', '2.5.1'), false);
});

test('alreadyAdvised: exact pair match suppresses; either field changing re-arms', () => {
  const cache = { lastAdvised: { installed: '2.6.0', baseline: '2.5.1' } };
  assert.strictEqual(dv.alreadyAdvised(cache, '2.6.0', '2.5.1'), true);
  assert.strictEqual(dv.alreadyAdvised(cache, '2.7.0', '2.5.1'), false); // installed changed
  assert.strictEqual(dv.alreadyAdvised(cache, '2.6.0', '2.6.0'), false); // baseline changed
});

// ─────────────────────────────────────────────────────────────────────────
// P2-C: BASELINE is ONE authoritative constant — all three consumers require
// the same module and therefore cannot diverge structurally.
// ─────────────────────────────────────────────────────────────────────────

test('BASELINE cannot diverge: hook, refresh script, and shared module agree', () => {
  assert.strictEqual(dv.BASELINE, DEVSWARM_BASELINE);
  assert.strictEqual(refreshModule.BASELINE, DEVSWARM_BASELINE);
  assert.strictEqual(dv.BASELINE, refreshModule.BASELINE);
});

// ─────────────────────────────────────────────────────────────────────────
// T-2: spawnRefresh is detached + unref'd — a PROPERTY assertion, not a
// generous latency bound a blocking spawn could still pass.
// ─────────────────────────────────────────────────────────────────────────

test('spawnRefresh: spawns the refresh script detached+ignored and unref()s the child', () => {
  let capturedCmd = null;
  let capturedArgs = null;
  let capturedOpts = null;
  let unrefCalled = false;
  const fakeSpawn = (cmd, args, opts) => {
    capturedCmd = cmd;
    capturedArgs = args;
    capturedOpts = opts;
    return { unref: () => { unrefCalled = true; } };
  };

  dv.spawnRefresh(fakeSpawn);

  assert.strictEqual(capturedCmd, process.execPath);
  assert.strictEqual(capturedArgs.length, 1);
  assert.match(capturedArgs[0], /devswarm-version-refresh\.js$/);
  assert.strictEqual(capturedOpts.detached, true, 'must be detached — SessionStart cannot block on this child');
  assert.strictEqual(capturedOpts.stdio, 'ignore');
  assert.strictEqual(unrefCalled, true, 'must unref() so the parent event loop is never held open by the child');
});

test('spawnRefresh: a throwing spawnFn fails open, never throws', () => {
  assert.doesNotThrow(() => {
    dv.spawnRefresh(() => { throw new Error('spawn failed'); });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Black-box hook contract tests (T-1: real observable behavior, not bare
// status/hasContext checks).
// ─────────────────────────────────────────────────────────────────────────

test('NO ALERT: fresh cache, installed matches baseline exactly => no additionalContext', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: BASELINE, baseline: BASELINE, checkedAt: NOW, source: 'devswarm' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should not alert when versions match; stdout: ${r.stdout}`);
    assert.strictEqual(r.stdout.trim(), '', 'must emit nothing at all on a match');
  } finally { h.cleanup(); }
});

test('NO ALERT: fresh cache, PATCH-only drift => silent (patches do not rename verbs)', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: '2.5.9', baseline: BASELINE, checkedAt: NOW, source: 'devswarm' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `patch-only drift must stay silent; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('ALERT: fresh cache, MINOR drift => one-line advisory naming both versions', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: '2.6.0', baseline: BASELINE, checkedAt: NOW, source: 'devswarm' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0, `exit 0; stderr: ${r.stderr}`);
    assert.ok(hasContext(r), `expected additionalContext; stdout: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /2\.6\.0/);
    assert.match(ctx, new RegExp(BASELINE.replace(/\./g, '\\.')));
    assert.match(ctx, /docs\/KB-devswarm-hivecontrol\.md/);
    // Exactly one line (advisory only — never more than a single nudge).
    assert.strictEqual(ctx.split('\n').length, 1, `expected a single line; got: ${JSON.stringify(ctx)}`);
  } finally { h.cleanup(); }
});

test('ALERT: fresh cache, MAJOR bump => advisory fires', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: '3.0.0', baseline: BASELINE, checkedAt: NOW, source: 'devswarm' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(r), `expected additionalContext for a major bump; stdout: ${r.stdout}`);
    assert.match(r.json.hookSpecificOutput.additionalContext, /3\.0\.0/);
  } finally { h.cleanup(); }
});

test('ALERT: DOWNGRADE (installed older than baseline) => advisory wording reflects older, not newer', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: '2.3.0', baseline: BASELINE, checkedAt: NOW, source: 'devswarm' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(r), `expected additionalContext for a downgrade; stdout: ${r.stdout}`);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /2\.3\.0/);
    assert.match(ctx, new RegExp(BASELINE.replace(/\./g, '\\.')));
    assert.strictEqual(ctx.split('\n').length, 1);
  } finally { h.cleanup(); }
});

test('NO ALERT: unparseable installed version (still non-empty string) => silent, never throws', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: 'garbage-not-semver', baseline: BASELINE, checkedAt: NOW, source: 'devswarm' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `unparseable installed must be silent; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── DEDUPE (P1-A) ────────────────────────────────────────────────────────

test('DEDUPE: first run advises AND persists lastAdvised in the SAME cache file', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: '2.6.0', baseline: BASELINE, checkedAt: NOW, source: 'devswarm' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(r), `first run should advise; stdout: ${r.stdout}`);

    const cache = readCache(h);
    assert.ok(cache, 'cache file must still exist after the hook runs');
    assert.deepStrictEqual(cache.lastAdvised, { installed: '2.6.0', baseline: BASELINE });
    // Original probe fields must survive the rewrite untouched.
    assert.strictEqual(cache.installed, '2.6.0');
    assert.strictEqual(cache.source, 'devswarm');
    assert.strictEqual(cache.checkedAt, NOW);
    // No stray .tmp file left behind (atomic rename completed).
    const files = fs.readdirSync(h.antiHall);
    assert.ok(!files.some((f) => f.includes('.tmp.')), `no leftover tmp files; found: ${files.join(',')}`);
  } finally { h.cleanup(); }
});

test('DEDUPE: second run with the SAME (installed, baseline) pair is suppressed', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: '2.6.0', baseline: BASELINE, checkedAt: NOW, source: 'devswarm' });
    const first = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(first), 'first run must advise');

    // checkedAt must stay within the 24h freshness window for the second run
    // to read the cache as fresh (rather than triggering a refresh spawn).
    const second = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(second.status, 0);
    assert.ok(!hasContext(second), `repeat advisory for an unchanged pair must be suppressed; stdout: ${second.stdout}`);
  } finally { h.cleanup(); }
});

test('DEDUPE: re-arms when installed changes (new drift) even though baseline is unchanged', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: '2.6.0', baseline: BASELINE, checkedAt: NOW, source: 'devswarm' });
    const first = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(first));

    // Simulate a fresh probe landing a DIFFERENT installed version.
    writeCache(h, { installed: '2.7.0', baseline: BASELINE, checkedAt: NOW, source: 'devswarm', lastAdvised: { installed: '2.6.0', baseline: BASELINE } });
    const second = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(second), `changed installed version must re-arm the advisory; stdout: ${second.stdout}`);
    assert.match(second.json.hookSpecificOutput.additionalContext, /2\.7\.0/);
  } finally { h.cleanup(); }
});

test('DEDUPE: malformed lastAdvised field never suppresses a real mismatch (fail-open)', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: '2.6.0', baseline: BASELINE, checkedAt: NOW, source: 'devswarm', lastAdvised: 'not-an-object' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.ok(hasContext(r), `malformed lastAdvised must not suppress correctness; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── DevSwarm absent / unparseable (fail-open, silent) ───────────────────

test('FAIL-OPEN: DevSwarm absent (installed:null) => no additionalContext', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: null, baseline: BASELINE, checkedAt: NOW, source: null });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should be silent when DevSwarm is absent; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: unparseable/empty installed field => no additionalContext', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: '', baseline: BASELINE, checkedAt: NOW, source: null });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should be silent on empty installed; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── Cache absent / stale => detached refresh spawned, no alert this run ──
// HERMETIC (T-4): PATH points at an empty temp dir, so the detached child's
// probe of `devswarm`/`hivecontrol` resolves to ENOENT deterministically —
// no dependency on whether the real DevSwarm CLI happens to be installed on
// the machine running this suite.
// LEAK-SAFE (T-3): we WAIT for the detached child to actually write the
// cache file before calling h.cleanup(), so the child never races a torn-down
// HOME and recreates an orphan ~/.anti-hall after cleanup.

test('NO ALERT: cache absent => exits 0 immediately, detached refresh spawned + completes hermetically', () => {
  const h = makeHome();
  const bin = emptyBinDir();
  try {
    const start = Date.now();
    const r = testHook(HOOK, PAYLOAD, { home: h.home, env: { PATH: bin } });
    const elapsed = Date.now() - start;
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should not alert with no cache; stdout: ${r.stdout}`);
    assert.ok(elapsed < 5000, `hook itself should return promptly; took ${elapsed}ms`);

    const cachePath = path.join(h.antiHall, 'devswarm-version.json');
    const wrote = waitFor(() => fs.existsSync(cachePath), 8000);
    assert.ok(wrote, 'detached refresh child must eventually write the cache file');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.strictEqual(cache.installed, null, 'empty PATH => devswarm/hivecontrol both ENOENT => installed:null');
    assert.strictEqual(cache.source, null);
    assert.strictEqual(cache.baseline, BASELINE);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    // Defer h.cleanup(): under heavy machine load the grandchild (refresh ->
    // devswarm/hivecontrol probes) can still be finishing its write past this
    // point even though we already observed it above — rm -rf'ing now would
    // race a SECOND, slower write and leak an orphan dir (T-3). The after()
    // hook waits generously and cleans up once, at the very end.
    deferCleanup(h, () => fs.existsSync(path.join(h.antiHall, 'devswarm-version.json')));
  }
});

test('NO ALERT: stale cache (>24h old) => exits 0, refresh spawned and overwrites the cache', () => {
  const h = makeHome();
  const bin = emptyBinDir();
  let isRefreshed = () => false;
  try {
    writeCache(h, { installed: '2.6.0', baseline: BASELINE, checkedAt: NOW - DAY_MS - 1, source: 'devswarm' });
    const start = Date.now();
    const r = testHook(HOOK, PAYLOAD, { home: h.home, env: { PATH: bin } });
    const elapsed = Date.now() - start;
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `stale cache must not alert this session; stdout: ${r.stdout}`);
    assert.ok(elapsed < 5000, `hook itself should return promptly; took ${elapsed}ms`);

    const cachePath = path.join(h.antiHall, 'devswarm-version.json');
    isRefreshed = () => {
      try {
        const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        return c.checkedAt > NOW - DAY_MS; // freshly re-written, not the stale seed value
      } catch (_) { return false; }
    };
    const refreshed = waitFor(isRefreshed, 8000);
    assert.ok(refreshed, 'detached refresh child must overwrite the stale cache with a fresh probe');
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    // See the cache-absent test above for why cleanup is deferred (T-3).
    deferCleanup(h, isRefreshed);
  }
});

// ── Escape hatches ────────────────────────────────────────────────────────

test('ENV off-switch: ANTIHALL_DEVSWARM_VERSION_ALERT=off => no alert', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: '2.6.0', baseline: BASELINE, checkedAt: NOW, source: 'devswarm' });
    const r = testHook(HOOK, PAYLOAD, {
      home: h.home,
      env: { ANTIHALL_DEVSWARM_VERSION_ALERT: 'off' },
    });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `off-switch should suppress; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('SKIP hatch: skip.json {"devswarm-version": future} => no alert', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: '2.6.0', baseline: BASELINE, checkedAt: NOW, source: 'devswarm' });
    h.writeSkip({ 'devswarm-version': Date.now() + 600_000 });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `skip hatch should suppress; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// ── Malformed input fail-open ─────────────────────────────────────────────

test('FAIL-OPEN: malformed cache JSON => exit 0, no alert', () => {
  // A malformed cache reads as ABSENT (readCache() throws), which is the
  // "stale/absent" branch => spawnRefresh() fires a real detached child. Same
  // hermeticity (T-4) + leak-safety (T-3) treatment as the cache-absent test:
  // empty-PATH so devswarm/hivecontrol resolve ENOENT deterministically, and
  // wait for the child to finish writing before tearing down HOME.
  const h = makeHome();
  const bin = emptyBinDir();
  try {
    h.writeState('devswarm-version.json', '{bad json!!');
    const r = testHook(HOOK, PAYLOAD, { home: h.home, env: { PATH: bin } });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `malformed cache must be silent; stdout: ${r.stdout}`);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    // See the cache-absent test above for why cleanup is deferred (T-3).
    deferCleanup(h, () => fs.existsSync(path.join(h.antiHall, 'devswarm-version.json')));
  }
});

test('FAIL-OPEN: empty stdin => exit 0, never crashes', () => {
  const h = makeHome();
  try {
    writeCache(h, { installed: '2.6.0', baseline: BASELINE, checkedAt: NOW, source: 'devswarm' });
    const r = testHookRaw(HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: future checkedAt (clock rollback) => treated as stale, no alert', () => {
  const h = makeHome();
  const bin = emptyBinDir();
  let isOverwritten = () => false;
  try {
    writeCache(h, { installed: '2.6.0', baseline: BASELINE, checkedAt: NOW + DAY_MS, source: 'devswarm' });
    const r = testHook(HOOK, PAYLOAD, { home: h.home, env: { PATH: bin } });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `future checkedAt must not read as fresh; stdout: ${r.stdout}`);

    const cachePath = path.join(h.antiHall, 'devswarm-version.json');
    isOverwritten = () => {
      try {
        return JSON.parse(fs.readFileSync(cachePath, 'utf8')).checkedAt !== NOW + DAY_MS;
      } catch (_) { return false; }
    };
    const overwritten = waitFor(isOverwritten, 8000);
    assert.ok(overwritten, 'detached refresh child must eventually overwrite the future-dated cache');
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    // See the cache-absent test above for why cleanup is deferred (T-3).
    deferCleanup(h, isOverwritten);
  }
});

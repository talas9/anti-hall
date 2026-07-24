'use strict';
// anti-hall-log.js — C0 logger-foundation: shared structured JSONL
// error/event logger. Exercises logError/logEvent's field shape, fail-open
// behavior when fs throws, size-bound rotation, and readRecent's filtering +
// tolerance of a corrupt trailing line. All tests point ANTI_HALL_LOG_DIR at
// a fresh tmp dir per test so the real ~/.anti-hall is never touched.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const MODULE_PATH = path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'anti-hall-log.js',
);

function freshLogger(envDir) {
  // Fresh require per test (with ANTI_HALL_LOG_DIR already set) so any
  // module-level state (there is none today, but this keeps tests robust
  // against that changing) can't leak between tests.
  delete require.cache[require.resolve(MODULE_PATH)];
  const prev = process.env.ANTI_HALL_LOG_DIR;
  process.env.ANTI_HALL_LOG_DIR = envDir;
  const mod = require(MODULE_PATH);
  return { mod, restore: () => {
    if (prev === undefined) delete process.env.ANTI_HALL_LOG_DIR;
    else process.env.ANTI_HALL_LOG_DIR = prev;
    delete require.cache[require.resolve(MODULE_PATH)];
  } };
}

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-log-'));
  return { d, cleanup: () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } };
}

function readLines(logDirPath) {
  const raw = fs.readFileSync(path.join(logDirPath, 'devswarm.jsonl'), 'utf8');
  return raw.split('\n').filter((l) => l.trim());
}

// ---------------------------------------------------------------------------
// logError / logEvent — field shape
// ---------------------------------------------------------------------------

test('logError: appends valid JSONL with all documented fields, err normalized from an Error', () => {
  const { d, cleanup } = tmp();
  const { mod, restore } = freshLogger(d);
  try {
    const err = new Error('boom');
    err.code = 'EBOOM';
    mod.logError('devswarm-ingest', 'flush', err, { repoKey: 'proj-abc', meshId: 'mesh-1', extra: 42 });

    const lines = readLines(d);
    assert.strictEqual(lines.length, 1);
    const entry = JSON.parse(lines[0]);

    assert.strictEqual(typeof entry.ts, 'string');
    assert.ok(!Number.isNaN(Date.parse(entry.ts)), 'ts must be a parsable ISO string');
    assert.strictEqual(entry.component, 'devswarm-ingest');
    assert.strictEqual(entry.op, 'flush');
    assert.strictEqual(entry.level, 'error');
    assert.strictEqual(entry.repoKey, 'proj-abc');
    assert.strictEqual(entry.meshId, 'mesh-1');
    assert.strictEqual(entry.pid, process.pid);
    assert.strictEqual(entry.err.message, 'boom');
    assert.strictEqual(entry.err.code, 'EBOOM');
    assert.ok(typeof entry.err.stack === 'string' && entry.err.stack.length > 0);
    assert.deepStrictEqual(entry.ctx, { extra: 42 });
  } finally { restore(); cleanup(); }
});

test('logError: accepts a plain string err (not just Error instances)', () => {
  const { d, cleanup } = tmp();
  const { mod, restore } = freshLogger(d);
  try {
    mod.logError('devswarm-store', 'write', 'disk full', {});
    const entry = JSON.parse(readLines(d)[0]);
    assert.strictEqual(entry.level, 'error');
    assert.strictEqual(entry.err.message, 'disk full');
    assert.strictEqual(entry.err.stack, undefined);
  } finally { restore(); cleanup(); }
});

test('logEvent: appends a plain event entry (no err field) with the given level and msg', () => {
  const { d, cleanup } = tmp();
  const { mod, restore } = freshLogger(d);
  try {
    mod.logEvent('devswarm-supervisor', 'heartbeat', 'info', 'daemon alive', { repoKey: 'p1' });
    const entry = JSON.parse(readLines(d)[0]);
    assert.strictEqual(entry.component, 'devswarm-supervisor');
    assert.strictEqual(entry.op, 'heartbeat');
    assert.strictEqual(entry.level, 'info');
    assert.strictEqual(entry.msg, 'daemon alive');
    assert.strictEqual(entry.repoKey, 'p1');
    assert.strictEqual('err' in entry, false);
  } finally { restore(); cleanup(); }
});

test('logEvent: repoKey falls back to DEVSWARM_REPO_KEY env when ctx omits it', () => {
  const { d, cleanup } = tmp();
  const { mod, restore } = freshLogger(d);
  const prevRepoKey = process.env.DEVSWARM_REPO_KEY;
  process.env.DEVSWARM_REPO_KEY = 'env-repo-key';
  try {
    mod.logEvent('c', 'op', 'debug', 'msg', {});
    const entry = JSON.parse(readLines(d)[0]);
    assert.strictEqual(entry.repoKey, 'env-repo-key');
  } finally {
    if (prevRepoKey === undefined) delete process.env.DEVSWARM_REPO_KEY;
    else process.env.DEVSWARM_REPO_KEY = prevRepoKey;
    restore(); cleanup();
  }
});

// ---------------------------------------------------------------------------
// Fail-open
// ---------------------------------------------------------------------------

test('logError/logEvent: a thrown fs error is swallowed — never throws into the caller', () => {
  const { d, cleanup } = tmp();
  const { mod, restore } = freshLogger(d);
  try {
    // Force the log directory to be unwritable-as-a-directory: create a FILE
    // at the path the logger will try to mkdir/write under, so mkdirSync and
    // appendFileSync both fail internally with real fs errors.
    const blockerDir = path.join(d, 'blocked');
    fs.writeFileSync(blockerDir, 'i am a file, not a directory');

    delete require.cache[require.resolve(MODULE_PATH)];
    process.env.ANTI_HALL_LOG_DIR = blockerDir;
    const blockedMod = require(MODULE_PATH);

    assert.doesNotThrow(() => blockedMod.logError('c', 'op', new Error('x'), {}));
    assert.doesNotThrow(() => blockedMod.logEvent('c', 'op', 'warn', 'x', {}));
    // Nothing could have been written since the "directory" is a file.
    assert.strictEqual(fs.readFileSync(blockerDir, 'utf8'), 'i am a file, not a directory');
  } finally { restore(); cleanup(); }
});

test('readRecent: returns [] (not a throw) when the log file does not exist yet', () => {
  const { d, cleanup } = tmp();
  const { mod, restore } = freshLogger(d);
  try {
    assert.deepStrictEqual(mod.readRecent(), []);
  } finally { restore(); cleanup(); }
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

test('rotation: exceeding the size bound rotates current file to .1 and preserves its prior entries', () => {
  const { d, cleanup } = tmp();
  const { mod, restore } = freshLogger(d);
  try {
    // Write one small marker entry first, so we can prove it survives the
    // rotation inside the .1 file.
    mod.logEvent('marker', 'first', 'info', 'the original entry', {});
    const logPath = mod.logFilePath();
    const rotatedPath = mod.rotatedFilePath();

    // Pad the current file directly past MAX_LOG_BYTES so the NEXT logged
    // entry is the one that triggers rotation (keeps this test fast — no
    // need to call logEvent thousands of times to grow the file for real).
    const padding = 'x'.repeat(mod.MAX_LOG_BYTES + 1024);
    fs.appendFileSync(logPath, padding + '\n');

    assert.ok(!fs.existsSync(rotatedPath), 'no .1 file before the triggering write');

    mod.logEvent('marker', 'second', 'info', 'the triggering entry', {});

    assert.ok(fs.existsSync(rotatedPath), '.1 file must exist after rotation');
    assert.ok(fs.existsSync(logPath), 'a fresh current file must exist after rotation');

    const rotatedRaw = fs.readFileSync(rotatedPath, 'utf8');
    assert.ok(rotatedRaw.includes('the original entry'), 'prior entry preserved in rotated .1 file');
    assert.ok(rotatedRaw.includes(padding), 'padding (bulk of old file) preserved in rotated .1 file');

    const currentRaw = fs.readFileSync(logPath, 'utf8');
    assert.ok(currentRaw.includes('the triggering entry'), 'triggering entry lands in the fresh current file');
    assert.ok(!currentRaw.includes('the original entry'), 'fresh current file must not contain old entries');
  } finally { restore(); cleanup(); }
});

test('rotation: a second rotation overwrites the prior .1 (bounds total growth to ~2x MAX_LOG_BYTES)', () => {
  const { d, cleanup } = tmp();
  const { mod, restore } = freshLogger(d);
  try {
    const logPath = mod.logFilePath();
    const rotatedPath = mod.rotatedFilePath();

    fs.appendFileSync(logPath, 'x'.repeat(mod.MAX_LOG_BYTES + 1024) + '\n');
    mod.logEvent('marker', 'rotation-one', 'info', 'first rotation trigger', {});
    assert.ok(fs.readFileSync(rotatedPath, 'utf8').includes('rotation-one') === false); // marker landed in current, not yet rotated in
    const afterFirst = fs.statSync(rotatedPath).size;
    assert.ok(afterFirst > 0);

    fs.appendFileSync(logPath, 'x'.repeat(mod.MAX_LOG_BYTES + 1024) + '\n');
    mod.logEvent('marker', 'rotation-two', 'info', 'second rotation trigger', {});

    const rotatedRaw = fs.readFileSync(rotatedPath, 'utf8');
    assert.ok(rotatedRaw.includes('rotation-one'), 'the entry that triggered the FIRST rotation is now inside the SECOND .1');
    assert.ok(!rotatedRaw.includes('the original entry'), 'stale content from before the first rotation is gone (only one .1 kept)');
  } finally { restore(); cleanup(); }
});

test('rotation: many concurrent OS threads rotating at once never lose entries (concurrent-rotation regression)', async () => {
  const { d, cleanup } = tmp();
  const { mod, restore } = freshLogger(d);
  try {
    mod.logEvent('marker', 'original', 'info', 'must survive rotation', {});
    const logPath = mod.logFilePath();
    const rotatedPath = mod.rotatedFilePath();
    // Pre-pad past the bound so EVERY concurrent participant's first
    // logEvent() call independently observes "needs rotation" at (near) the
    // same instant — the exact precondition of the 32-process repro that lost
    // the 5 MiB marker from BOTH the live file and the `.1` backup.
    fs.appendFileSync(logPath, 'x'.repeat(mod.MAX_LOG_BYTES + 1024) + '\n');

    const WORKER_PATH = path.join(__dirname, '..', 'helpers', 'rotation-race-worker.js');
    const N = 24;
    // Shared Int32Array barrier: every worker blocks on Atomics.wait until the
    // main thread flips it, so all N logEvent() calls fire as close to
    // simultaneously as real OS threads allow — worker_threads run
    // synchronous fs calls on separate libuv threadpool threads, giving true
    // concurrency that a staggered child-process spawn does not reliably
    // reproduce.
    const sab = new Int32Array(new SharedArrayBuffer(4));
    const runs = [];
    for (let i = 0; i < N; i++) {
      const w = new Worker(WORKER_PATH, { workerData: { i, dir: d, sabBuffer: sab.buffer, modulePath: MODULE_PATH } });
      runs.push(new Promise((resolve, reject) => {
        w.on('error', reject);
        w.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('worker ' + i + ' exited ' + code))));
      }));
    }
    // Give every worker time to spin up and reach Atomics.wait before releasing.
    await new Promise((resolve) => setTimeout(resolve, 200));
    Atomics.store(sab, 0, 1);
    Atomics.notify(sab, 0);
    await Promise.all(runs);

    const combined = fs.readFileSync(logPath, 'utf8')
      + '\n' + (fs.existsSync(rotatedPath) ? fs.readFileSync(rotatedPath, 'utf8') : '');
    assert.ok(combined.includes('must survive rotation'), 'the pre-existing entry is not lost across concurrent rotation');
    for (let i = 0; i < N; i++) {
      assert.ok(combined.includes('concurrent entry ' + i), 'entry from concurrent worker ' + i + ' must not be lost');
    }
  } finally { restore(); cleanup(); }
});

// ---------------------------------------------------------------------------
// readRecent — filtering + corrupt-line tolerance
// ---------------------------------------------------------------------------

test('readRecent: filters by repoKey, component, minLevel, and limit; returns newest-last', () => {
  const { d, cleanup } = tmp();
  const { mod, restore } = freshLogger(d);
  try {
    mod.logEvent('ingest', 'a', 'debug', 'm1', { repoKey: 'p1' });
    mod.logEvent('ingest', 'b', 'warn', 'm2', { repoKey: 'p1' });
    mod.logEvent('supervisor', 'c', 'error', 'm3', { repoKey: 'p2' });
    mod.logEvent('ingest', 'd', 'error', 'm4', { repoKey: 'p1' });

    const byRepo = mod.readRecent({ repoKey: 'p1' });
    assert.strictEqual(byRepo.length, 3);
    assert.deepStrictEqual(byRepo.map((e) => e.op), ['a', 'b', 'd']);

    const byComponent = mod.readRecent({ component: 'supervisor' });
    assert.strictEqual(byComponent.length, 1);
    assert.strictEqual(byComponent[0].op, 'c');

    const byMinLevel = mod.readRecent({ minLevel: 'warn' });
    assert.deepStrictEqual(byMinLevel.map((e) => e.op), ['b', 'c', 'd']);

    const limited = mod.readRecent({ limit: 2 });
    // newest-last: the LAST two entries written, in original order.
    assert.deepStrictEqual(limited.map((e) => e.op), ['c', 'd']);

    const combined = mod.readRecent({ repoKey: 'p1', minLevel: 'error' });
    assert.deepStrictEqual(combined.map((e) => e.op), ['d']);
  } finally { restore(); cleanup(); }
});

test('readRecent: sinceMs keeps only entries at/after the given absolute cutoff', () => {
  const { d, cleanup } = tmp();
  const { mod, restore } = freshLogger(d);
  try {
    mod.logEvent('c', 'old', 'info', 'm', {});
    const cutoff = Date.now() + 5; // strictly after the entry just written
    // Busy-wait a hair past the cutoff without a real sleep, so the next
    // entry's ts is guaranteed >= cutoff.
    while (Date.now() < cutoff) { /* spin */ }
    mod.logEvent('c', 'new', 'info', 'm', {});

    const recent = mod.readRecent({ sinceMs: cutoff });
    assert.deepStrictEqual(recent.map((e) => e.op), ['new']);
  } finally { restore(); cleanup(); }
});

test('readRecent: tolerates a corrupt/truncated trailing line, returning the valid entries around it', () => {
  const { d, cleanup } = tmp();
  const { mod, restore } = freshLogger(d);
  try {
    mod.logEvent('c', 'good-1', 'info', 'm', {});
    mod.logEvent('c', 'good-2', 'info', 'm', {});
    // Simulate a process killed mid-write: append a truncated JSON fragment
    // with no trailing newline.
    fs.appendFileSync(mod.logFilePath(), '{"ts":"2026-01-01T00:00:00.000Z","component":"c","op":"trunc');

    const entries = mod.readRecent();
    assert.deepStrictEqual(entries.map((e) => e.op), ['good-1', 'good-2']);
  } finally { restore(); cleanup(); }
});

test('readRecent: tolerates a corrupt line in the MIDDLE of the file too, not just trailing', () => {
  const { d, cleanup } = tmp();
  const { mod, restore } = freshLogger(d);
  try {
    mod.logEvent('c', 'good-1', 'info', 'm', {});
    fs.appendFileSync(mod.logFilePath(), 'not json at all\n');
    mod.logEvent('c', 'good-2', 'info', 'm', {});

    const entries = mod.readRecent();
    assert.deepStrictEqual(entries.map((e) => e.op), ['good-1', 'good-2']);
  } finally { restore(); cleanup(); }
});

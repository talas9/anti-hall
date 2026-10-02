'use strict';
// lock.js release() runs its owner check + unlink under the reclaim sidecar
// (a stealer can no longer publish between our read and our unlink), and the
// wake-watch heartbeat loop treats a transient refresh 'error' as "retry next
// tick", exiting only on a genuine lost lock or after the lock's stale bound.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const L = require(path.join(ROOT, 'companion', 'lib', 'lock.js'));
const wakeWatchPath = path.join(ROOT, 'companion', 'lib', 'devswarm-wake-watch.js');
const wakeWatch = require(wakeWatchPath);
const pull = require(path.join(ROOT, 'companion', 'lib', 'devswarm-pull.js'));

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-lockrel-'));
  return { dir, p: path.join(dir, 'sub', 'x.lock'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => /\.(tmp|reap|reclaim|hb)[-.]?/.test(n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('release: a stealer cannot publish between our read and our unlink (its lock survives)', () => {
  const t = tmp();
  try {
    let armed = false;
    let stealer = 'not-run';
    const hooked = Object.assign({}, fs, {
      readFileSync(f, ...rest) {
        const out = fs.readFileSync(f, ...rest);
        if (armed && f === t.p) {
          armed = false;
          // A stealer that judges us stale tries to reclaim + publish now.
          stealer = L.acquire(t.p, { decide: () => 'steal', maxTries: 2 });
        }
        return out;
      },
    });
    const h = L.acquire(t.p, { fs: hooked });
    armed = true;
    assert.strictEqual(h.release(), true);
    assert.strictEqual(stealer, null, 'the stealer is held off by the sidecar while we release');
    assert.strictEqual(fs.existsSync(t.p), false, 'our own lock was removed');
    assert.deepStrictEqual(leftovers(path.dirname(t.p)), []);
  } finally { t.cleanup(); }
});

test('release: a stealer that already published is never deleted (token mismatch)', () => {
  const t = tmp();
  try {
    const a = L.acquire(t.p);
    fs.writeFileSync(t.p, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'stealer' }));
    assert.strictEqual(a.release(), false);
    assert.strictEqual(JSON.parse(fs.readFileSync(t.p, 'utf8')).token, 'stealer');
    assert.deepStrictEqual(leftovers(path.dirname(t.p)), []);
  } finally { t.cleanup(); }
});

test('release/refresh normal path: removes own lock, never leaves the sidecar behind', () => {
  const t = tmp();
  try {
    const h = L.acquire(t.p);
    assert.strictEqual(h.refresh(), true);
    assert.deepStrictEqual(leftovers(path.dirname(t.p)), [], 'no sidecar after refresh');
    assert.strictEqual(h.release(), true);
    assert.strictEqual(fs.existsSync(t.p), false);
    assert.deepStrictEqual(leftovers(path.dirname(t.p)), [], 'no sidecar after release');
    assert.strictEqual(h.release(), false, 'second release is a no-op');
  } finally { t.cleanup(); }
});

test('release: a busy sidecar is waited for briefly (bounded), then falls back to read-then-unlink', () => {
  const t = tmp();
  try {
    const h = L.acquire(t.p);
    // A live, fresh reclaimer holds the sidecar for the whole bound.
    fs.writeFileSync(t.p + '.reclaim', JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'S' }));
    const t0 = Date.now();
    assert.strictEqual(h.release(), true, 'still removes our own lock after the bound');
    const took = Date.now() - t0;
    assert.ok(took < 1000, 'bounded wait, took ' + took + 'ms');
    assert.strictEqual(fs.existsSync(t.p), false);
    assert.ok(fs.existsSync(t.p + '.reclaim'), 'a sidecar we did not take is left alone');
  } finally { t.cleanup(); }
});

test('restamp is tri-state: true / false (lost) / "error" (busy sidecar or torn read)', () => {
  const t = tmp();
  try {
    const rel = pull.acquireExclLock(t.p, {}, 60000);
    assert.ok(rel);
    assert.strictEqual(rel.restamp(), true);
    fs.writeFileSync(t.p + '.reclaim', JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'S' }));
    assert.strictEqual(rel.restamp(), 'error', 'a busy reclaim sidecar is transient, not loss');
    fs.unlinkSync(t.p + '.reclaim');
    fs.writeFileSync(t.p, '{torn');
    assert.strictEqual(rel.restamp(), 'error');
    fs.writeFileSync(t.p, JSON.stringify({ pid: 1, ts: Date.now(), token: 'other' }));
    assert.strictEqual(rel.restamp(), false, 'foreign token is a definitive loss');
  } finally { t.cleanup(); }
});

// --- wake-watch heartbeat loop: real watcher child, real sidecar/lock files ---

function startWatcher(home, id, preload) {
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    DEVSWARM_REPO_ID: 'r1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: id,
    ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS: '80',
  };
  const args = (preload ? ['-r', preload] : []).concat([wakeWatchPath]);
  const child = cp.spawn(process.execPath, args, { env });
  const st = { err: '', exit: undefined };
  child.stderr.on('data', (d) => { st.err += d; });
  child.stdout.on('data', () => {});
  child.on('exit', (c) => { st.exit = c; });
  return { child, st };
}
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(30); }
  return !!fn();
}

test('wake-watch: a transient refresh error does not end the watcher; it recovers; a lost lock still exits', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ww-'));
  let w = null;
  try {
    const id = 'builder-lockrel-1';
    const lockPath = wakeWatch.lockPathFor(home, id);
    w = startWatcher(home, id);
    assert.ok(await waitFor(() => fs.existsSync(lockPath), 5000), 'watcher armed');
    await sleep(300);
    const tsOf = () => JSON.parse(fs.readFileSync(lockPath, 'utf8')).ts;

    // A live reclaimer holds the sidecar for many ticks (> the old 2 back-to-back retries).
    const side = lockPath + '.reclaim';
    const holdSidecar = setInterval(() => {
      try { fs.writeFileSync(side, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'S' })); } catch (_) {}
    }, 20);
    await sleep(900); // ~10 ticks of 'error'
    clearInterval(holdSidecar);
    assert.strictEqual(w.st.exit, undefined, 'watcher survived transient errors; stderr=' + w.st.err);
    assert.ok(!/LOCK LOST/.test(w.st.err));
    fs.rmSync(side, { force: true });
    const before = tsOf();
    assert.ok(await waitFor(() => tsOf() > before, 3000), 'heartbeat resumed once the sidecar cleared');
    assert.strictEqual(w.st.exit, undefined);

    // Genuine loss: foreign token. Re-assert like the existing lost-lock test.
    const steal = () => fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now(), token: 'stolen' }));
    const re = setInterval(() => { try { steal(); } catch (_) {} }, 20);
    try { assert.ok(await waitFor(() => w.st.exit !== undefined, 5000), 'watcher exited on a genuine lost lock'); }
    finally { clearInterval(re); }
    assert.strictEqual(w.st.exit, 0);
    assert.match(w.st.err, /LOCK LOST: lock-held/);
  } finally {
    if (w && w.st.exit === undefined) { try { w.child.kill('SIGKILL'); } catch (_) {} }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('wake-watch: transient errors persisting past the lock stale threshold fall back to the lost-lock exit', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ww-'));
  let w = null;
  try {
    const id = 'builder-lockrel-2';
    const lockPath = wakeWatch.lockPathFor(home, id);
    // Preload: Date.now jumps forward by 3 min (> WATCH_LOCK_STALE_MS) once a flag file exists.
    const flag = path.join(home, 'jump.flag');
    const preload = path.join(home, 'preload.js');
    fs.writeFileSync(preload, `const real = Date.now.bind(Date); const fs = require('fs');\n`
      + `Date.now = () => real() + (fs.existsSync(${JSON.stringify(flag)}) ? 3 * 60 * 1000 : 0);\n`);
    w = startWatcher(home, id, preload);
    assert.ok(await waitFor(() => fs.existsSync(lockPath), 5000), 'watcher armed');
    await sleep(300);
    // Persistent transient error: a torn (unparseable) lock record.
    fs.writeFileSync(lockPath, '{torn');
    await sleep(500);
    assert.strictEqual(w.st.exit, undefined, 'within the bound the watcher keeps running; stderr=' + w.st.err);
    fs.writeFileSync(flag, '1'); // time passes beyond the stale threshold
    assert.ok(await waitFor(() => w.st.exit !== undefined, 5000), 'watcher exits after the bound');
    assert.strictEqual(w.st.exit, 0);
    assert.match(w.st.err, /longer than the lock stale threshold/);
    assert.match(w.st.err, /LOCK LOST: lock-held/);
  } finally {
    if (w && w.st.exit === undefined) { try { w.child.kill('SIGKILL'); } catch (_) {} }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

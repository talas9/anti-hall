'use strict';
// companion/lib/lock.js — the single cross-process lock primitive. Covers:
// two-process contention (real child processes), stale/dead reclaim (and the
// two-reclaimer race), the SMB/exFAT publish fallback, token-checked release
// (a non-owner can never remove the lock), the torn-read guard, refresh, and
// crash safety (a SIGKILLed holder's lock is reclaimed, no scratch left).
// Every path lives under a fresh tmpdir; child processes get an isolated HOME.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const LOCK_JS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'lock.js');
const L = require(LOCK_JS);

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-lock-'));
  return { dir, p: path.join(dir, 'sub', 'x.lock'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function childEnv(dir) {
  return Object.assign({}, process.env, { HOME: dir, USERPROFILE: dir });
}
function scratch(dir) {
  return fs.readdirSync(dir).filter((n) => /\.(tmp|reap)-/.test(n));
}

test('acquire/release: basic hold, second acquirer refused, release frees it', () => {
  const t = tmp();
  try {
    const h = L.acquire(t.p);
    assert.ok(h && typeof h.release === 'function');
    const rec = JSON.parse(fs.readFileSync(t.p, 'utf8'));
    assert.strictEqual(rec.pid, process.pid);
    assert.strictEqual(rec.host, os.hostname());
    assert.ok(Number.isFinite(rec.ts));
    assert.strictEqual(rec.token, h.token);
    assert.strictEqual(L.acquire(t.p), null, 'a live fresh holder (ourselves) is respected');
    assert.strictEqual(h.release(), true);
    assert.strictEqual(fs.existsSync(t.p), false);
    assert.deepStrictEqual(scratch(path.dirname(t.p)), [], 'no publish scratch left behind');
  } finally { t.cleanup(); }
});

test('contention: 2 real processes x 40 increments of a shared counter under withLock — no lost update', () => {
  const t = tmp();
  try {
    const counter = path.join(t.dir, 'counter');
    fs.writeFileSync(counter, '0');
    const worker = `
      const L = require(${JSON.stringify(LOCK_JS)});
      const fs = require('fs');
      let done = 0;
      while (done < 40) {
        const r = L.withLock(${JSON.stringify(t.p)}, { maxTries: Infinity, waitMs: 20000, stepMs: 1, jitterMs: 3 }, () => {
          const n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'));
          fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
          return true;
        });
        if (r === true) done++;
      }`;
    const kids = [0, 1].map(() => cp.spawn(process.execPath, ['-e', worker], { env: childEnv(t.dir), stdio: 'ignore' }));
    const codes = kids.map((k) => new Promise((res) => k.on('exit', res)));
    return Promise.all(codes).then((c) => {
      assert.deepStrictEqual(c, [0, 0]);
      assert.strictEqual(fs.readFileSync(counter, 'utf8'), '80', 'every increment serialized: no lost update');
      assert.strictEqual(fs.existsSync(t.p), false);
    }).finally(t.cleanup);
  } catch (e) { t.cleanup(); throw e; }
});

test('stale reclaim: dead holder stolen with stealDead; without it only once stale; live holder respected', () => {
  const t = tmp();
  try {
    fs.mkdirSync(path.dirname(t.p), { recursive: true });
    const now = 1_000_000;
    fs.writeFileSync(t.p, JSON.stringify({ pid: 4242, ts: now - 1000, token: 'dead' }));
    const dead = (pid) => pid !== 4242;
    assert.strictEqual(L.acquire(t.p, { now: () => now, isAlive: dead, staleMs: 60000 }), null, 'dead but fresh, stealDead off -> respected');
    const h = L.acquire(t.p, { now: () => now, isAlive: dead, staleMs: 60000, stealDead: true });
    assert.ok(h, 'dead holder reclaimed immediately under stealDead');
    h.release();
    fs.writeFileSync(t.p, JSON.stringify({ pid: 4242, ts: now - 120000, token: 'dead' }));
    const h2 = L.acquire(t.p, { now: () => now, isAlive: dead, staleMs: 60000 });
    assert.ok(h2, 'dead + stale reclaimed');
    h2.release();
    fs.writeFileSync(t.p, JSON.stringify({ pid: 4243, ts: now - 120000, token: 'live' }));
    assert.strictEqual(L.acquire(t.p, { now: () => now, isAlive: () => true, staleMs: 60000 }), null, 'live holder never stolen by default');
    const h3 = L.acquire(t.p, { now: () => now, isAlive: () => true, staleMs: 60000, liveStaleMs: 60000 });
    assert.ok(h3, 'live holder stolen past liveStaleMs when the caller opts in');
    h3.release();
    assert.deepStrictEqual(scratch(path.dirname(t.p)), []);
  } finally { t.cleanup(); }
});

test('stale reclaim race: two reclaimers of the SAME dead holder — exactly one wins, the fresh lock survives', () => {
  const t = tmp();
  try {
    fs.mkdirSync(path.dirname(t.p), { recursive: true });
    fs.writeFileSync(t.p, JSON.stringify({ pid: 999999, ts: Date.now(), token: 'dead' }));
    let nested = 'not-run';
    const racing = Object.assign({}, fs, {
      readFileSync(file, enc) {
        const raw = fs.readFileSync(file, enc);
        if (file === t.p && nested === 'not-run') nested = L.acquire(t.p, { isAlive: () => false, stealDead: true });
        return raw;
      },
    });
    const outer = L.acquire(t.p, { fs: racing, isAlive: (pid) => pid === process.pid, stealDead: true });
    assert.notStrictEqual(nested, 'not-run');
    const winners = [outer, nested].filter(Boolean);
    assert.strictEqual(winners.length, 1, 'exactly one reclaimer wins');
    assert.strictEqual(JSON.parse(fs.readFileSync(t.p, 'utf8')).token, winners[0].token, 'the winner\'s lock is the one on disk');
    assert.deepStrictEqual(scratch(path.dirname(t.p)), [], 'no .reap-* scratch left');
    winners[0].release();
  } finally { t.cleanup(); }
});

test('torn-read guard: an empty lock file with a FRESH mtime is a live holder mid-write — never stolen; an old one is', () => {
  const t = tmp();
  try {
    fs.mkdirSync(path.dirname(t.p), { recursive: true });
    fs.writeFileSync(t.p, '');
    assert.strictEqual(L.acquire(t.p, { staleMs: 60000, stealDead: true }), null, 'fresh torn file respected');
    const old = (Date.now() - 120000) / 1000;
    fs.utimesSync(t.p, old, old);
    const h = L.acquire(t.p, { staleMs: 60000 });
    assert.ok(h, 'an old torn file is reclaimed');
    h.release();
  } finally { t.cleanup(); }
});

test('SMB/exFAT fallback: linkSync EPERM -> O_EXCL create; a second acquirer is still refused', () => {
  const t = tmp();
  try {
    let links = 0;
    const noLink = Object.assign({}, fs, { linkSync() { links++; const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } });
    const h = L.acquire(t.p, { fs: noLink });
    assert.strictEqual(links, 1);
    assert.ok(h, 'fallback publish succeeded');
    assert.strictEqual(JSON.parse(fs.readFileSync(t.p, 'utf8')).token, h.token);
    assert.strictEqual(L.acquire(t.p, { fs: noLink }), null, 'fallback-published lock is respected');
    assert.strictEqual(h.release(), true);
    assert.deepStrictEqual(scratch(path.dirname(t.p)), []);
  } finally { t.cleanup(); }
});

test('SMB-like O_EXCL errors: openSync(wx) EEXIST is contention; EPERM fails open (null) or throws under throwOnError', () => {
  const t = tmp();
  try {
    let mode = 'eexist';
    const spy = Object.assign({}, fs, {
      linkSync() { const e = new Error('ENOTSUP'); e.code = 'ENOTSUP'; throw e; },
      openSync(p, flags, ...rest) {
        if (p === t.p && flags === 'wx') { const e = new Error(mode); e.code = mode === 'eexist' ? 'EEXIST' : 'EPERM'; throw e; }
        return fs.openSync(p, flags, ...rest);
      },
    });
    assert.strictEqual(L.acquire(t.p, { fs: spy }), null, 'EEXIST with no file on disk -> retried, then refused (never a crash)');
    const t0 = Date.now();
    assert.strictEqual(L.acquire(t.p, { fs: spy, maxTries: Infinity, waitMs: 50 }), null, 'an unbounded try count is bounded by the wait budget');
    assert.ok(Date.now() - t0 < 2000);
    mode = 'eperm';
    assert.strictEqual(L.acquire(t.p, { fs: spy }), null, 'EPERM -> fail-open null');
    assert.throws(() => L.acquire(t.p, { fs: spy, throwOnError: true }), (e) => e.code === 'EPERM');
    const excl = L.acquire(t.p, { publish: 'excl' });
    assert.ok(excl, 'publish:excl uses a plain O_EXCL create');
    excl.release();
  } finally { t.cleanup(); }
});

test('release by a non-owner is refused: a stale handle never removes a successor\'s lock', () => {
  const t = tmp();
  try {
    const now = 1_000_000;
    const a = L.acquire(t.p, { now: () => now });
    // A successor reclaims A's lock (A looks stale and live-stealable to it).
    const b = L.acquire(t.p, { now: () => now + 10 * 60 * 1000, staleMs: 1000, liveStaleMs: 1000 });
    assert.ok(b, 'successor reclaimed');
    assert.strictEqual(L.release(a), false, 'A no longer owns it — release refused');
    assert.strictEqual(a.refresh(), false, 'refresh by a non-owner is a definitive loss');
    assert.strictEqual(JSON.parse(fs.readFileSync(t.p, 'utf8')).token, b.token, 'B\'s lock untouched');
    assert.strictEqual(L.release({ path: t.p, token: 'forged' }), false, 'a forged handle cannot release');
    assert.strictEqual(b.release(), true);
  } finally { t.cleanup(); }
});

test('refresh: restamps ts and extra fields atomically, keeps the token', () => {
  const t = tmp();
  try {
    let clock = 1000;
    const h = L.acquire(t.p, { now: () => clock, fields: { version: '1.0', sessionId: undefined } });
    const first = JSON.parse(fs.readFileSync(t.p, 'utf8'));
    assert.strictEqual(first.version, '1.0');
    assert.ok(!('sessionId' in first), 'undefined fields are omitted');
    clock = 5000;
    assert.strictEqual(h.refresh({ pid: 12345 }), true);
    const rec = JSON.parse(fs.readFileSync(t.p, 'utf8'));
    assert.strictEqual(rec.ts, 5000);
    assert.strictEqual(rec.pid, 12345);
    assert.strictEqual(rec.token, h.token);
    assert.deepStrictEqual(scratch(path.dirname(t.p)), []);
    fs.unlinkSync(t.p);
    assert.strictEqual(h.refresh(), false, 'gone -> definitive loss');
    fs.writeFileSync(t.p, '{torn');
    assert.strictEqual(h.refresh(), 'error', 'torn read -> transient, not loss');
  } finally { t.cleanup(); }
});

test('foreign host: a holder on another host is never "dead" by pid — only staleness reclaims it', () => {
  const t = tmp();
  try {
    fs.mkdirSync(path.dirname(t.p), { recursive: true });
    const now = 1_000_000;
    fs.writeFileSync(t.p, JSON.stringify({ pid: 4242, host: 'other-host.invalid', ts: now - 1000, token: 'x' }));
    assert.strictEqual(L.acquire(t.p, { now: () => now, isAlive: () => false, stealDead: true, staleMs: 60000 }), null);
    const h = L.acquire(t.p, { now: () => now + 120000, isAlive: () => false, stealDead: true, staleMs: 60000 });
    assert.ok(h);
    h.release();
  } finally { t.cleanup(); }
});

test('crash safety: a SIGKILLed holder leaves its lock; the next acquirer reclaims it (dead pid) with no scratch left', () => {
  const t = tmp();
  try {
    const holder = `
      const L = require(${JSON.stringify(LOCK_JS)});
      const h = L.acquire(${JSON.stringify(t.p)});
      process.stdout.write(h ? 'held\\n' : 'no\\n');
      setInterval(() => {}, 1000);`;
    const k = cp.spawn(process.execPath, ['-e', holder], { env: childEnv(t.dir), stdio: ['ignore', 'pipe', 'ignore'] });
    return new Promise((res, rej) => {
      k.stdout.once('data', (d) => {
        try {
          assert.strictEqual(String(d).trim(), 'held');
          assert.strictEqual(L.acquire(t.p, { stealDead: true }), null, 'a LIVE holder process is respected');
          k.kill('SIGKILL');
        } catch (e) { k.kill('SIGKILL'); rej(e); }
      });
      k.on('exit', () => {
        try {
          assert.ok(fs.existsSync(t.p), 'the crashed holder left its lock behind');
          const h = L.acquire(t.p, { stealDead: true });
          assert.ok(h, 'dead holder reclaimed');
          h.release();
          assert.deepStrictEqual(scratch(path.dirname(t.p)), []);
          res();
        } catch (e) { rej(e); }
      });
    }).finally(t.cleanup);
  } catch (e) { t.cleanup(); throw e; }
});

test('withLock: busy returns onBusy()/lockBusy and never runs fn; a Promise-returning fn is refused; withLockAsync awaits', async () => {
  const t = tmp();
  try {
    const h = L.acquire(t.p);
    let ran = false;
    assert.deepStrictEqual({ ...L.withLock(t.p, {}, () => { ran = true; }) }, { ok: false, lockBusy: true });
    assert.strictEqual(L.withLock(t.p, { onBusy: (holder) => 'busy:' + holder.pid }, () => { ran = true; }), 'busy:' + process.pid);
    assert.strictEqual(ran, false);
    h.release();
    assert.strictEqual(L.withLock(t.p, {}, () => 7), 7);
    assert.throws(() => L.withLock(t.p, {}, () => Promise.resolve(1)), /withLockAsync/);
    assert.strictEqual(fs.existsSync(t.p), false, 'released even when fn throws');
    const v = await L.withLockAsync(t.p, {}, async () => { assert.ok(fs.existsSync(t.p)); return 9; });
    assert.strictEqual(v, 9);
    assert.strictEqual(fs.existsSync(t.p), false);
  } finally { t.cleanup(); }
});

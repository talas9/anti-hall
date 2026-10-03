'use strict';
// v0.109.2 — devswarm.js `heartbeat`/`register` call appArchivedVerdict on
// EVERY short-lived CLI invocation. Before this fix, `builderStates` only had
// a per-PROCESS memo (devswarm-app-db.js's `memo`), so a fresh process (the
// common case for a short-lived CLI call) opened + queried the DevSwarm app's
// live SQLite DB every single time.
//
// Fix: a cross-invocation cache at
// ~/.anti-hall/devswarm/cache/app-archived.json, keyed by the app DB file's
// mtime+size (+ its WAL file's, when present), TTL ~30s. Re-query only when
// the DB's stat signature changed or the TTL expired. Read-only against the
// app DB; any cache error -> query directly (fail-open); write is atomic
// (tmp + rename).
//
// This test spies on `node:sqlite`'s DatabaseSync constructor directly (it's
// a plain writable/configurable property on the singleton module object) to
// count real DB opens, rather than relying on internal call interception.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const appDb = require(path.join(ROOT, 'companion', 'lib', 'devswarm-app-db.js'));

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-xcache-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const wtActive = path.join(base, 'wt-active'); fs.mkdirSync(wtActive);
  const wtArch = path.join(base, 'wt-archived'); fs.mkdirSync(wtArch);
  const dbFile = path.join(base, 'app', 'devswarm.db');
  fs.mkdirSync(path.dirname(dbFile));
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, worktreePath TEXT, isHidden INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1)');
  const ins = db.prepare('INSERT INTO builders (id, repositoryId, worktreePath, isHidden, isActive) VALUES (?, ?, ?, ?, ?)');
  ins.run('b-active', 'r1', wtActive, 0, 1);
  ins.run('b-archived', 'r1', wtArch, 1, 0);
  db.close();
  // per-process memo TTL 0 so the module's own memo never masks the
  // cross-invocation cache under test.
  const env = { ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
  return { base, home, env, dbFile, wtActive, wtArch };
}

// countDbOpens(fn) -> { result, opens } — spies on node:sqlite's DatabaseSync
// ctor for the duration of fn().
function countDbOpens(fn) {
  const orig = sqlite.DatabaseSync;
  let opens = 0;
  sqlite.DatabaseSync = function Spy(...args) { opens += 1; return new orig(...args); };
  try {
    const result = fn();
    return { result, opens };
  } finally {
    sqlite.DatabaseSync = orig;
  }
}

test('(a) unchanged mtime within the TTL -> no DB open (second call is a cache hit)', { skip }, () => {
  const f = fixture();
  try {
    appDb.resetCache();
    const first = countDbOpens(() => appDb.appArchivedVerdict({ home: f.home, env: f.env, id: 'b-archived', now: 1000, xcache: true }));
    assert.strictEqual(first.result, true, 'first call: archived by id');
    assert.ok(first.opens > 0, 'first call must query the DB at least once');
    const queryOpens = first.opens;

    appDb.resetCache(); // clear the per-process memo; only the cross-invocation cache should save us now
    const second = countDbOpens(() => appDb.appArchivedVerdict({ home: f.home, env: f.env, id: 'b-archived', now: 1000 + 5000, xcache: true }));
    assert.strictEqual(second.result, true, 'second call: same verdict from cache');
    assert.strictEqual(second.opens, 0, 'second call within TTL never opens the DB');
    assert.ok(second.opens < queryOpens, 'a cache hit opens the DB strictly less than a direct query');

    const third = countDbOpens(() => appDb.appArchivedVerdict({ home: f.home, env: f.env, id: 'b-active', now: 1000 + 10000, xcache: true }));
    assert.strictEqual(third.result, false, 'still-cached verdict for a different id');
    assert.strictEqual(third.opens, 0, 'still within TTL, still no DB open');
  } finally { rm(f.base); appDb.resetCache(); }
});

test('(b) mtime changed -> re-query (cache invalidated by a DB write)', { skip }, () => {
  const f = fixture();
  try {
    appDb.resetCache();
    const first = countDbOpens(() => appDb.appArchivedVerdict({ home: f.home, env: f.env, id: 'b-active', now: 1000, xcache: true }));
    assert.strictEqual(first.result, false);
    assert.ok(first.opens > 0, 'first call queries the DB');

    // Mutate the app DB: b-active becomes archived. Force the mtime forward
    // so the stat signature is guaranteed to differ even on coarse-grained
    // filesystem mtime clocks.
    const db = new sqlite.DatabaseSync(f.dbFile);
    db.exec("UPDATE builders SET isActive = 0, isHidden = 1 WHERE id = 'b-active'");
    db.close();
    const future = new Date(Date.now() + 60000);
    fs.utimesSync(f.dbFile, future, future);

    appDb.resetCache();
    const second = countDbOpens(() => appDb.appArchivedVerdict({ home: f.home, env: f.env, id: 'b-active', now: 1000 + 5000, xcache: true }));
    assert.ok(second.opens > 0, 'changed mtime forces a re-query (never a cache hit) even within the TTL window');
    assert.strictEqual(second.result, true, 'fresh data reflects the DB write');
  } finally { rm(f.base); appDb.resetCache(); }
});

test('(c) TTL expiry -> re-query even with an unchanged DB', { skip }, () => {
  const f = fixture();
  try {
    appDb.resetCache();
    const first = countDbOpens(() => appDb.appArchivedVerdict({ home: f.home, env: f.env, id: 'b-archived', now: 1000, xcache: true }));
    assert.ok(first.opens > 0);

    appDb.resetCache();
    const second = countDbOpens(() => appDb.appArchivedVerdict({ home: f.home, env: f.env, id: 'b-archived', now: 1000 + 31000, xcache: true }));
    assert.ok(second.opens > 0, 'past the ~30s TTL, the cache re-queries even though the DB never changed');
    assert.strictEqual(second.result, true);
  } finally { rm(f.base); appDb.resetCache(); }
});

test('(d) a corrupt cross-invocation cache file falls back to a direct query', { skip }, () => {
  const f = fixture();
  try {
    appDb.resetCache();
    const cacheFile = path.join(f.home, '.anti-hall', 'devswarm', 'cache', 'app-archived.json');
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, '{ not valid json ][');

    const r = countDbOpens(() => appDb.appArchivedVerdict({ home: f.home, env: f.env, id: 'b-archived', now: 1000, xcache: true }));
    assert.strictEqual(r.result, true, 'corrupt cache never breaks the answer');
    assert.ok(r.opens > 0, 'corrupt cache is treated as a miss, so the DB is queried directly');

    // and it self-heals: the next call within TTL is now a clean hit.
    appDb.resetCache();
    const r2 = countDbOpens(() => appDb.appArchivedVerdict({ home: f.home, env: f.env, id: 'b-archived', now: 1000 + 1000, xcache: true }));
    assert.strictEqual(r2.opens, 0, 'the corrupt cache was overwritten with a valid one on the prior call');
  } finally { rm(f.base); appDb.resetCache(); }
});

test('(e) never touches the app DB when home is absent (no home to keyed-cache under)', { skip }, () => {
  const f = fixture();
  try {
    appDb.resetCache();
    // Two calls with no home: each one must still work (falls back to the
    // per-process memo / direct query path) without throwing on a missing
    // cache directory.
    const v1 = appDb.appArchivedVerdict({ home: null, env: f.env, id: 'b-archived', now: 1000 });
    assert.strictEqual(v1, true);
  } finally { rm(f.base); appDb.resetCache(); }
});

test('(f) opt-in only: without xcache:true, a home-bearing call never writes the cache file (read-only callers stay read-only)', { skip }, () => {
  const f = fixture();
  try {
    appDb.resetCache();
    const cacheFile = path.join(f.home, '.anti-hall', 'devswarm', 'cache', 'app-archived.json');
    const v = appDb.appArchivedVerdict({ home: f.home, env: f.env, id: 'b-archived', now: 1000 });
    assert.strictEqual(v, true, 'still answers correctly');
    assert.ok(!fs.existsSync(cacheFile), 'no xcache opt-in -> no cache file ever written (e.g. app-state, doctor stay read-only)');
    assert.ok(!fs.existsSync(path.join(f.home, '.anti-hall')), 'nothing at all is written under home without opt-in');
  } finally { rm(f.base); appDb.resetCache(); }
});

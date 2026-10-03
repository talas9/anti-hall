'use strict';
// Mesh redesign Phase 3 — REGRESSION tests for the three Codex P0 loss paths that
// got the per-instance "retired cursors" patch (#5) rejected. Each is written at
// the CLI/production-entry level, design-agnostic, so it can be pointed at a tree
// carrying that rejected patch (ANTIHALL_TEST_PLUGIN_ROOT) and FAIL there, and at
// this tree (reader_cursors) and PASS. Every assertion is "no skip": a message a
// live reader never saw is never counted consumed.
//
//   P0 #1 — an undeclared (headless) reader inherited max(floor, shared pair): an
//           older build's own-position ack in the shared pair skipped its mail.
//   P0 #2 — a LIVE reader was retired because its harness session FILE was
//           missing: the floor then passed it, so every floor view (summary,
//           parent gate, newcomers) treated its unread mail as consumed.
//   P0 #3 — two harness sessions sharing an ancestor collapsed onto ONE nonce
//           (the cwd-matching ancestor won over the nearest harness), so one
//           session's ack consumed the other's mail.
//
// HERMETIC: every fixture HOME is a tmp dir; HOME/USERPROFILE are isolated for
// the file; ANTIHALL_INGEST_DRY_RUN is irrelevant here (no ingest runs).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const inboxCursor = require(path.join(ROOT, 'companion', 'lib', 'devswarm-inbox-cursor.js'));
const readerIdentity = require(path.join(ROOT, 'companion', 'lib', 'reader-identity.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));

const BACKEND = 'journal'; // both designs support it; the acceptance harness runs on it too

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-rc-p0-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-rc-p0-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
const ctxOf = (home, repo, nonce) => ({ home, cwd: repo, env: {}, backend: BACKEND, now: Date.now(), instanceNonce: nonce });
function register(home, repo, id, nonce) {
  const r = cli.cmdRegister(id, { worktree: [repo], session: ['s-' + id] }, ctxOf(home, repo, nonce));
  assert.ok(r && r.ok, 'register: ' + JSON.stringify(r));
}
function readPrimary(home, repo, id, nonce) {
  return cli.cmdInboxMessages(id, { unread: [true] }, ctxOf(home, repo, nonce), { ack: true });
}
function openS(home, repo) { return storeLib.openStore({ home, hash: repokey.repoKeyForWorktree(repo), backend: BACKEND }); }
function seed(home, repo, id, n, tag) {
  const s = openS(home, repo);
  try {
    for (let i = 0; i < n; i++) {
      const f = { from: 'peer', to: id, type: 'direct', message: tag + '-' + i, timestamp: 1700000000000 + i, urgency: 'normal' };
      storeLib.appendMeshMessage(s, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
    }
  } finally { s.close(); }
}
function summaryUnread(home, repo, id) {
  const s = openS(home, repo);
  try {
    const sum = storeLib.computeSummary(s, { home, env: {}, now: Date.now() });
    return sum && sum.workspaces && sum.workspaces[id] ? sum.workspaces[id].unread : null;
  } finally { s.close(); }
}
// retirePass(home) — the design's own "retire ended readers" sweep.
function retirePass(home) {
  if (typeof cli.importReaderCursorsAllStores === 'function') return cli.importReaderCursorsAllStores(home, { env: {}, backend: BACKEND });
  if (typeof cli.retireDeadInstanceCursors === 'function') return cli.retireDeadInstanceCursors(home, { graceMs: 0 });
  return null;
}

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
test.before(() => { const iso = tmpHome(); process.env.HOME = iso; process.env.USERPROFILE = iso; });
test.after(() => {
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME; else delete process.env.HOME;
  if (REAL_USERPROFILE !== undefined) process.env.USERPROFILE = REAL_USERPROFILE; else delete process.env.USERPROFILE;
});

test('P0 #1: a HEADLESS reader reads the stored floor ONLY — an older build pushing the shared pair ahead never skips its mail', () => {
  const home = tmpHome(); const repo = makeGitRepo('p0-1');
  try {
    const id = 'primary-p01';
    const HEADLESS = 'self:777:1'; // no harness ancestor (legacy fallback shape): headless in both designs
    register(home, repo, id, HEADLESS);
    readPrimary(home, repo, id, HEADLESS); // first touch: the floor is established at 0
    seed(home, repo, id, 3, 'p01');
    // A 0.98.3-style session acks ITS OWN position into the shared pair
    // (store cursor row + cursors/<id>.json) — no min projection.
    const s = openS(home, repo);
    try { s.setCursor(id, 3); } finally { s.close(); }
    inboxCursor.ackTo(path.join(home, '.anti-hall', 'devswarm', 'cursors', id + '.json'), 3);
    const r = readPrimary(home, repo, id, HEADLESS);
    assert.strictEqual(r.ok, true, JSON.stringify(r.error || r.reason || ''));
    assert.strictEqual((r.messages || []).length, 3,
      'the headless reader never saw these 3 rows; reading max(floor, shared) skipped all of them (rejected-patch P0 #1)');
  } finally { rm(home); rm(repo); }
});

test('P0 #2: a LIVE reader with NO session file is never retired — the floor never passes it', () => {
  const home = tmpHome(); const repo = makeGitRepo('p0-2');
  try {
    const id = 'primary-p02';
    // Both readers are REAL live processes (this test process and its parent);
    // startMs is "now", which is >= each process's real start (never pid reuse).
    // Deliberately NO <home>/.claude/sessions/<pid>.json for either (the dir
    // exists and holds an unrelated, dead session, so a file-based live set is
    // computable — and wrong).
    const sessDir = path.join(home, '.claude', 'sessions');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, '999991.json'), JSON.stringify({ pid: 999991, cwd: repo, startedAt: 1, sessionId: 'dead' }));
    const R = 'h:' + process.pid + ':' + Date.now();
    const A = 'h:' + process.ppid + ':' + Date.now();
    register(home, repo, id, R);
    register(home, repo, id, A);
    seed(home, repo, id, 3, 'p02');
    retirePass(home); // the design's retire sweep runs with the session files absent
    const a = readPrimary(home, repo, id, A);
    assert.strictEqual((a.messages || []).length, 3, 'A reads and acks everything');
    assert.strictEqual(summaryUnread(home, repo, id), 3,
      'R (live) has read nothing: the floor view must still show its 3 unread — a missing session file retired R and let the floor pass it (rejected-patch P0 #2)');
    const r = readPrimary(home, repo, id, R);
    assert.strictEqual((r.messages || []).length, 3, 'and R itself still receives all 3');
  } finally { rm(home); rm(repo); }
});

// Process tree for P0 #3: harness A (cwd = the repo) -> nested harness B (cwd =
// elsewhere) -> this CLI process (cwd = the repo, e.g. B's Bash tool cd'd there).
function nestedHarnessFixture(home, repo, other) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const PA = 91001, PB = 91002, SELF = 91003;
  fs.writeFileSync(path.join(dir, PA + '.json'), JSON.stringify({ pid: PA, cwd: repo, startedAt: 1700000000001, sessionId: 'sess-A' }));
  fs.writeFileSync(path.join(dir, PB + '.json'), JSON.stringify({ pid: PB, cwd: other, startedAt: 1700000000002, sessionId: 'sess-B' }));
  const parent = { [SELF]: PB, [PB]: PA, [PA]: 1 };
  return {
    PA, PB, SELF,
    opts: (pid) => ({ home, cwd: repo, pid, ppidOf: (p) => parent[p] || null, kill: () => true, ps: () => null }),
  };
}
function nonceFor(o) {
  // This tree: reader-identity's nearest-harness rule. Rejected tree: its own
  // deriveInstanceNonce (cwd-matching ancestor first, nearest live as fallback).
  if (typeof cli.callerReaderKey === 'function') return readerIdentity.deriveReaderNonce(o);
  return cli.deriveInstanceNonce({ home: o.home, cwd: o.cwd }, { pid: o.pid, ppidOf: o.ppidOf, kill: o.kill, fs, ps: o.ps });
}

test('P0 #3: two harness sessions sharing an ancestor never share a reader identity (nearest harness wins, unconditionally)', () => {
  const home = tmpHome(); const repo = makeGitRepo('p0-3'); const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-rc-p0-other-'));
  try {
    const fx = nestedHarnessFixture(home, repo, other);
    const underB = nonceFor(fx.opts(fx.SELF)); // a CLI call made by harness B
    const underA = nonceFor(fx.opts(fx.PA));   // harness A itself
    assert.ok(underB && underA, 'both resolve to a harness identity: ' + underB + ' / ' + underA);
    assert.notStrictEqual(underB, underA,
      'B\'s CLI call resolved to A\'s identity — the cwd-matching ancestor won over the nearest harness (rejected-patch P0 #3)');
    assert.ok(String(underB).includes(String(fx.PB)), 'B\'s call is keyed by B\'s own pid: ' + underB);

    // End to end: the two identities are two readers; A's ack never consumes B's mail.
    const id = 'primary-p03';
    const toKey = (n) => (typeof cli.callerReaderKey === 'function' ? n : n); // same string both designs
    register(home, repo, id, toKey(underA));
    register(home, repo, id, toKey(underB));
    seed(home, repo, id, 3, 'p03');
    const a = readPrimary(home, repo, id, toKey(underA));
    assert.strictEqual((a.messages || []).length, 3);
    const b = readPrimary(home, repo, id, toKey(underB));
    assert.strictEqual((b.messages || []).length, 3, 'B must still receive all 3 after A acked');
  } finally { rm(home); rm(repo); rm(other); }
});

test('P0 #3 (key width): reader rows are keyed by the FULL nonce — two nonces whose legacy short6 collide stay two readers', () => {
  if (typeof cli.callerReaderKey !== 'function') return; // Phase-3-only property (the rejected tree keys by short6)
  const crypto = require('node:crypto');
  const short = (n) => crypto.createHash('sha1').update(n).digest('hex').slice(0, 6);
  // Find two h: nonces whose sha1 short6 collide (24-bit space: a few thousand tries).
  const seen = new Map();
  let pair = null;
  for (let i = 1; i < 200000 && !pair; i++) {
    const n = 'h:' + (100000 + i) + ':1700000000000';
    const k = short('anc:' + n.slice(2));
    if (seen.has(k)) pair = [seen.get(k), n]; else seen.set(k, n);
  }
  assert.ok(pair, 'a short6 collision exists within the search bound');
  const home = tmpHome(); const repo = makeGitRepo('p0-3w');
  try {
    const id = 'primary-p03w';
    register(home, repo, id, pair[0]);
    register(home, repo, id, pair[1]);
    seed(home, repo, id, 2, 'p03w');
    assert.strictEqual((readPrimary(home, repo, id, pair[0]).messages || []).length, 2);
    assert.strictEqual((readPrimary(home, repo, id, pair[1]).messages || []).length, 2, 'a short6 collision never merges two readers');
  } finally { rm(home); rm(repo); }
});

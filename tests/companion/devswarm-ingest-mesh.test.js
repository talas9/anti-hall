'use strict';
// v0.57 mesh — PER-PROJECT SINGLE-Primary-queue daemon (D1/D8/D9/D21/D24,
// PLAN-v0.57-mesh.md Phase 5). Companion to tests/companion/devswarm-ingest.test.js
// (which covers the pre-existing per-worktree lock/heartbeat/loop mechanics,
// updated in this phase to reflect the repoKey rekey where it touches shared
// paths). This file covers ONLY the v0.57 additions:
//   - repoKey-keyed lock/heartbeat naming (falls back to the legacy per-worktree
//     shape when repoKey is unresolvable — a fake/non-existent worktree)
//   - the reap-before-drain lock-probe/back-off logic (probeLegacyHolders +
//     its integration into runIngestLoop) — legacy-worktree enumeration via a
//     MOCKED `git worktree list --porcelain`, never a real git spawn
//   - single-consumer preservation: exactly one lock per repoKey; the daemon
//     never opens the store or calls `monitor` while a legacy holder is alive
//   - D24 store-caller re-key: `register`/`heartbeat` (the real CLI) write into
//     the SAME store/<repoKey>/ the daemon drains into and `roster` reads

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ingest = require('../../plugins/anti-hall/companion/devswarm-ingest.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const cli = require('../../plugins/anti-hall/scripts/devswarm.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-ingest-mesh-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// makeGitRepo(tag) -> a real, committed git repo dir. Mirrors the pattern
// tests/scripts/devswarm-send.test.js and tests/companion/install-ingest-repokey.test.js
// already use — git-common-dir resolution needs a real .git.
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-mesh-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function addLinkedWorktree(mainDir, tag) {
  const wt = path.join(path.dirname(mainDir), path.basename(mainDir) + '-wt-' + tag);
  cp.spawnSync('git', ['-C', mainDir, 'worktree', 'add', wt, '-b', 'branch-' + tag]);
  return wt;
}
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

// ---------------------------------------------------------------------------
// repoKey-keyed lock/heartbeat naming.
// ---------------------------------------------------------------------------

test('ingestLockPath prefers the repoKey shape for a REAL git worktree, falls back to the legacy per-worktree shape for a fake one', () => {
  const home = tmpHome();
  const repo = makeGitRepo('lockpath');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const p = ingest.ingestLockPath(home, repo);
    assert.equal(p, path.join(home, '.anti-hall', 'devswarm', 'locks', 'ingest-project-' + repoKey + '.lock'));

    // A fake/non-existent worktree path -> repoKey unresolvable -> legacy shape.
    const fake = '/definitely/not/a/real/repo/anywhere';
    const pFake = ingest.ingestLockPath(home, fake);
    assert.match(pFake, /ingest-[0-9a-f]{8}\.lock$/, 'falls back to the legacy per-worktree hash shape');
  } finally { rm(home); rm(repo); }
});

test('ingestLockPath: TWO linked worktrees of ONE project share the SAME repoKey-keyed lock (one daemon per PROJECT, not per worktree)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('sharedlock');
  const linked = addLinkedWorktree(repo, 'sharedlock');
  try {
    const pMain = ingest.ingestLockPath(home, repo);
    const pLinked = ingest.ingestLockPath(home, linked);
    assert.equal(pMain, pLinked, 'both worktrees of the SAME project resolve to the identical project lock');
  } finally { rm(home); rm(repo); rm(linked); }
});

test('runIngestLoop opens the SHARED repoKey store for a REAL worktree — messages + registry both land there', () => {
  const home = tmpHome();
  const repo = makeGitRepo('sharedstore');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const primaryId = installIngest.primaryWorkspaceId(repo);
    const batch = JSON.stringify([
      { fromBranch: 'c', toBranch: primaryId, message: 'hi', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', worktree: repo, maxIterations: 1,
      run: () => ({ ok: true, raw: batch }), sleep: () => {},
    });
    assert.equal(summary.started, true);
    assert.equal(summary.stats.inserted, 1);
    // The row + the daemon's own self-registration both live in store/<repoKey>/.
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      assert.equal(s.messageCount(primaryId), 1);
      assert.ok(s.listRegistry().some((r) => r.id === primaryId), 'self-registered under repoKey store');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// Reap-before-drain PROBE (D9) — legacy-worktree enumeration via a MOCKED
// `git worktree list --porcelain` (installIngest.listRepoWorktrees), NEVER a
// real git spawn in these tests.
// ---------------------------------------------------------------------------

function porcelainFor(paths) {
  return paths.map((p) => `worktree ${p}\nHEAD abc\nbranch refs/heads/x\n`).join('\n');
}

test('probeLegacyHolders: a LIVE legacy holder for one of this repo\'s worktrees -> blocked:true', () => {
  const home = tmpHome();
  try {
    const wtA = '/repo/a';
    const wtB = '/repo/a-wt-b';
    const io = { run: () => ({ ok: true, raw: porcelainFor([wtA, wtB]) }) };
    // Seed a LIVE legacy lock for wtB.
    const legacyLockB = ingest.legacyIngestLockPath(home, wtB);
    fs.mkdirSync(path.dirname(legacyLockB), { recursive: true });
    fs.writeFileSync(legacyLockB, JSON.stringify({ pid: 4242, ts: Date.now() }));
    const probe = ingest.probeLegacyHolders(home, wtA, Object.assign({ isAlive: () => true }, io));
    assert.equal(probe.blocked, true);
    assert.equal(probe.liveHolders.length, 1);
    assert.equal(probe.liveHolders[0].worktree, wtB);
  } finally { rm(home); }
});

test('probeLegacyHolders: a DEAD legacy holder (or none at all) -> blocked:false', () => {
  const home = tmpHome();
  try {
    const wtA = '/repo/a';
    const wtB = '/repo/a-wt-b';
    const io = { run: () => ({ ok: true, raw: porcelainFor([wtA, wtB]) }) };
    // No lock files at all -> nothing to probe.
    const probeNone = ingest.probeLegacyHolders(home, wtA, Object.assign({ isAlive: () => true }, io));
    assert.equal(probeNone.blocked, false);

    // A lock file whose holder is DEAD.
    const legacyLockB = ingest.legacyIngestLockPath(home, wtB);
    fs.mkdirSync(path.dirname(legacyLockB), { recursive: true });
    fs.writeFileSync(legacyLockB, JSON.stringify({ pid: 4242, ts: Date.now() }));
    const probeDead = ingest.probeLegacyHolders(home, wtA, Object.assign({ isAlive: () => false }, io));
    assert.equal(probeDead.blocked, false, 'a dead holder never blocks the new daemon');
  } finally { rm(home); }
});

test('probeLegacyHolders TORN-READ GUARD: a FRESH unparseable lock file (mid-write) blocks, never silently reads as absent', () => {
  const home = tmpHome();
  try {
    const wtA = '/repo/a';
    const io = { run: () => ({ ok: true, raw: porcelainFor([wtA]) }) };
    // Torn/garbage lock content -> unparseable JSON -> readLockHolder falls back
    // to the file's own (fresh) mtime, mirroring acquireIngestLock's own
    // torn-read guard — a live holder mid-write must never be missed.
    const legacyLockA = ingest.legacyIngestLockPath(home, wtA);
    fs.mkdirSync(path.dirname(legacyLockA), { recursive: true });
    fs.writeFileSync(legacyLockA, 'not json at all');
    const probe = ingest.probeLegacyHolders(home, wtA, Object.assign({ isAlive: () => true }, io));
    assert.equal(probe.blocked, true, 'a fresh unparseable lock is presumed a live holder mid-write');
    assert.equal(probe.liveHolders.length, 1);
    assert.equal(probe.liveHolders[0].pid, null, 'pid is unknown for a torn read');
  } finally { rm(home); }
});

test('probeLegacyHolders is fail-open: a STALE unparseable lock file reads as "no holder" (never blocks forever)', () => {
  const home = tmpHome();
  try {
    const wtA = '/repo/a';
    const io = { run: () => ({ ok: true, raw: porcelainFor([wtA]) }) };
    // Torn/garbage lock content whose mtime is OLD (well past the stale window)
    // -> presumed an abandoned lock from a process that died mid-write, not a
    // live holder — this is the genuine fail-open case (never blocks forever).
    const legacyLockA = ingest.legacyIngestLockPath(home, wtA);
    fs.mkdirSync(path.dirname(legacyLockA), { recursive: true });
    fs.writeFileSync(legacyLockA, 'not json at all');
    const staleMs = Date.now() - (20 * 60 * 1000); // 20min ago > INGEST_LOCK_STALE_MS (15min)
    fs.utimesSync(legacyLockA, staleMs / 1000, staleMs / 1000);
    const probe = ingest.probeLegacyHolders(home, wtA, Object.assign({ isAlive: () => true }, io));
    assert.equal(probe.blocked, false);
  } finally { rm(home); }
});

test('probeLegacyHolders fail-opens to blocked:false when the worktree-listing spawn itself fails', () => {
  const home = tmpHome();
  const probe = ingest.probeLegacyHolders(home, '/repo/a', { run: () => ({ ok: false, raw: '' }) });
  assert.equal(probe.blocked, false);
});

// ---------------------------------------------------------------------------
// The probe is WIRED INTO runIngestLoop: a live legacy holder backs the new
// daemon off BEFORE it ever opens the store or calls `monitor` — single-
// consumer preservation (D9/D21).
// ---------------------------------------------------------------------------

test('runIngestLoop backs off (never drains) while a legacy per-worktree holder for this repo is LIVE — reap-before-drain', () => {
  const home = tmpHome();
  const repo = makeGitRepo('backoff');
  const linked = addLinkedWorktree(repo, 'backoff');
  try {
    // Seed a LIVE legacy lock for the LINKED worktree (simulating an
    // un-reaped pre-0.57 daemon still holding it) — KEYED BY THE SAME PATH
    // FORM probeLegacyHolders itself will see: `git worktree list --porcelain`
    // (real spawn — no io.run injected below), not the raw `linked` string
    // this test built via path.join/mkdtempSync. On win32, git/MSYS resolves
    // %TEMP%'s short-name form (what mkdtempSync hands back on GH Actions
    // windows-latest) to its long-name form when reporting worktree paths —
    // the same divergence devswarm-repokey.js's winCanonicalizeCommonDir
    // exists to close for repoKey, but legacyIngestLockPath's worktreeHash has
    // no such handling. Seeding at the enumerated (git-reported) path, rather
    // than reimplementing that canonicalization here, keeps the expectation
    // self-consistent on every platform (git always lists the main worktree
    // first, so index 1 is the one linked worktree this repo has).
    const enumerated = installIngest.listRepoWorktrees(repo, {});
    assert.equal(enumerated.length, 2, 'main + the one linked worktree');
    const linkedReported = enumerated[1];
    const legacyLock = ingest.legacyIngestLockPath(home, linkedReported);
    fs.mkdirSync(path.dirname(legacyLock), { recursive: true });
    fs.writeFileSync(legacyLock, JSON.stringify({ pid: process.pid, ts: Date.now() }));

    let monitorCalls = 0;
    let storeOpened = false;
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', worktree: repo, maxIterations: 1,
      run: () => { monitorCalls++; return { ok: true, raw: '[]' }; },
      sleep: () => {},
      io: { openStore: (o) => { storeOpened = true; return storeLib.openStore(o); } },
    });
    assert.equal(summary.started, false, 'the daemon refuses to start while a legacy holder is live');
    assert.match(summary.reason, /legacy per-worktree ingest holder/);
    assert.equal(summary.liveHolders.length, 1);
    assert.equal(summary.liveHolders[0].worktree, linkedReported);
    assert.equal(monitorCalls, 0, 'NEVER calls monitor while blocked — the whole point of reap-before-drain');
    assert.equal(storeOpened, false, 'NEVER opens the store while blocked — no premature self-registration either');

    // Its own lock is released again (never left held) so a subsequent
    // (post-reap) run can acquire it.
    const relAfter = ingest.acquireIngestLock(home, undefined, repo);
    assert.ok(relAfter, 'the refused daemon released its own lock — a later run can still acquire it');
    relAfter();
  } finally { rm(home); rm(repo); rm(linked); }
});

test('runIngestLoop proceeds normally once the legacy holder is DEAD (reap completed)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('proceed');
  const linked = addLinkedWorktree(repo, 'proceed');
  try {
    const legacyLock = ingest.legacyIngestLockPath(home, linked);
    fs.mkdirSync(path.dirname(legacyLock), { recursive: true });
    fs.writeFileSync(legacyLock, JSON.stringify({ pid: 999999999, ts: Date.now() })); // implausible/dead pid

    const summary = ingest.runIngestLoop({
      home, backend: 'journal', worktree: repo, maxIterations: 1,
      run: () => ({ ok: true, raw: '[]' }), sleep: () => {},
      io: { isAlive: () => false }, // deterministic: this holder reads as dead
    });
    assert.equal(summary.started, true, 'a dead legacy holder never blocks the new daemon');
  } finally { rm(home); rm(repo); rm(linked); }
});

test('runIngestLoop NEVER spawns monitor with a CHILD-worktree cwd — only the baked Primary/main worktree (single-consumer per child queue, D21)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('primaryonly');
  try {
    const seen = [];
    ingest.runIngestLoop({
      home, backend: 'journal', worktree: repo, maxIterations: 2,
      run: (opts) => { seen.push(opts); return { ok: true, raw: '[]' }; },
      sleep: () => {},
    });
    // The injected `run` receives the monitor invocation options — it carries
    // NO cwd/worktree override at all (runIngestLoop's `run` contract is a
    // single bounded call from the daemon's OWN process cwd, never a spawned
    // per-worktree override) — proving there is no round-robin over children.
    assert.equal(seen.length, 2);
    for (const call of seen) assert.equal('worktree' in call, false, 'monitor call carries no per-worktree override');
  } finally { rm(home); rm(repo); }
});

test('a second daemon for the SAME repoKey is refused (single-consumer per project); a DIFFERENT project is not blocked', () => {
  const home = tmpHome();
  const repoA = makeGitRepo('single-a');
  const repoB = makeGitRepo('single-b');
  try {
    const relA1 = ingest.acquireIngestLock(home, undefined, repoA);
    assert.ok(relA1, 'first daemon for repoA acquires its lock');
    const relA2 = ingest.acquireIngestLock(home, undefined, repoA);
    assert.equal(relA2, null, 'a second daemon for the SAME repoA is refused');
    const relB = ingest.acquireIngestLock(home, undefined, repoB);
    assert.ok(relB, 'a daemon for a DIFFERENT project (repoB) is never blocked by repoA\'s lock');
    relA1(); relB();
  } finally { rm(home); rm(repoA); rm(repoB); }
});

// ---------------------------------------------------------------------------
// D24 store-caller re-key: `register`/`heartbeat` (the real CLI) populate the
// SAME shared repoKey store the daemon drains into and `roster` reads — else
// the fail-closed mesh roster stays empty and every direct send is rejected.
// ---------------------------------------------------------------------------

test('D24: a re-keyed `register` writes into store/<repoKey>/ and the roster is non-empty', () => {
  const home = tmpHome();
  const repo = makeGitRepo('d24-register');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const r = cli.run(['register', 'peer-1', '--worktree', '/wt/peer-1', '--session', 's'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true);

    // The registry entry landed in the SHARED repoKey store — not the legacy
    // hashFromWorkspaceId('peer-1') bucket.
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const row = s.listRegistry().find((x) => x.id === 'peer-1');
      assert.ok(row, 'register wrote into the SAME store/<repoKey>/ roster reads');
    } finally { s.close(); }

    const roster = cli.run(['roster'], ctx(home, { cwd: repo }));
    assert.equal(roster.result.ok, true);
    assert.equal(roster.result.repoKey, repoKey);
    assert.ok(roster.result.workspaces.some((w) => w.id === 'peer-1'), 'the roster (fail-closed mesh address book) sees the registered peer');
  } finally { rm(home); rm(repo); }
});

test('D24: `mesh send --to` a peer registered via the real `register` CLI succeeds (fail-closed roster is actually populated)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('d24-send');
  try {
    cli.run(['register', 'peer-2', '--worktree', '/wt/peer-2', '--session', 's'], ctx(home, { cwd: repo }));
    const meshId = installIngest.primaryWorkspaceId('/wt/peer-2');
    const r = cli.run(['send', '--to', meshId, '--message', 'hi'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, 'send succeeds against a roster populated by the REAL register CLI, not a test-only seed');
  } finally { rm(home); rm(repo); }
});

test('D24: `gate` and `archive` operate on the SAME shared repoKey store `register` populated', () => {
  const home = tmpHome();
  const repo = makeGitRepo('d24-gate-archive');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    cli.run(['register', 'peer-3', '--worktree', '/wt/peer-3', '--session', 's'], ctx(home, { cwd: repo }));
    const g = cli.run(['gate', 'peer-3', '--set', 'done,merged,tests_passed'], ctx(home, { cwd: repo }));
    assert.equal(g.result.ok, true);
    assert.equal(g.result.archive_ready, true, 'gate landed in the SAME store register populated (else archive_ready is never derivable)');

    const a = cli.run(['archive', 'peer-3'], ctx(home, { cwd: repo }));
    assert.equal(a.result.ok, true);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      assert.ok(!s.listRegistry().some((x) => x.id === 'peer-3'), 'archive tombstoned the SAME repoKey store register wrote into');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('D24: null repoKey (non-git cwd) falls back to the pre-mesh per-id store for register/gate/inbox — no regression outside a project', () => {
  const home = tmpHome();
  const nogit = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-mesh-nogit-'));
  try {
    const r = cli.run(['register', 'w', '--worktree', '/wt/w', '--session', 's'], ctx(home, { cwd: nogit }));
    assert.equal(r.result.ok, true);
    // Legacy per-id hash bucket — unchanged pre-mesh behavior.
    const s = storeLib.openStore({ home, workspaceId: 'w', backend: 'journal' });
    try { assert.ok(s.listRegistry().some((x) => x.id === 'w')); } finally { s.close(); }
  } finally { rm(home); rm(nogit); }
});

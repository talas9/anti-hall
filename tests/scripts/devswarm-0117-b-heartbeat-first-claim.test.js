'use strict';
// 0.117.1 item B — field defect: a CHILD's FIRST-EVER interaction with its
// own workspace id is commonly a direct `heartbeat <id> --summary ...`, with
// no prior `register` call. Root-caused against the REAL devswarm.js CLI:
// `broadcastFamilyOwns`'s ownership check required a PRE-EXISTING registry
// row for the target id before it would consider ANY of its legs (a1/a2/a3)
// — a never-registered id has no row at all, so the check fell straight
// through to the fail-closed default and the summary was silently DROPPED
// (`meshBroadcast.ok:false, reason:'caller-not-registered'`) even though the
// caller was the one and only process that could possibly be heartbeating
// under it. The dropped summary never reaches the shared store's `recent[]`,
// so hooks/devswarm-child-gate.js's alreadyReportedThisEpisode() (which reads
// ONLY recent[]) never sees the attempt and the Stop gate re-fires the same
// "emit a heartbeat" instruction forever.
//
// FIRST FIX (0.117.1): broadcastFamilyOwns gained leg (a0) — when `id` has NO
// registry row anywhere, a cwd-resolved caller (`callerKind === 'resolved'`)
// with no descriptor and no PRE-EXISTING heartbeat for `id` owned it. That
// cut was ITSELF a P0 defect (review finding B-a0-impersonation): it granted
// first-claim ownership of ANY never-registered id to ANY cwd-resolved
// caller — an unrelated caller could impersonate a sibling's FUTURE id
// (claim it before the real owner ever heartbeats it) and lock the real
// owner out once claimed.
//
// GROUND-TRUTH REWRITE (this file, 0.117.1 round 2): (a0) now ALSO requires
// that the DevSwarm APP's own database (ground truth, companion/lib/
// devswarm-app-db.js's `builderForWorktree`) names a builder for the
// CALLER's own resolved worktree whose id is EXACTLY the target `id`. A bare
// cwd-resolved caller with no app-DB proof is refused — the summary is
// DROPPED with a `note` explaining why, and the real owner (once it DOES
// present from the matching worktree) can still claim the id afterward — no
// lockout.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');

// Point the shared central logger at an isolated dir BEFORE requiring
// anything that may log — never write into the real ~/.anti-hall/logs (see
// tests/scripts/devswarm-v064.test.js's established pattern).
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-0117b-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

const DEVSWARM_PATH = path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js');
const cli = require(DEVSWARM_PATH);
const mutantKit = require('./lib/devswarm-mutant-kit.js');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skipSqlite = sqlite ? false : 'node:sqlite unavailable';

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-0117b-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-0117b-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

// appDbFixture(home, builders) -> { dbFile, env }. A throwaway DevSwarm app
// DB (node:sqlite, mirrors tests/hooks/task-guard.test.js's own fixture
// pattern) carrying exactly the `builders` rows given. env points
// ANTIHALL_DEVSWARM_APP_DB at it with caching disabled.
let appDbFixtureCounter = 0;
function appDbFixture(home, builders) {
  const dbFile = path.join(home, 'app-devswarm-' + (appDbFixtureCounter++) + '.db');
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, worktreePath TEXT, isHidden INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1)');
  const ins = db.prepare('INSERT INTO builders (id, repositoryId, worktreePath, isHidden, isActive) VALUES (?, ?, ?, ?, ?)');
  for (const b of builders) ins.run(b.id, b.repositoryId || 'r1', b.worktreePath, b.isHidden ? 1 : 0, b.isActive === false ? 0 : 1);
  db.close();
  return { dbFile, env: { ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' } };
}

// gitOnlyPath() — a PATH containing ONLY the real `git` binary's directory
// (never the host's full PATH, which might resolve a REAL `hivecontrol` from
// an installed DevSwarm app and break the child-gate's STRICT-mode
// hermeticity — see devswarm-child-gate.test.js's own GIT_ONLY_PATH).
function gitOnlyPath() {
  const exe = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const p of String(process.env.PATH || '').split(path.delimiter)) {
    try { if (fs.existsSync(path.join(p, exe))) return p; } catch (_) {}
  }
  return '';
}

test('item B FIX (1): a caller whose worktree matches the app-DB builder row for the id -> RECORDED, and devswarm-child-gate then allows Stop', { skip: skipSqlite }, () => {
  const home = tmpHome();
  const repo = makeGitRepo('gt-match');
  try {
    const id = '85129db4-071f-4e30-b5a6-0c279e4e2704';
    const f = appDbFixture(home, [{ id, worktreePath: repo, isActive: true }]);
    const r = cli.run(
      ['heartbeat', id, '--summary', 'doing stuff'],
      ctx(home, { cwd: repo, env: f.env })
    );
    assert.strictEqual(r.result.ok, true);
    const mb = r.result.meshBroadcast;
    assert.ok(mb, 'a --summary heartbeat must attempt a mesh broadcast');
    assert.strictEqual(mb.ok, true, 'an app-DB-verified first claim must not be dropped: ' + JSON.stringify(mb));
    assert.ok(!mb.dropped);
    assert.strictEqual(r.result.note, undefined, 'no drop note on a successful broadcast');

    // End-to-end: the recorded broadcast must satisfy devswarm-child-gate's
    // alreadyReportedThisEpisode() (reads recent[] for from === DEVSWARM_BUILDER_ID)
    // so the Stop hook does NOT block/re-demand another heartbeat.
    const wdir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, id + '.json'), JSON.stringify({ id }));
    const gateEnv = Object.assign({}, f.env, {
      DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'feat/x', DEVSWARM_BUILDER_ID: id,
      PATH: gitOnlyPath(),
    });
    const gr = testHook('devswarm-child-gate.js', { hook_event_name: 'Stop', session_id: 's1', cwd: repo }, { home, env: gateEnv });
    assert.strictEqual(gr.stdout, '', `already-reported child must not be blocked; stdout: ${gr.stdout}`);
  } finally { rm(home); rm(repo); }
});

test('item B NEGATIVE (2): an unrelated caller claiming a never-registered id -> DROPPED with a note, and the real owner can still claim it afterward (no lockout)', { skip: skipSqlite }, () => {
  const home = tmpHome();
  const victimRepo = makeGitRepo('gt-victim');
  const attackerRepo = makeGitRepo('gt-attacker');
  try {
    const id = 'sibling-future-id';
    // The app DB knows nothing about this worktree at all (no builder row for
    // attackerRepo) — an unrelated cwd-resolved caller must NOT be able to
    // claim `id` just by being first.
    const f = appDbFixture(home, [{ id: 'some-other-builder', worktreePath: victimRepo, isActive: true }]);
    const r1 = cli.run(
      ['heartbeat', id, '--summary', 'i want it first'],
      ctx(home, { cwd: attackerRepo, env: f.env })
    );
    const mb1 = r1.result.meshBroadcast;
    assert.ok(mb1, 'a broadcast attempt must be reported');
    assert.strictEqual(mb1.ok, false, 'an unrelated caller must not be able to claim a never-registered id: ' + JSON.stringify(mb1));
    assert.strictEqual(mb1.dropped, true);
    assert.strictEqual(r1.result.note, 'summary NOT recorded: ' + mb1.dropReason,
      'the drop must be surfaced as a plain top-level note');

    // The REAL owner now presents from the worktree the app DB actually
    // names for `id` — it must still be able to claim it. No lockout from
    // the attacker's failed attempt above.
    const f2 = appDbFixture(home, [{ id, worktreePath: victimRepo, isActive: true }]);
    const r2 = cli.run(
      ['heartbeat', id, '--summary', 'the real owner claims it'],
      ctx(home, { cwd: victimRepo, env: f2.env })
    );
    const mb2 = r2.result.meshBroadcast;
    assert.ok(mb2, 'a broadcast attempt must be reported');
    assert.strictEqual(mb2.ok, true, 'the real owner must not be locked out by the attacker\'s prior failed attempt: ' + JSON.stringify(mb2));
    assert.ok(!mb2.dropped);
  } finally { rm(home); rm(victimRepo); rm(attackerRepo); }
});

test('item B NEGATIVE (2b) round 3: a caller cannot forge the app-DB "ground truth" via its own process env in a REAL CLI invocation -> DROPPED with a note', { skip: skipSqlite }, () => {
  // 0.117.1 round 3 (P0 R2-P0-env-forged-appdb-impersonation): unlike every
  // other test in this file, this one deliberately does NOT pass an `env`
  // key on ctx0 — it sets process.env itself, exactly like a real hostile
  // CLI invocation would, so ctx.env falls back to the real process.env
  // default (run()'s ctx.envExplicit === false) instead of an in-process
  // caller's own explicit env.
  const home = tmpHome();
  const repo = makeGitRepo('gt-env-forge');
  const savedDb = process.env.ANTIHALL_DEVSWARM_APP_DB;
  const savedCache = process.env.ANTIHALL_DEVSWARM_APP_DB_CACHE_MS;
  try {
    const id = 'sibling-future-id-envforge';
    const dbFile = path.join(home, 'forged-appdb.db');
    const db = new sqlite.DatabaseSync(dbFile);
    db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, worktreePath TEXT, isHidden INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1)');
    db.prepare('INSERT INTO builders (id, repositoryId, worktreePath, isHidden, isActive) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'r1', repo, 0, 1);
    db.close();
    process.env.ANTIHALL_DEVSWARM_APP_DB = dbFile;
    process.env.ANTIHALL_DEVSWARM_APP_DB_CACHE_MS = '0';

    const r = cli.run(
      ['heartbeat', id, '--summary', 'impersonating via forged env-redirected app db'],
      { home, backend: 'journal', cwd: repo } // no `env` key on ctx0 -> real CLI default (process.env)
    );
    const mb = r.result.meshBroadcast;
    assert.ok(mb, 'a broadcast attempt must be reported');
    assert.strictEqual(mb.ok, false, 'a forged ANTIHALL_DEVSWARM_APP_DB out of a real invocation\'s own process env must never grant first-claim: ' + JSON.stringify(mb));
    assert.strictEqual(mb.dropped, true);
    assert.strictEqual(r.result.note, 'summary NOT recorded: ' + mb.dropReason,
      'the drop must be surfaced as a plain top-level note');
  } finally {
    if (savedDb === undefined) delete process.env.ANTIHALL_DEVSWARM_APP_DB; else process.env.ANTIHALL_DEVSWARM_APP_DB = savedDb;
    if (savedCache === undefined) delete process.env.ANTIHALL_DEVSWARM_APP_DB_CACHE_MS; else process.env.ANTIHALL_DEVSWARM_APP_DB_CACHE_MS = savedCache;
    rm(home); rm(repo);
  }
});

test('item B NEGATIVE (2c) round 3: an archived-only builder row at the caller\'s worktree does NOT grant first-claim', { skip: skipSqlite }, () => {
  const home = tmpHome();
  const repo = makeGitRepo('gt-archived-only');
  try {
    const id = 'archived-only-id';
    // Only an ARCHIVED (isActive: false) builder row exists for this
    // worktree — 0.117.1 round 3 (R2-P2-archived-builder-fallback): the
    // ownership decision must never fall back to an archived/hidden row.
    const f = appDbFixture(home, [{ id, worktreePath: repo, isActive: false }]);
    const r = cli.run(
      ['heartbeat', id, '--summary', 'trying to claim via an archived row'],
      ctx(home, { cwd: repo, env: f.env })
    );
    const mb = r.result.meshBroadcast;
    assert.ok(mb, 'a broadcast attempt must be reported');
    assert.strictEqual(mb.ok, false, 'an archived-only builder row must not grant first-claim: ' + JSON.stringify(mb));
    assert.strictEqual(mb.dropped, true);
    assert.strictEqual(r.result.note, 'summary NOT recorded: ' + mb.dropReason,
      'the drop must be surfaced as a plain top-level note');
  } finally { rm(home); rm(repo); }
});

test('item B NEGATIVE (3): app DB missing/unreadable -> DROPPED with a note (fails closed, never claimed)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('gt-no-appdb');
  try {
    const id = 'no-app-db-id';
    const env = { ANTIHALL_DEVSWARM_APP_DB: path.join(home, 'does-not-exist.db'), ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
    const r = cli.run(
      ['heartbeat', id, '--summary', 'trying to claim without proof'],
      ctx(home, { cwd: repo, env })
    );
    const mb = r.result.meshBroadcast;
    assert.ok(mb, 'a broadcast attempt must be reported');
    assert.strictEqual(mb.ok, false, 'a missing/unreadable app DB must never grant first-claim: ' + JSON.stringify(mb));
    assert.strictEqual(mb.dropped, true);
    assert.strictEqual(r.result.note, 'summary NOT recorded: ' + mb.dropReason,
      'the drop must be surfaced as a plain top-level note');
  } finally { rm(home); rm(repo); }
});

test('item B NEGATIVE CONTROL: a descriptor-only id (no registry row, but already claimed) still DROPS', () => {
  const home = tmpHome();
  const repo = makeGitRepo('descriptor-only');
  try {
    // (a0) requires NO descriptor, not just no registry row — a descriptor
    // without a row is itself evidence `id` was already claimed at some
    // point (e.g. a tombstoned/re-homed registry row whose descriptor
    // survived), so this must still fall through to the fail-closed default.
    const id = 'descriptor-only-id';
    const descPath = cli.descriptorPath(home, id);
    fs.mkdirSync(path.dirname(descPath), { recursive: true });
    fs.writeFileSync(descPath, JSON.stringify({ id, worktreePath: repo, sessionId: 'some-old-session' }));
    const r = cli.run(
      ['heartbeat', id, '--summary', 'trying to claim'],
      ctx(home, { cwd: repo, env: {} })
    );
    const mb = r.result.meshBroadcast;
    assert.ok(mb, 'a broadcast attempt must be reported');
    assert.strictEqual(mb.ok, false, 'a descriptor-only id must not be (a0)-claimable: ' + JSON.stringify(mb));
    assert.strictEqual(mb.dropped, true);
    assert.strictEqual(r.result.note, 'summary NOT recorded: ' + mb.dropReason,
      'the drop must be surfaced as a plain top-level note');
  } finally { rm(home); rm(repo); }
});

test('MUTATION (item B round 2): reverting the app-DB ground-truth check reproduces the impersonation the review flagged', { skip: skipSqlite }, () => {
  mutantKit.withMutant(
    "          if (readDescriptorFile(home, target)) return false;\n"
      + "          const rawCwd0 = cwd || process.cwd();\n"
      + "          const wt0 = resolveCallerWorktree(rawCwd0);\n"
      + "          if (wt0) {\n"
      + "            const appDb = require('../../companion/lib/devswarm-app-db.js');\n"
      + "            const builder = appDb.builderForWorktree({ home, env, worktreePath: wt0, now: Date.now(), activeOnly: true });\n"
      + "            if (builder && String(builder.id) === target) return true;\n"
      + "          }",
    "          if (!readDescriptorFile(home, target)) return true;",
    (mutated, copy) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-0117b-mutant-'));
      fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-0117b-mutant-repo-'));
      cp.spawnSync('git', ['init', '-q', repo]);
      cp.spawnSync('git', ['-C', repo, 'config', 'user.email', 'a@b.c']);
      cp.spawnSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(repo, 'README.md'), 'x');
      cp.spawnSync('git', ['-C', repo, 'add', '.']);
      cp.spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
      try {
        const id = 'sibling-future-id-mutant';
        // No app DB at all — an unrelated cwd-resolved caller with nothing
        // to back its claim must still succeed under the MUTANT (proving the
        // ground-truth check is what the live code depends on).
        const r = mutated.run(
          ['heartbeat', id, '--summary', 'impersonating a sibling id'],
          Object.assign({ home, backend: 'journal', env: {} }, { cwd: repo })
        );
        const mb = r.result.meshBroadcast;
        assert.strictEqual(mb && mb.ok, true,
          'MUTANT must reproduce the impersonation — an unrelated caller claims a never-registered id with no ground truth');
      } finally { rm(home); rm(repo); }
    }
  );
});

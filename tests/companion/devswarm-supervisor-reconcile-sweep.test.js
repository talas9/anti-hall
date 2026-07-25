'use strict';
// devswarm-supervisor.js — C4 fix: the periodic liveness supervisor now also
// runs a COOLDOWN-GATED reconcile sweep (trigger-less recovery). Verified
// pre-fix: `devswarm.js reconcile` was MANUAL-only (update runs it post-update;
// doctor only under an explicit --fix gate) — nothing periodic ever swept it,
// so a stranded per-worktree native queue could sit for as long as it took an
// `update`/`doctor --fix` to happen to run. This exercises the NEW
// reconcileSweepIfDue/reconcileSweepEnabled/resolveReconcileCooldownMs/
// distinctRepoKeys surface with fully injected deps (hermetic — no real
// subprocess spawned, no real git touched) PLUS one real, unmocked
// end-to-end run through the actual scripts/devswarm.js reconcile call to
// prove the wiring (and the module.exports/require.main circular-require
// fix) is real, not just exercised via a stub.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const M = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-supervisor.js',
));
const pull = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-pull.js',
));
const devswarmCli = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm.js',
));

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-reconcile-sweep-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function descriptorsDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'workspaces'); }
function writeDescriptor(home, d, fileName) {
  const dir = descriptorsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const full = Object.assign({ inboxPath: '/i', cursorPath: '/c', sessionId: UUID }, d);
  fs.writeFileSync(path.join(dir, (fileName || d.id) + '.json'), JSON.stringify(full));
}
function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-sweep-repo-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  return dir;
}

// registerRealDescriptor(home, id, repo) — seeds a FULLY REAL, reconcile-
// ready descriptor via the actual `devswarm.js register` verb (never a
// hand-written liveness-only descriptor file): this writes BOTH the liveness
// descriptor (workspaces/<id>.json, what THIS module's own readDescriptors
// scans) AND upserts the SEPARATE per-project STORE registry cmdReconcile's
// `s.listRegistry()` actually targets — the two are genuinely distinct
// registries in this codebase (see cmdReconcile's own header), so a
// hand-written liveness-only descriptor is invisible to reconcile itself
// (count:0) and would silently prove nothing about the real drain path. `cwd`
// must equal `repo` — register refuses a cross-project registration when the
// caller's cwd resolves to a DIFFERENT repoKey than --worktree.
function registerRealDescriptor(home, id, repo) {
  const inboxPath = path.join(home, id + '-inbox.ndjson');
  const cursorPath = path.join(home, id + '-cursor.json');
  fs.writeFileSync(inboxPath, '');
  const r = devswarmCli.run(
    ['register', id, '--worktree', repo, '--session', UUID, '--inbox', inboxPath, '--cursor', cursorPath],
    { home, cwd: repo },
  );
  assert.strictEqual(r.code, 0, `registerRealDescriptor precondition failed: ${JSON.stringify(r.result)}`);
  return { inboxPath, cursorPath };
}

// ---------------------------------------------------------------------------
// reconcileSweepEnabled / resolveReconcileCooldownMs
// ---------------------------------------------------------------------------

test('reconcileSweepEnabled: on by default; off via its own toggle; off via the supervisor kill-switches', () => {
  assert.strictEqual(M.reconcileSweepEnabled({}), true);
  assert.strictEqual(M.reconcileSweepEnabled({ ANTIHALL_DEVSWARM_RECONCILE_SWEEP: 'off' }), false);
  assert.strictEqual(M.reconcileSweepEnabled({ ANTIHALL_DEVSWARM_SUPERVISOR: 'off' }), false, 'inherits the whole-supervisor off switch');
  assert.strictEqual(M.reconcileSweepEnabled({ DISABLE_ANTIHALL_DEVSWARM: '1' }), false, 'inherits the hard kill switch');
});

test('resolveReconcileCooldownMs: default; env override; floor clamp; garbage falls back to default', () => {
  assert.strictEqual(M.resolveReconcileCooldownMs({}), M.DEFAULT_RECONCILE_SWEEP_COOLDOWN_MS);
  assert.strictEqual(M.resolveReconcileCooldownMs({ ANTIHALL_DEVSWARM_RECONCILE_SWEEP_SEC: '600' }), 600 * 1000);
  assert.strictEqual(M.resolveReconcileCooldownMs({ ANTIHALL_DEVSWARM_RECONCILE_SWEEP_SEC: '10' }), 300 * 1000, 'floor: never below 5 minutes');
  assert.strictEqual(M.resolveReconcileCooldownMs({ ANTIHALL_DEVSWARM_RECONCILE_SWEEP_SEC: 'garbage' }), M.DEFAULT_RECONCILE_SWEEP_COOLDOWN_MS);
});

// ---------------------------------------------------------------------------
// distinctRepoKeys — dedup + fail-open filtering
// ---------------------------------------------------------------------------

test('distinctRepoKeys: dedupes descriptors sharing a repoKey to ONE representative worktreePath', () => {
  const descriptors = [
    { id: 'a', worktreePath: '/wt/proj1/a' },
    { id: 'b', worktreePath: '/wt/proj1/b' },
    { id: 'c', worktreePath: '/wt/proj2' },
  ];
  const map = { '/wt/proj1/a': 'proj1-key', '/wt/proj1/b': 'proj1-key', '/wt/proj2': 'proj2-key' };
  const out = M.distinctRepoKeys(descriptors, { repoKeyForWorktree: (wt) => map[wt] || null });
  assert.strictEqual(out.length, 2, 'must dedupe to 2 distinct projects, not 3 descriptors');
  const byKey = Object.fromEntries(out.map((o) => [o.repoKey, o.worktreePath]));
  assert.strictEqual(byKey['proj1-key'], '/wt/proj1/a', 'first-seen worktreePath wins as the representative');
  assert.strictEqual(byKey['proj2-key'], '/wt/proj2');
});

test('distinctRepoKeys: fail-open — a descriptor with no worktreePath, or an unresolvable/throwing repoKey, is skipped (never thrown)', () => {
  const descriptors = [
    { id: 'no-wt' }, // no worktreePath at all
    { id: 'unresolvable', worktreePath: '/wt/nogit' },
    { id: 'throws', worktreePath: '/wt/boom' },
    { id: 'ok', worktreePath: '/wt/ok' },
  ];
  const out = M.distinctRepoKeys(descriptors, {
    repoKeyForWorktree: (wt) => {
      if (wt === '/wt/nogit') return null;
      if (wt === '/wt/boom') throw new Error('git exploded');
      if (wt === '/wt/ok') return 'ok-key';
      return null;
    },
  });
  assert.deepStrictEqual(out, [{ repoKey: 'ok-key', worktreePath: '/wt/ok' }]);
});

// ---------------------------------------------------------------------------
// reconcileSweepIfDue — gating (disabled / no-descriptors / no-resolvable / cooldown)
// ---------------------------------------------------------------------------

test('reconcileSweepIfDue: disabled via env -> {ran:false, reason:"disabled"}; never touches state or calls runReconcile', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    let writeCalls = 0, runCalls = 0;
    const res = M.reconcileSweepIfDue({
      home, env: { ANTIHALL_DEVSWARM_RECONCILE_SWEEP: 'off' },
      deps: {
        writeReconcileSweepState: () => { writeCalls++; },
        runReconcile: () => { runCalls++; return { ok: true }; },
      },
    });
    assert.deepStrictEqual(res, { ran: false, reason: 'disabled' });
    assert.strictEqual(writeCalls, 0);
    assert.strictEqual(runCalls, 0);
  } finally { cleanup(); }
});

test('reconcileSweepIfDue: no descriptors at all -> {ran:false, reason:"no-descriptors"}', () => {
  const { home, cleanup } = makeHome();
  try {
    const res = M.reconcileSweepIfDue({ home, env: {} });
    assert.deepStrictEqual(res, { ran: false, reason: 'no-descriptors' });
  } finally { cleanup(); }
});

test('reconcileSweepIfDue: descriptors present but no repoKey resolves -> {ran:false, reason:"no-resolvable-projects"}', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    const res = M.reconcileSweepIfDue({
      home, env: {},
      deps: { repoKeyForWorktree: () => null },
    });
    assert.deepStrictEqual(res, { ran: false, reason: 'no-resolvable-projects' });
  } finally { cleanup(); }
});

test('reconcileSweepIfDue: within cooldown -> {ran:false, reason:"cooldown"}; runReconcile NEVER called (proves the gate actually gates)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    let runCalls = 0;
    const now = 1_000_000;
    const res = M.reconcileSweepIfDue({
      home, env: {}, now, cooldownMs: 900000,
      deps: {
        repoKeyForWorktree: () => 'key1',
        readReconcileSweepState: () => ({ lastRunAt: now - 1000 }), // 1s ago, well within a 15min cooldown
        runReconcile: () => { runCalls++; return { ok: true }; },
      },
    });
    assert.deepStrictEqual(res, { ran: false, reason: 'cooldown' });
    assert.strictEqual(runCalls, 0, 'a NON-VACUOUS proof the cooldown gate actually short-circuits before invoking reconcile');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// reconcileSweepIfDue — the actual sweep: dedup-invocation, cap, fail-open,
// and REAL on-disk cooldown persistence (this last one uses the real fs, not
// an injected stub, to prove the rate-limit is genuinely durable across ticks).
// ---------------------------------------------------------------------------

test('reconcileSweepIfDue: cooldown elapsed -> invokes runReconcile ONCE PER DISTINCT repoKey, not once per descriptor (dedup proof)', () => {
  const { home, cleanup } = makeHome();
  try {
    // 3 descriptors, only 2 distinct projects.
    writeDescriptor(home, { id: 'a1', worktreePath: '/wt/proj1/a' });
    writeDescriptor(home, { id: 'a2', worktreePath: '/wt/proj1/b' });
    writeDescriptor(home, { id: 'b1', worktreePath: '/wt/proj2' });
    const repoKeyMap = { '/wt/proj1/a': 'proj1', '/wt/proj1/b': 'proj1', '/wt/proj2': 'proj2' };
    const calls = [];
    const res = M.reconcileSweepIfDue({
      home, env: {}, now: 5000, cooldownMs: 0,
      deps: {
        repoKeyForWorktree: (wt) => repoKeyMap[wt],
        readReconcileSweepState: () => ({ lastRunAt: 0 }),
        writeReconcileSweepState: () => {},
        runReconcile: (wt) => { calls.push(wt); return { ok: true, imported: 0, lost: 0 }; },
      },
    });
    assert.strictEqual(res.ran, true);
    assert.strictEqual(res.projects, 2, 'exactly 2 distinct projects, NOT 3 (the bug this dedup prevents: over-reconciling the same project 3x)');
    assert.strictEqual(calls.length, 2, 'runReconcile must be called exactly once per distinct project');
    assert.deepStrictEqual(new Set(calls), new Set(['/wt/proj1/a', '/wt/proj2']));
  } finally { cleanup(); }
});

test('reconcileSweepIfDue: caps distinct projects reconciled per tick; the remainder is reported as "skipped", never dropped silently', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/p1' });
    writeDescriptor(home, { id: 'b', worktreePath: '/wt/p2' });
    writeDescriptor(home, { id: 'c', worktreePath: '/wt/p3' });
    const repoKeyMap = { '/wt/p1': 'k1', '/wt/p2': 'k2', '/wt/p3': 'k3' };
    let runCalls = 0;
    const res = M.reconcileSweepIfDue({
      home, env: {}, now: 5000, cooldownMs: 0, maxProjectsPerTick: 1,
      deps: {
        repoKeyForWorktree: (wt) => repoKeyMap[wt],
        readReconcileSweepState: () => ({ lastRunAt: 0 }),
        writeReconcileSweepState: () => {},
        runReconcile: () => { runCalls++; return { ok: true }; },
      },
    });
    assert.strictEqual(res.ran, true);
    assert.strictEqual(res.projects, 1, 'cap enforced: only 1 project attempted this tick');
    assert.strictEqual(res.skipped, 2, 'the other 2 are explicitly reported as skipped/deferred, not silently vanished');
    assert.strictEqual(runCalls, 1);
  } finally { cleanup(); }
});

test('reconcileSweepIfDue: a real DEFAULT cap constant exists and is a small positive bound', () => {
  assert.strictEqual(typeof M.MAX_RECONCILE_PROJECTS_PER_TICK, 'number');
  assert.ok(M.MAX_RECONCILE_PROJECTS_PER_TICK > 0 && M.MAX_RECONCILE_PROJECTS_PER_TICK <= 50);
});

test('reconcileSweepIfDue: fail-open — one project\'s runReconcile throwing does not abort the others', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/p1' });
    writeDescriptor(home, { id: 'b', worktreePath: '/wt/p2' });
    const repoKeyMap = { '/wt/p1': 'k1', '/wt/p2': 'k2' };
    const res = M.reconcileSweepIfDue({
      home, env: {}, now: 5000, cooldownMs: 0,
      deps: {
        repoKeyForWorktree: (wt) => repoKeyMap[wt],
        readReconcileSweepState: () => ({ lastRunAt: 0 }),
        writeReconcileSweepState: () => {},
        runReconcile: (wt) => { if (wt === '/wt/p1') throw new Error('boom'); return { ok: true, imported: 3 }; },
      },
    });
    assert.strictEqual(res.ran, true);
    assert.strictEqual(res.results.length, 2, 'both projects are still attempted despite one throwing');
    const p1 = res.results.find((r) => r.repoKey === 'k1');
    const p2 = res.results.find((r) => r.repoKey === 'k2');
    assert.strictEqual(p1.result.ok, false);
    assert.match(p1.result.error, /boom/);
    assert.strictEqual(p2.result.ok, true, 'the second project must still be attempted and succeed');
    assert.strictEqual(p2.result.imported, 3);
  } finally { cleanup(); }
});

test('reconcileSweepIfDue: fail-open — a throwing readDescriptors never propagates, returns {ran:false, error}', () => {
  const { home, cleanup } = makeHome();
  try {
    const res = M.reconcileSweepIfDue({
      home, env: {},
      deps: { readDescriptors: () => { throw new Error('fs exploded'); } },
    });
    assert.strictEqual(res.ran, false);
    assert.match(res.error, /fs exploded/);
  } finally { cleanup(); }
});

test('reconcileSweepIfDue: persists lastRunAt to the REAL on-disk state file (not just an injected stub) — a second real call right after reads "cooldown"', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/p1' });
    const t0 = Date.now();
    const r1 = M.reconcileSweepIfDue({
      home, env: {}, now: t0,
      deps: {
        repoKeyForWorktree: () => 'k1',
        runReconcile: () => ({ ok: true, imported: 0 }),
      }, // NOTE: readReconcileSweepState/writeReconcileSweepState NOT injected -> real fs
    });
    assert.strictEqual(r1.ran, true);

    const statePath = M.reconcileSweepStatePath(home);
    assert.ok(fs.existsSync(statePath), 'the real state file must have been written to disk');
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(onDisk.lastRunAt, t0);

    // A second real call moments later (still real fs) must read the cooldown
    // it just persisted — proves readReconcileSweepState's real fs.readFileSync
    // path round-trips correctly with writeReconcileSweepState's real write.
    const r2 = M.reconcileSweepIfDue({
      home, env: {}, now: t0 + 1000,
      deps: { repoKeyForWorktree: () => 'k1', runReconcile: () => { throw new Error('must not be called'); } },
    });
    assert.deepStrictEqual(r2, { ran: false, reason: 'cooldown' });
  } finally { cleanup(); }
});

test('reconcileSweepIfDue: main()\'s wiring reuses the SAME state file path readReconcileSweepState/writeReconcileSweepState use directly', () => {
  const { home, cleanup } = makeHome();
  try {
    const p = M.reconcileSweepStatePath(home);
    assert.strictEqual(path.basename(p), 'reconcile-sweep-state.json');
    assert.ok(p.startsWith(path.join(home, '.anti-hall', 'devswarm')), 'must live under the devswarm root, not the user project tree');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// REAL end-to-end wiring (no runReconcile/repoKeyForWorktree injected) — this
// is the strongest possible proof the glue code correctly reuses the EXISTING
// reconcile entry point (scripts/devswarm.js's `run(['reconcile'], ctx)`, the
// exact call doctor-repair.js already makes) rather than a mocked stand-in,
// and that the module.exports/require.main circular-require fix (see the
// comment at the bottom of devswarm-supervisor.js) actually holds.
// ---------------------------------------------------------------------------

test('REAL WIRING: an unmocked reconcile call against a real registered descriptor actually attempts a pull and returns the real cmdReconcile shape, keyed by the real repoKey', () => {
  const { home, cleanup } = makeHome();
  const repo = makeGitRepo();
  try {
    registerRealDescriptor(home, 'real-ws', repo);
    // NOTE: env deliberately OMITTED (not `env: {}` — an empty-but-truthy
    // object would short-circuit reconcileSweepIfDue's `o.env || process.env`
    // fallback and strip PATH from the real `inbox pull` subprocess spawn,
    // breaking its own native `hivecontrol` lookup for reasons unrelated to
    // this test's actual subject).
    const res = M.reconcileSweepIfDue({ home, cooldownMs: 0 }); // no deps injected at all
    assert.strictEqual(res.ran, true);
    assert.strictEqual(res.results.length, 1);
    const r = res.results[0].result;
    // NOT HERMETIC to assert r.ok===true / r.results[0].ok===true here: the
    // underlying inbox-pull subprocess's FIRST step spawns the real
    // `hivecontrol` binary (devswarm-pull.js pullOnce's `message-count` call),
    // which is not on CI runners (ubuntu/macos/windows have no DevSwarm.app) —
    // that ENOENT is a genuine, expected outcome on CI, not a bug in the glue
    // code under test here. This proves the SUBPROCESS PLUMBING (spawn
    // args/cwd/repoKey routing), the same posture devswarm-lifecycle.test.js
    // already takes for the identical reason (see its own comment there).
    assert.strictEqual(r.action, 'reconcile');
    assert.strictEqual(r.count, 1, 'the real STORE registry (not just the liveness descriptor) must show exactly the one registered target');
    assert.strictEqual(r.results[0].id, 'real-ws');
    assert.strictEqual(typeof r.ok, 'boolean', 'r.ok must be a real boolean outcome (whatever the underlying hivecontrol availability produces)');
    assert.strictEqual(typeof r.results[0].ok, 'boolean', 'the per-target result must carry a real boolean outcome');
    assert.strictEqual(typeof r.repoKey, 'string');
    assert.ok(r.repoKey.length > 0);
    // Independently re-derive the SAME repoKey the real devswarm-repokey.js
    // module would, to prove it's the genuine per-project key, not a stub value.
    const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
    assert.strictEqual(r.repoKey, repokey.repoKeyForWorktree(repo));
  } finally { cleanup(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('REAL LOCK REUSE: the reconcile sweep observes the SAME per-id O_EXCL pull lock a live child\'s own `inbox pull` already uses — never a parallel lock', () => {
  const { home, cleanup } = makeHome();
  const repo = makeGitRepo();
  try {
    const id = 'locked-ws';
    registerRealDescriptor(home, id, repo);

    // Pre-hold the REAL per-id pull lock (the exact primitive devswarm-pull.js's
    // pullOnce acquires) with a LIVE, fresh holder (our own pid) — simulating a
    // live child concurrently draining its own inbox right now.
    const lockPath = pull.pullLockPath(home, id);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'held-by-live-child' }));

    try {
      const res = M.reconcileSweepIfDue({ home, cooldownMs: 0 }); // fully real, no deps injected (env omitted — see the WIRING test's note above)
      assert.strictEqual(res.ran, true);
      const r = res.results[0].result;
      assert.strictEqual(r.count, 1, 'precondition: the real target must actually have been visited, not silently zero');
      const target = r.results[0];
      // If the reconcile sweep had invented its OWN parallel lock instead of
      // reusing this one, the underlying inbox-pull subprocess would have sailed
      // straight past our pre-held lock — the REAL contention signal
      // (`locked:true`, from devswarm-pull.js's own `acquireExclLock` refusing a
      // live/fresh holder) is the proof it went through the SAME lock this live
      // "child" already holds.
      assert.strictEqual(target.locked, true, `must observe the pre-held per-id lock as genuine contention, never race past it; got ${JSON.stringify(target)}`);
      assert.match(target.error, /holds the lock/i);
      assert.strictEqual(target.ok, false, 'a locked-out target must not be reported as a successful reconcile');
      assert.strictEqual(r.rejected, 0, 'lock contention is a benign skip, never an ownership rejection');
    } finally {
      try { fs.unlinkSync(lockPath); } catch (_) {}
    }
  } finally { cleanup(); fs.rmSync(repo, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// main() end-to-end (direct entry-script invocation) — proves the reorder fix
// (module.exports assigned BEFORE the require.main-gated main() call) holds
// in the EXACT production deployment shape: `node devswarm-supervisor.js`
// invoked directly by launchd/systemd/cron, where the pre-fix ordering would
// have exposed scripts/devswarm.js's circular require of THIS module to a
// still-empty exports object.
// ---------------------------------------------------------------------------

const SUPERVISOR_SCRIPT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-supervisor.js');

test('main() as a real entry-script process: reconcile-sweep runs, persists cooldown state, and the process exits 0 (circular-require fix holds)', () => {
  const { home, cleanup } = makeHome();
  const repo = makeGitRepo();
  try {
    registerRealDescriptor(home, 'entry-ws', repo);
    const env = Object.assign({}, process.env, { HOME: home });
    delete env.DEVSWARM_REPO_ID; delete env.DEVSWARM_BUILDER_ID; delete env.DEVSWARM_PRIMARY;
    delete env.DEVSWARM_SESSION_ID; delete env.DEVSWARM_REPO_KEY;

    const r1 = cp.spawnSync(process.execPath, [SUPERVISOR_SCRIPT], { encoding: 'utf8', env, timeout: 30000 });
    assert.strictEqual(r1.status, 0, `must exit 0; stderr=${r1.stderr}`);
    const out1 = JSON.parse(r1.stdout.trim());
    assert.strictEqual(out1.reconcile.ran, true, `first run must attempt reconcile (never run before); got ${r1.stdout}`);
    assert.strictEqual(out1.reconcile.projects, 1);
    // NOT HERMETIC to assert result.ok===true here — see the REAL WIRING
    // test's comment above: the underlying inbox-pull subprocess's first step
    // spawns the real `hivecontrol` binary, which is not on CI runners. This
    // proves the entry-script/circular-require wiring, not native hivecontrol
    // behavior.
    assert.strictEqual(typeof out1.reconcile.results[0].result.ok, 'boolean');
    assert.strictEqual(out1.reconcile.results[0].result.count, 1, 'the real registered descriptor must actually be visited by this real subprocess run');
    assert.strictEqual(out1.reconcile.results[0].result.results[0].id, 'entry-ws');

    // Cooldown must be REAL and durable across process invocations (this is
    // launchd/cron's actual usage pattern — a fresh process every tick).
    const r2 = cp.spawnSync(process.execPath, [SUPERVISOR_SCRIPT], { encoding: 'utf8', env, timeout: 30000 });
    assert.strictEqual(r2.status, 0);
    const out2 = JSON.parse(r2.stdout.trim());
    assert.strictEqual(out2.reconcile.ran, false);
    assert.strictEqual(out2.reconcile.reason, 'cooldown', `a second immediate tick must be cooldown-gated; got ${r2.stdout}`);
  } finally { cleanup(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('main(): the env off-switch disables reconcile even with descriptors and no prior cooldown', () => {
  const { home, cleanup } = makeHome();
  const repo = makeGitRepo();
  try {
    registerRealDescriptor(home, 'off-ws', repo);
    const env = Object.assign({}, process.env, { HOME: home, ANTIHALL_DEVSWARM_RECONCILE_SWEEP: 'off' });
    delete env.DEVSWARM_REPO_ID; delete env.DEVSWARM_BUILDER_ID; delete env.DEVSWARM_PRIMARY;
    delete env.DEVSWARM_SESSION_ID; delete env.DEVSWARM_REPO_KEY;
    const r = cp.spawnSync(process.execPath, [SUPERVISOR_SCRIPT], { encoding: 'utf8', env, timeout: 30000 });
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout.trim());
    assert.deepStrictEqual(out.reconcile, { ran: false, reason: 'disabled' });
  } finally { cleanup(); fs.rmSync(repo, { recursive: true, force: true }); }
});

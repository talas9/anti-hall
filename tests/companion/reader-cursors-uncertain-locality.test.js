'use strict';
// P2-b fix — reader-cursors.js's repairPinnedFloors retirement (the v0.106.1
// "not-local" verdict) treated ANY non-matching cwdInPartition() answer as a
// CONFIRMED "this session is not local to the partition", including one that
// came from an UNRESOLVABLE identity.resolveContext call (a git
// `--show-superproject-working-tree` timeout on a non-absorbed submodule, see
// identity.js's own `uncertain` field, added by this same fix). A timed-out
// resolution could mint a WRONG meshId for the session's cwd, causing this
// code to retire (and the floor to advance past) a row that was never proven
// foreign — real loss.
//
// This proves, via `rc.repairPinnedFloors` (the actual production function),
// that:
//   - a CONFIRMED not-local session (resolveContext succeeds, meshId
//     genuinely differs) is still retired exactly as before (no regression);
//   - an UNCERTAIN resolution (resolveContext could not answer with
//     certainty) KEEPS the row and leaves the floor unchanged, instead of
//     retiring it on an unproven guess.
//
// identity.resolveContext is monkeypatched for the ONE session cwd under
// test (a plain, mutable export — not the real module's git behavior) so the
// "timeout" is deterministic and fast; every OTHER resolveContext call (the
// partition's own worktree, used to build `meshIds`) goes through the REAL
// implementation unchanged.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const rc = require(path.join(ROOT, 'companion', 'lib', 'reader-cursors.js'));
const liveness = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));
const identity = require(path.join(ROOT, 'companion', 'lib', 'identity.js'));

const HASH = 'fixture-repo-uncertain-locality';
const STARTED = 1791000000000;
const PID = 6001;
const READER = 'h:' + PID + ':' + STARTED;

function mkRepo(dir) { fs.mkdirSync(path.join(dir, '.git'), { recursive: true }); return fs.realpathSync(dir); }
function writeSession(home, pid, cwd) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, pid + '.json'), JSON.stringify({ pid, sessionId: 's-' + pid, cwd, startedAt: STARTED }));
}

// seed(home) -> { mainWt, PARTITION }. ONE partition, 5 messages, floor at 2
// (the local reader's own read position — the row this fix must not lose),
// and ONE live session (PID/READER) whose cwd is the thing under test.
function seed(home, flakyCwd) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-uncertain-locality-'));
  const mainWt = mkRepo(path.join(base, 'main'));
  const PARTITION = identity.meshIdForRealPath(mainWt);
  const root = liveness.devswarmRoot(home);
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', PARTITION + '.json'), JSON.stringify({
    id: PARTITION, worktreePath: mainWt, sessionId: 's-' + PID, inboxPath: null, cursorPath: null,
  }));
  writeSession(home, PID, flakyCwd);
  const s = storeLib.openStore({ home, hash: HASH });
  try {
    for (let i = 0; i < 5; i++) s.appendMessage({ workspaceId: PARTITION, hash: 'm' + i, body: 'b' + i, ts: i + 1 });
    s.readerCursorTxn((tx) => {
      tx.put({ partition: PARTITION, ns: 'store', reader: rc.FLOOR, value: 2, updatedAt: 1 });
      tx.put({ partition: PARTITION, ns: 'nd', reader: rc.FLOOR, value: 0, updatedAt: 1 });
      // The session's OWN row: at the floor (never advanced past it) — the
      // exact shape `repairPinnedFloors` retires on a CONFIRMED not-local
      // verdict (see planFor's `v === 'not-local' && r.value <= f.value`).
      tx.put({ partition: PARTITION, ns: 'store', reader: READER, value: 2, updatedAt: 1 });
      tx.put({ partition: PARTITION, ns: 'nd', reader: READER, value: 0, updatedAt: 1 });
    });
  } finally { s.close(); }
  return { home, base, mainWt, PARTITION, s: () => storeLib.openStore({ home, hash: HASH }) };
}

function withHome(home, fn) {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try { return fn(); } finally { process.env.HOME = prev.HOME; process.env.USERPROFILE = prev.USERPROFILE; }
}

// withPatchedResolveContext(cwdToFake, fakeCtx, fn) — replaces
// identity.resolveContext with a wrapper that returns `fakeCtx` ONLY for
// `cwdToFake` (string equality); every other call (e.g. the partition's own
// worktree, resolved while building `meshIds`) goes through the REAL
// resolveContext unchanged. Restores the original export afterwards
// regardless of outcome.
function withPatchedResolveContext(cwdToFake, fakeCtx, fn) {
  const orig = identity.resolveContext;
  identity.resolveContext = (cwd, opts) => (cwd === cwdToFake ? fakeCtx : orig(cwd, opts));
  try { return fn(); } finally { identity.resolveContext = orig; }
}

test('CONFIRMED not-local (resolveContext succeeds, meshId genuinely differs) -> still retired (no regression)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-uncertain-locality-home-'));
  const FLAKY_CWD = '/does/not/matter/confirmed';
  const { mainWt, PARTITION } = seed(home, FLAKY_CWD);
  try {
    withHome(home, () => {
      const fakeCtx = { uncertain: false, meshId: 'primary-deadbeef0' }; // definitely NOT the partition's own meshId
      withPatchedResolveContext(FLAKY_CWD, fakeCtx, () => {
        const s = storeLib.openStore({ home, hash: HASH });
        try {
          const plan = rc.repairPinnedFloors(s, { partition: PARTITION, home, dryRun: true, procTable: null });
          assert.ok(plan.retired.some((r) => r.includes(READER) && r.includes('not-local')), 'confirmed not-local must still retire: ' + JSON.stringify(plan));
        } finally { s.close(); }
      });
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(path.dirname(mainWt), { recursive: true, force: true }); }
});

test('UNCERTAIN resolution (identity could not resolve with certainty) -> KEEPS the row, floor unchanged', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-uncertain-locality-home-'));
  const FLAKY_CWD = '/does/not/matter/uncertain';
  const { mainWt, PARTITION } = seed(home, FLAKY_CWD);
  try {
    withHome(home, () => {
      // Simulates exactly what a git timeout produces per identity.js's own
      // fix: gitSuperproject fails closed to `null` ("no superproject"),
      // which can mint a meshId for the wrong (this dir's own) root — a
      // PRESENT but WRONG meshId, flagged uncertain.
      const fakeCtx = { uncertain: true, meshId: 'primary-deadbeef0' };
      withPatchedResolveContext(FLAKY_CWD, fakeCtx, () => {
        const s = storeLib.openStore({ home, hash: HASH });
        try {
          const plan = rc.repairPinnedFloors(s, { partition: PARTITION, home, dryRun: true, procTable: null });
          assert.strictEqual(plan.retired.length, 0, 'an uncertain resolution must never retire a row: ' + JSON.stringify(plan));
          assert.strictEqual(plan.floors.store.to, plan.floors.store.from, 'the floor must not advance past a KEPT row');
        } finally { s.close(); }
      });
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(path.dirname(mainWt), { recursive: true, force: true }); }
});

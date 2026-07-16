'use strict';
// v0.55.x P0 message-loss regression — "retire the legacy row on self-register".
//
// ROOT CAUSE: a DevSwarm child registers TWICE for one worktree — a legacy
// hivecontrol-native row (free-form `<label>-<repoId8>` id) AND its own per-project
// builder-id row (a UUID). Both rows carry the SAME worktreePath, so both resolve to
// the same meshId. `resolveMeshTarget` picks ONE (id-ASC), while the child drains its
// OWN builder-id partition — so a `send` routed to the legacy row lands in a partition
// no live session ever reads (silent loss; WS-4 was 100%).
//
// FIX: when the child self-registers under its builder-id, retire every OTHER
// same-worktree row (sanctioned registry tombstone — messages are NEVER deleted),
// FORWARDING each retired partition's unread direct backlog into the survivor first,
// so send-target and child-drain converge on ONE partition and nothing is orphaned.
//
// Exercised in-process via cli.run(argv, ctx) with an injected tmp HOME + forced
// journal backend (deterministic on every node version), and REAL git worktrees as
// ctx.cwd (repoKeyForWorktree spawns a real git). Mirrors devswarm-send.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-retire-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-retire-repo-' + tag + '-'));
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
  cp.spawnSync('git', ['-C', mainDir, 'worktree', 'add', '-q', wt, '-b', 'branch-' + tag]);
  return wt;
}
// The meshId production derives for a REAL git worktree (resolved toplevel, not the
// raw path — matches callerIdentity / resolveMeshTarget on every platform).
function meshOf(dir) { return inst.primaryWorkspaceId(inst.resolveWorktree(dir)); }
function topOf(dir) { return inst.resolveWorktree(dir); }

function seedRegistry(home, repoKey, desc) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { s.upsertRegistry(desc); } finally { s.close(); }
}
function partitionBodies(home, repoKey, id) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { return s.listMessages(id, {}).map((m) => m.body); } finally { s.close(); }
}
function rowsForMesh(home, repoKey, mesh) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    return s.listRegistry()
      .filter((d) => d.worktreePath && inst.primaryWorkspaceId(d.worktreePath) === mesh)
      .map((d) => d.id)
      .sort();
  } finally { s.close(); }
}

// Legacy id is chosen to sort BEFORE the builder-id so CURRENT code's resolveMeshTarget
// (first live match in id-ASC order) picks the DEAD legacy partition — making the
// "reach" assertion below genuinely fail-first, not an id-ordering accident.
const LEGACY_ID = 'child-aaa-legacy-a55f20ef';
const CHILD_ID = 'child-zzz-builder-uuid';

test('self-register retires a legacy duplicate row for the same worktree: one row survives, a post-cutover send reaches the drained partition, and the retired partition\'s pre-existing unread is forwarded (not lost)', () => {
  const home = tmpHome();
  const main = makeGitRepo('conv');
  const child = addLinkedWorktree(main, 'child');
  try {
    const repoKey = repokey.repoKeyForWorktree(child);
    const childTop = topOf(child);
    const childMesh = meshOf(child);

    // Legacy hivecontrol-native row already live for this worktree (same worktreePath
    // -> same meshId as the child's own row will be).
    seedRegistry(home, repoKey, { id: LEGACY_ID, worktreePath: childTop, sessionId: 'legacy-sess' });

    // A message sent BEFORE the child self-registers: only the legacy row matches, so
    // it lands in the legacy (dead) partition — the backlog a real child silently lost.
    const pre = cli.run(['send', '--to', childMesh, '--message', 'pre-existing-1'], ctx(home, { cwd: main }));
    assert.strictEqual(pre.result.ok, true, 'pre-register send should succeed');
    assert.deepStrictEqual(partitionBodies(home, repoKey, LEGACY_ID), ['pre-existing-1'],
      'pre-existing message must land in the legacy partition');
    assert.deepStrictEqual(partitionBodies(home, repoKey, CHILD_ID), [],
      'child partition starts empty');

    // Child self-registers under its builder-id -> retire + forward.
    const reg = cli.run(['register', CHILD_ID, '--worktree', childTop, '--session', 'child-sess'], ctx(home, { cwd: child }));
    assert.strictEqual(reg.result.ok, true, 'register should succeed');
    assert.deepStrictEqual(reg.result.retiredDuplicates, [LEGACY_ID], 'the legacy row is retired');
    assert.strictEqual(reg.result.forwardedMessages, 1, 'the one pre-existing unread is forwarded');

    // (a) SURVIVE: exactly one row for this worktree — the child's own builder-id.
    assert.deepStrictEqual(rowsForMesh(home, repoKey, childMesh), [CHILD_ID],
      'exactly one registry row survives for the worktree after retire');

    // A NEW send AFTER cutover must resolve to the surviving row and land in the
    // partition the child drains.
    const post = cli.run(['send', '--to', childMesh, '--message', 'after-cutover'], ctx(home, { cwd: main }));
    assert.strictEqual(post.result.ok, true, 'post-cutover send should succeed');

    // (b) REACH + (c) NO-LOSS: the child's OWN partition now holds BOTH the forwarded
    // pre-existing backlog AND the post-cutover send — read via the ordinary child
    // read path (inbox messages <builder-id>).
    const read = cli.run(['inbox', 'messages', CHILD_ID], ctx(home, { cwd: child }));
    assert.strictEqual(read.result.ok, true);
    const bodies = read.result.messages.map((m) => m.body);
    assert.ok(bodies.includes('pre-existing-1'), 'pre-existing unread was forwarded into the drained partition (no loss)');
    assert.ok(bodies.includes('after-cutover'), 'the post-cutover send reaches the drained partition');

    // NON-DESTRUCTIVE: the legacy partition's original message rows are NOT deleted
    // (retire tombstones the registry row only; message data is preserved/forwarded).
    assert.deepStrictEqual(partitionBodies(home, repoKey, LEGACY_ID), ['pre-existing-1'],
      'retired partition message rows are preserved (forwarded, never deleted)');
  } finally {
    cp.spawnSync('git', ['-C', main, 'worktree', 'remove', '--force', child]);
    rm(main); rm(child); rm(home);
  }
});

test('retire is idempotent and never double-forwards across repeated self-registers (steady-state child inbox-pull path)', () => {
  const home = tmpHome();
  const main = makeGitRepo('idem');
  const child = addLinkedWorktree(main, 'child');
  try {
    const repoKey = repokey.repoKeyForWorktree(child);
    const childTop = topOf(child);
    const childMesh = meshOf(child);
    seedRegistry(home, repoKey, { id: LEGACY_ID, worktreePath: childTop, sessionId: 'legacy-sess' });
    cli.run(['send', '--to', childMesh, '--message', 'pre-existing-1'], ctx(home, { cwd: main }));

    const first = cli.run(['register', CHILD_ID, '--worktree', childTop, '--session', 'child-sess'], ctx(home, { cwd: child }));
    assert.strictEqual(first.result.forwardedMessages, 1);

    // Repeated ensure (what `inbox pull` auto-runs every turn) must be a clean no-op.
    for (let i = 0; i < 3; i++) {
      const again = cli.run(['ensure', CHILD_ID, '--worktree', childTop, '--session', 'child-sess'], ctx(home, { cwd: child }));
      assert.strictEqual(again.result.ok, true);
      assert.ok(again.result.retiredDuplicates === undefined, 're-ensure retires nothing (legacy already gone)');
    }

    // Exactly ONE copy of the forwarded message — no duplication across re-runs.
    const copies = partitionBodies(home, repoKey, CHILD_ID).filter((b) => b === 'pre-existing-1');
    assert.strictEqual(copies.length, 1, 'forwarded message is not duplicated on repeated self-register');
    assert.deepStrictEqual(rowsForMesh(home, repoKey, childMesh), [CHILD_ID]);
  } finally {
    cp.spawnSync('git', ['-C', main, 'worktree', 'remove', '--force', child]);
    rm(main); rm(child); rm(home);
  }
});

// P2b — a forward failure must NOT be swallowed silently. When re-appending a
// retired partition's backlog throws, the row is deliberately LEFT (never tombstoned,
// so no unread is stranded — fail-open), but register must SURFACE it: `forwardFailed`
// carries the id AND no throw escapes. Injected by stubbing the module-singleton
// appendMeshMessage (retire uses the SAME require'd instance) to throw during forward.
test('P2b: a forward failure leaves the row in place (not tombstoned) and surfaces forwardFailed, without throwing (fail-open, not silent)', () => {
  const home = tmpHome();
  const main = makeGitRepo('p2b');
  const child = addLinkedWorktree(main, 'child');
  const realAppend = storeLib.appendMeshMessage;
  try {
    const repoKey = repokey.repoKeyForWorktree(child);
    const childTop = topOf(child);
    const childMesh = meshOf(child);
    // Legacy store-only row + one forwardable direct in its partition (seeded via the
    // REAL primitive, BEFORE the failure is injected).
    seedRegistry(home, repoKey, { id: LEGACY_ID, worktreePath: childTop, sessionId: 'legacy-sess' });
    {
      const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
      try {
        const fields = { from: 'peer', to: LEGACY_ID, type: 'direct', message: 'must-not-be-lost', timestamp: Date.now(), urgency: 'normal' };
        storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: storeLib.meshMessageHash(fields) }));
      } finally { s.close(); }
    }
    // INJECT: forwarding THROWS (retireWorktreeDuplicates re-appends via appendMeshMessage).
    storeLib.appendMeshMessage = () => { throw new Error('injected forward failure'); };

    let reg;
    assert.doesNotThrow(() => {
      reg = cli.run(['register', CHILD_ID, '--worktree', childTop, '--session', 'child-sess'], ctx(home, { cwd: child }));
    }, 'a forward failure must never throw (fail-open stays)');
    assert.strictEqual(reg.result.ok, true, 'register still returns ok:true (fail-open)');
    assert.ok((reg.result.forwardFailed || []).includes(LEGACY_ID), 'the failed-forward row is surfaced in forwardFailed');
    assert.ok(!(reg.result.retiredDuplicates || []).includes(LEGACY_ID), 'the row is NOT tombstoned when its forward failed');
    assert.ok(rowsForMesh(home, repoKey, childMesh).includes(LEGACY_ID), 'the legacy row is LEFT in the registry (no unread stranded)');
  } finally {
    storeLib.appendMeshMessage = realAppend;
    cp.spawnSync('git', ['-C', main, 'worktree', 'remove', '--force', child]);
    rm(main); rm(child); rm(home);
  }
});

test('a meshId-keyed register (register-primary / spawn phantom) never retires a live builder-id row for the same worktree', () => {
  const home = tmpHome();
  const main = makeGitRepo('gate');
  try {
    const repoKey = repokey.repoKeyForWorktree(main);
    const mainTop = topOf(main);
    const mainMesh = meshOf(main);
    // A live builder-id row on the MAIN worktree (e.g. a Primary that also self-heals
    // an inbox pull). register-primary keys off the meshId (id === worktree mesh), so
    // the gate must skip retire and leave the builder-id row intact.
    seedRegistry(home, repoKey, { id: 'main-builder-uuid', worktreePath: mainTop, sessionId: 'x' });
    const r = cli.run(['register-primary', '--session', 'psess'], ctx(home, { cwd: main }));
    assert.strictEqual(r.result.ok, true);
    assert.ok(r.result.retiredDuplicates === undefined, 'register-primary retires nothing');
    const rows = rowsForMesh(home, repoKey, mainMesh);
    assert.ok(rows.includes('main-builder-uuid'), 'the live builder-id row survives a meshId-keyed register');
    assert.ok(rows.includes(mainMesh), 'the Primary meshId row is present');
  } finally {
    rm(main); rm(home);
  }
});

// ===========================================================================
// P2: the SAME cutover scenarios run on BOTH backends (journal always; sqlite
// only when node:sqlite is present — production selects sqlite, devswarm-store.js
// selectBackend). Covers the P0 routing-prefers-drained guarantee AND the P1
// mis-retire hardening, so neither is a journal-only assertion. Idiom mirrors
// tests/companion/devswarm-store.test.js (push sqlite iff sqliteAvailable()).
// ===========================================================================
const backends = [{ name: 'journal', backend: 'journal' }];
if (storeLib.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

// tick() — spin until Date.now() strictly advances (<1ms) so a row registered
// AFTER another is GUARANTEED a greater registry updatedAt, deterministically (no
// fixed sleep, no flake). This is exactly what makes "freshest-live wins" testable.
function tick() { const t = Date.now(); while (Date.now() === t) { /* spin */ } }

for (const B of backends) {
  const bctx = (home, over) => Object.assign({ home, backend: B.backend, env: {} }, over || {});
  const seedB = (home, repoKey, desc) => {
    const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
    try { s.upsertRegistry(desc); } finally { s.close(); }
  };
  const bodiesB = (home, repoKey, id) => {
    const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
    try { return s.listMessages(id, {}).map((m) => m.body); } finally { s.close(); }
  };
  const rowsForMeshB = (home, repoKey, mesh) => {
    const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
    try {
      return s.listRegistry()
        .filter((d) => d.worktreePath && inst.primaryWorkspaceId(d.worktreePath) === mesh)
        .map((d) => d.id).sort();
    } finally { s.close(); }
  };

  // P0 — routing prefers the drained row EVEN IF retire never ran. TWO live rows for
  // one worktree (a child re-registered under a new builder-id while an older live
  // builder-id row lingers). The stale row sorts BEFORE the fresh row in id-ASC, so
  // the pre-fix "first live by id" picked the STALE partition no live session drains
  // (fail-first, verified). The freshest-live row (greater updatedAt) must win.
  test(`[${B.name}] P0 routing: two LIVE rows -> send reaches the FRESHEST-maintained (drained) row, not first-by-id (retire NOT run)`, () => {
    const home = tmpHome();
    const main = makeGitRepo('p0live-' + B.name);
    const child = addLinkedWorktree(main, 'c');
    try {
      const repoKey = repokey.repoKeyForWorktree(child);
      const childTop = topOf(child);
      const childMesh = meshOf(child);
      const STALE = 'aaa-stale-worker'; // sorts BEFORE
      const FRESH = 'zzz-fresh-worker'; // sorts AFTER, registered later -> fresher updatedAt
      seedB(home, repoKey, { id: STALE, worktreePath: childTop, sessionId: 'stale-sess' });
      tick();
      seedB(home, repoKey, { id: FRESH, worktreePath: childTop, sessionId: 'fresh-sess' });

      const r = cli.run(['send', '--to', childMesh, '--message', 'to-drained'], bctx(home, { cwd: main }));
      assert.strictEqual(r.result.ok, true, 'send should succeed');
      assert.deepStrictEqual(bodiesB(home, repoKey, FRESH), ['to-drained'], 'lands in the freshest live (drained) partition');
      assert.deepStrictEqual(bodiesB(home, repoKey, STALE), [], 'the stale live partition receives nothing');
    } finally {
      cp.spawnSync('git', ['-C', main, 'worktree', 'remove', '--force', child]);
      rm(main); rm(child); rm(home);
    }
  });

  // P0/retire cutover — the legacy-row scenario (retire + forward + no-loss + one
  // survivor + post-cutover send reaches the drained partition), now asserted on
  // sqlite too (parity of the journal-only test above).
  test(`[${B.name}] cutover: self-register retires a store-only legacy row, forwards its backlog, one survivor, post-cutover send reaches the drained partition (no loss)`, () => {
    const home = tmpHome();
    const main = makeGitRepo('p0cut-' + B.name);
    const child = addLinkedWorktree(main, 'c');
    try {
      const repoKey = repokey.repoKeyForWorktree(child);
      const childTop = topOf(child);
      const childMesh = meshOf(child);
      seedB(home, repoKey, { id: LEGACY_ID, worktreePath: childTop, sessionId: 'legacy-sess' });
      const pre = cli.run(['send', '--to', childMesh, '--message', 'pre-existing-1'], bctx(home, { cwd: main }));
      assert.strictEqual(pre.result.ok, true);
      assert.deepStrictEqual(bodiesB(home, repoKey, LEGACY_ID), ['pre-existing-1'], 'pre-register message lands in the legacy partition');

      const reg = cli.run(['register', CHILD_ID, '--worktree', childTop, '--session', 'child-sess'], bctx(home, { cwd: child }));
      assert.strictEqual(reg.result.ok, true);
      assert.deepStrictEqual(reg.result.retiredDuplicates, [LEGACY_ID], 'the store-only legacy row is retired');
      assert.strictEqual(reg.result.forwardedMessages, 1, 'the pre-existing unread is forwarded');
      assert.deepStrictEqual(rowsForMeshB(home, repoKey, childMesh), [CHILD_ID], 'exactly one survivor');

      const post = cli.run(['send', '--to', childMesh, '--message', 'after-cutover'], bctx(home, { cwd: main }));
      assert.strictEqual(post.result.ok, true);
      const read = cli.run(['inbox', 'messages', CHILD_ID], bctx(home, { cwd: child }));
      assert.strictEqual(read.result.ok, true);
      const bodies = read.result.messages.map((m) => m.body);
      assert.ok(bodies.includes('pre-existing-1'), 'forwarded backlog reaches the drained partition (no loss)');
      assert.ok(bodies.includes('after-cutover'), 'post-cutover send reaches the drained partition');
      assert.deepStrictEqual(bodiesB(home, repoKey, LEGACY_ID), ['pre-existing-1'], 'retired partition message rows preserved (never deleted)');
    } finally {
      cp.spawnSync('git', ['-C', main, 'worktree', 'remove', '--force', child]);
      rm(main); rm(child); rm(home);
    }
  });

  // P1 — a DISTINCT live child with its OWN on-disk descriptor sharing a worktree is
  // NEVER tombstoned by another child's self-register. Its backlog is forwarded
  // (harmless), the row is LEFT (logged), and P0 routing still delivers to whichever
  // row is actually drained. Losing a message by mis-retiring is far worse than
  // leaving a duplicate row.
  test(`[${B.name}] P1: a distinct live child (own descriptor) sharing a worktree is forwarded + LEFT, never tombstoned`, () => {
    const home = tmpHome();
    const main = makeGitRepo('p1gate-' + B.name);
    const child = addLinkedWorktree(main, 'c');
    try {
      const repoKey = repokey.repoKeyForWorktree(child);
      const childTop = topOf(child);
      const childMesh = meshOf(child);
      const A = 'child-a-live-uuid';
      const Bid = 'child-b-live-uuid';
      const rA = cli.run(['register', A, '--worktree', childTop, '--session', 'sess-a'], bctx(home, { cwd: child }));
      assert.strictEqual(rA.result.ok, true);
      assert.ok(fs.existsSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces', A + '.json')), 'child A has an on-disk descriptor');
      cli.run(['send', '--to', childMesh, '--message', 'for-whoever-drains'], bctx(home, { cwd: main }));

      const rB = cli.run(['register', Bid, '--worktree', childTop, '--session', 'sess-b'], bctx(home, { cwd: child }));
      assert.strictEqual(rB.result.ok, true);
      assert.ok(!(rB.result.retiredDuplicates || []).includes(A), 'child A is NOT tombstoned');
      assert.ok((rB.result.leftDuplicates || []).includes(A), 'child A is LEFT (logged in leftDuplicates)');
      const rows = rowsForMeshB(home, repoKey, childMesh);
      assert.ok(rows.includes(A) && rows.includes(Bid), 'BOTH distinct live child rows survive');
      assert.ok(bodiesB(home, repoKey, Bid).includes('for-whoever-drains'), "child A's backlog was forwarded into the survivor (no loss)");
    } finally {
      cp.spawnSync('git', ['-C', main, 'worktree', 'remove', '--force', child]);
      rm(main); rm(child); rm(home);
    }
  });

  // #67 retire-forward NOISE FILTER — the survivor must not inherit stale native
  // poke/hash-mirror rows. Native ingest (devswarm-ingest.js/devswarm-pull.js)
  // writes body+hash ONLY, so a `[Primary poke]` mirror, a `{_h:"native:..."}`
  // hash-mirror, and a bare null-mtype/null-sender row all read back as
  // mtype:null — forwarding those resurrects DEAD pokes into the live partition.
  // Only a REAL mesh direct (mtype='direct', non-empty sender+recipient) is
  // forwarded; the three noise rows are skipped. Fail-first: pre-fix the filter
  // only skipped broadcast/heartbeat, so all three noise rows were forwarded.
  test(`[${B.name}] #67: retire-forward skips native poke/hash-mirror/null rows, forwards only a real direct`, () => {
    const home = tmpHome();
    const main = makeGitRepo('n67-' + B.name);
    const child = addLinkedWorktree(main, 'c');
    try {
      const repoKey = repokey.repoKeyForWorktree(child);
      const childTop = topOf(child);
      const childMesh = meshOf(child);
      // Legacy store-only duplicate row for the child's worktree (will be retired).
      seedB(home, repoKey, { id: LEGACY_ID, worktreePath: childTop, sessionId: 'legacy-sess' });
      // Seed the LEGACY partition: 3 native-style noise rows (body+hash only ->
      // mtype/sender null) + 1 real mesh direct (mtype='direct', sender+recipient).
      {
        const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
        try {
          s.appendMessage({ workspaceId: LEGACY_ID, body: '[Primary poke] wake up', hash: 'native:poke1', ts: Date.now() });
          s.appendMessage({ workspaceId: LEGACY_ID, body: '{"_h":"native:abc123"}', hash: 'native:mirror1', ts: Date.now() });
          s.appendMessage({ workspaceId: LEGACY_ID, body: 'bare native body', hash: 'native:bare1', ts: Date.now() });
          const fields = { from: 'peer-sender', to: LEGACY_ID, type: 'direct', message: 'REAL-actionable-direct', timestamp: Date.now(), urgency: 'normal' };
          storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: storeLib.meshMessageHash(fields) }));
        } finally { s.close(); }
      }
      // Child self-registers under its builder-id -> retire + forward.
      const reg = cli.run(['register', CHILD_ID, '--worktree', childTop, '--session', 'child-sess'], bctx(home, { cwd: child }));
      assert.strictEqual(reg.result.ok, true);
      assert.deepStrictEqual(reg.result.retiredDuplicates, [LEGACY_ID], 'legacy row retired');
      assert.strictEqual(reg.result.forwardedMessages, 1, 'only the real direct is forwarded (3 noise rows skipped)');
      const survivor = bodiesB(home, repoKey, CHILD_ID);
      assert.ok(survivor.includes('REAL-actionable-direct'), 'the real direct IS forwarded into the survivor');
      assert.ok(!survivor.includes('[Primary poke] wake up'), 'the [Primary poke] mirror is NOT forwarded');
      assert.ok(!survivor.some((b) => b.indexOf('native:abc123') !== -1), 'the {_h:"native:..."} hash-mirror row is NOT forwarded');
      assert.ok(!survivor.includes('bare native body'), 'the null-mtype/null-sender native row is NOT forwarded');
      // NON-DESTRUCTIVE: the legacy partition still holds all 4 original rows.
      assert.strictEqual(bodiesB(home, repoKey, LEGACY_ID).length, 4, 'retired partition message rows preserved (never deleted)');
    } finally {
      cp.spawnSync('git', ['-C', main, 'worktree', 'remove', '--force', child]);
      rm(main); rm(child); rm(home);
    }
  });
}

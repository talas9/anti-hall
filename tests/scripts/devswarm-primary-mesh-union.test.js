'use strict';
// P0 fix: ASYMMETRIC PARTITION RESOLUTION between send and read.
//
// ROOT CAUSE (confirmed against the actual code):
//   - `send --to-primary` (cmdSend, scripts/devswarm.js:5107) resolves the
//     recipient DYNAMICALLY: resolveMeshTarget(s, primaryMeshId, home) groups
//     every registry row sharing this worktree's canonicalMeshId
//     (meshCandidateRows) and picks the freshest-LIVE one
//     (livenessSelect.pickFreshestLive).
//   - `read-primary`/`peek-primary` (cmdInboxMessages, ~line 3317) resolved
//     the recipient's OWN inbox STATICALLY, to the ONE `id` the parent-gate
//     hook computed (installIngest.primaryWorkspaceId — a sha256-of-worktree-
//     path hash) — a single store partition, never consulting the mesh group.
//   => two real registry rows for the SAME worktree (e.g. a DevSwarm-native
//      builder-id UUID row a child self-registers under, and anti-hall's
//      minted primary-<hash> row) can each hold real mail, while the
//      Primary's own `read-primary`/`peek-primary` structurally sees only ONE
//      of them.
//
// FIX (scripts/devswarm.js, cmdInboxMessages): when `id` resolves (via the
// SAME canonicalMeshId/meshCandidateRows primitives `send`/`diagnose` already
// use — no parallel grouping) to a group of 2+ registry rows, fold every
// sibling partition's own unread slice into `messages`/`unreadCount`/`total`,
// deduped on STABLE CONTENT IDENTITY (sender, ts, body) — NOT `hash`, because
// meshMessageHash hashes the RECIPIENT (`to`) too, so the same logical
// message addressed to two different partitions hashes differently. Acking
// advances each contributing partition's OWN cursor file, and only those.
// READ-SIDE ONLY: no registry row is folded/retired/adopted/tombstoned/
// rehomed/mutated by this fix.
//
// Exercised via cli.run(argv, ctx) against a REAL git repo (so repoKeyForCwd
// resolves the SAME repoKey for both registry rows, landing them in the SAME
// per-project store — the D24 mesh path, not the non-git per-id legacy
// fallback) with TWO registry rows sharing ONE worktree.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-primary-mesh-union-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-primary-mesh-union-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

// register(home, repoDir, id, over) -> registers `id` under repoDir's OWN
// worktree (ctx.cwd = repoDir too, so repoKeyForCwd resolves the store this
// row actually lands in — the D24 mesh re-key path).
function register(home, repoDir, id, over, sessionId) {
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const r = cli.run(
    ['register', id, '--worktree', repoDir, '--session', sessionId || ('s-' + id), '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, Object.assign({ cwd: repoDir }, over || {}))
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
  return { inboxPath, cursorPath };
}

// seedPartition(home, repoDir, toId, rows) -> directly appends mesh rows into
// `toId`'s OWN partition, bypassing send's resolveMeshTarget selection (which
// would non-deterministically pick ONE of the two rows) — mirrors exactly what
// `send --to-primary` durably writes (store.appendMeshMessage) once it has
// resolved a target partition.
function seedPartition(home, repoDir, toId, rows) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  assert.ok(repoKey, 'repoKey must resolve for a real git repo');
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    for (const row of rows) {
      const fields = { from: row.from || 'sender', to: toId, type: 'direct', urgency: 'normal', message: row.body, timestamp: row.ts };
      const hash = storeLib.meshMessageHash(fields);
      storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash }));
    }
  } finally { s.close(); }
  return repoKey;
}

// ---- 1: read-primary sees mail delivered to EITHER partition (the exact defect) --

test('read-primary sees mail delivered to a SIBLING registry row sharing the same worktree, not just the statically-resolved id', () => {
  const home = tmpHome();
  const repo = makeGitRepo('regression');
  try {
    // Two registry rows, ONE worktree — the exact live shape: a DevSwarm-
    // native builder-id UUID row + anti-hall's minted primary-<hash> row.
    register(home, repo, 'primary-hash-row');
    register(home, repo, 'uuid-child-row');

    // `send --to-primary` resolved to the UUID row this time — its mail is
    // real, durable, and structurally invisible to a `read-primary` that only
    // ever opens `primary-hash-row`'s own partition, pre-fix.
    seedPartition(home, repo, 'uuid-child-row', [{ body: 'sent while resolved to the uuid row', ts: 1000, from: 'childA' }]);

    const rp = cli.run(['inbox', 'read-primary', 'primary-hash-row', '--ack-as-owner'],
      ctx(home, { cwd: repo }));
    assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
    assert.equal(rp.result.count, 1, 'read-primary must see the sibling partition\'s mail');
    assert.equal(rp.result.messages[0].body, 'sent while resolved to the uuid row');
    assert.equal(rp.result.messages[0].partitionId, 'uuid-child-row', 'the sibling row is tagged with its OWN originating partition');
  } finally { rm(home); rm(repo); }
});

// ---- 2: acking advances only the originating partition's cursor ------------

test('ack advances each contributing partition\'s OWN cursor, and only that partition\'s', () => {
  const home = tmpHome();
  const repo = makeGitRepo('cursors');
  try {
    register(home, repo, 'primary-a');
    register(home, repo, 'sibling-b', undefined, 'unclaimed:sibling-b');

    seedPartition(home, repo, 'primary-a', [{ body: 'from a', ts: 1000 }, { body: 'from a 2', ts: 1100 }]);
    seedPartition(home, repo, 'sibling-b', [{ body: 'from b', ts: 1200 }]);

    const rp = cli.run(['inbox', 'read-primary', 'primary-a', '--ack-as-owner'],
      ctx(home, { cwd: repo }));
    assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
    assert.equal(rp.result.count, 3, 'both partitions\' mail delivered in one read-primary call');

    const aCursor = Number(fs.readFileSync(cli.primaryCursorPath(home, 'primary-a'), 'utf8').trim());
    const bCursor = Number(fs.readFileSync(cli.primaryCursorPath(home, 'sibling-b'), 'utf8').trim());
    assert.equal(aCursor, 2, 'primary-a\'s own cursor advances to ITS OWN total (2)');
    assert.equal(bCursor, 1, 'sibling-b\'s own cursor advances to ITS OWN total (1) — a DIFFERENT value, its own');

    // A second read-primary sees nothing new — both partitions fully acked.
    const rp2 = cli.run(['inbox', 'read-primary', 'primary-a', '--ack-as-owner'],
      ctx(home, { cwd: repo }));
    assert.equal(rp2.result.count, 0);
  } finally { rm(home); rm(repo); }
});

test('ack never touches a partition outside the mesh group (a DIFFERENT worktree\'s row is untouched)', () => {
  const home = tmpHome();
  const repoX = makeGitRepo('groupX');
  const repoY = makeGitRepo('groupY');
  try {
    register(home, repoX, 'primary-x');
    register(home, repoY, 'primary-y'); // a DIFFERENT worktree — NOT in primary-x's mesh group
    seedPartition(home, repoY, 'primary-y', [{ body: 'unrelated mail', ts: 500 }]);

    cli.run(['inbox', 'read-primary', 'primary-x', '--ack-as-owner'], ctx(home, { cwd: repoX }));

    assert.equal(fs.existsSync(cli.primaryCursorPath(home, 'primary-y')), false,
      'primary-y\'s cursor file must never be created/touched by acking a different worktree\'s read-primary');
  } finally { rm(home); rm(repoX); rm(repoY); }
});

// ---- 3: two SEPARATE sends sharing (sender, ts, body) are BOTH delivered --
//
// UPDATED (adversarial review, P0 fix): this test used to assert the OPPOSITE
// — that a "duplicate" collapsed to ONE delivery — using a WEAK (sender, ts,
// body) content key to decide "same logical message". That encoded the bug:
// these are two GENUINELY DISTINCT sends (different `to`, different `hash`,
// proven below) that merely happen to share sender+ts+body. Nothing in the
// schema can prove they are the same logical message (hash — the only real
// identity here — differs precisely BECAUSE the recipient differs), so per
// the governing principle (never lose a message; at-least-once beats
// at-most-once) BOTH must be delivered. See
// tests/scripts/devswarm-mesh-union-review-fixes.test.js for the full P0/P1
// regression coverage this review produced.

test('two SEPARATE sends sharing (sender, ts, body) across partitions (different hash — `to` is hashed) are BOTH delivered, never collapsed', () => {
  const home = tmpHome();
  const repo = makeGitRepo('dedup');
  try {
    register(home, repo, 'primary-dd');
    register(home, repo, 'sibling-dd');

    // Same sender/ts/body, addressed to TWO different partitions — verified
    // against meshMessageHash (companion/lib/devswarm-store.js:285), `to` is
    // part of the hash, so these two rows get DIFFERENT hashes: there is no
    // provable identity linking them as "the same message".
    const shared = { body: 'duplicate content', ts: 2000, from: 'dupSender' };
    const h1 = storeLib.meshMessageHash({ from: shared.from, to: 'primary-dd', type: 'direct', urgency: 'normal', message: shared.body, timestamp: shared.ts });
    const h2 = storeLib.meshMessageHash({ from: shared.from, to: 'sibling-dd', type: 'direct', urgency: 'normal', message: shared.body, timestamp: shared.ts });
    assert.notEqual(h1, h2, 'sanity: hash differs by recipient even for identical (sender, ts, body) — no cross-partition identity exists');

    seedPartition(home, repo, 'primary-dd', [shared]);
    seedPartition(home, repo, 'sibling-dd', [shared, { body: 'unique to sibling', ts: 2100, from: 'dupSender' }]);

    const rp = cli.run(['inbox', 'read-primary', 'primary-dd', '--ack-as-owner'],
      ctx(home, { cwd: repo }));
    assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
    assert.equal(rp.result.count, 3, 'all three rows delivered — the two "duplicate content" sends are DISTINCT messages, neither is provably a copy of the other');
    const bodies = rp.result.messages.map((m) => m.body).sort();
    assert.deepEqual(bodies, ['duplicate content', 'duplicate content', 'unique to sibling']);
  } finally { rm(home); rm(repo); }
});

// ---- 4: single-row Primary is byte-identical to pre-fix behaviour ---------

test('single-row Primary (the common case): read-primary is unaffected — no partitionId, no cursor for a nonexistent sibling', () => {
  const home = tmpHome();
  const repo = makeGitRepo('single');
  try {
    register(home, repo, 'solo-primary');
    seedPartition(home, repo, 'solo-primary', [{ body: 'solo message', ts: 1000 }]);

    const rp = cli.run(['inbox', 'read-primary', 'solo-primary', '--ack-as-owner'],
      ctx(home, { cwd: repo }));
    assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
    assert.equal(rp.result.count, 1);
    assert.equal(rp.result.messages[0].body, 'solo message');
    assert.equal(rp.result.messages[0].partitionId, undefined, 'no mesh widening occurred — no partitionId tag');
  } finally { rm(home); rm(repo); }
});

// ---- 5: fold-facing signals are untouched by this change -------------------

test('diagnose\'s fold-facing signals (liveRows/kind/split/deadSplit) are unaffected by the read-side mesh widening', () => {
  const home = tmpHome();
  const repo = makeGitRepo('foldsignals');
  try {
    register(home, repo, 'fold-a');
    register(home, repo, 'fold-b');
    seedPartition(home, repo, 'fold-a', [{ body: 'x', ts: 1 }]);

    // Capture diagnose BEFORE any read-primary call (the fold detector's own,
    // pre-existing view)...
    const before = cli.run(['diagnose'], ctx(home, { cwd: repo }));
    assert.equal(before.result.ok, true, JSON.stringify(before.result));

    // ...exercise the mesh-widened read path...
    cli.run(['inbox', 'peek-primary', 'fold-a'], ctx(home, { cwd: repo }));
    cli.run(['inbox', 'read-primary', 'fold-a', '--ack-as-owner'], ctx(home, { cwd: repo }));

    // ...and diagnose's fold-facing signals must be BYTE-IDENTICAL after.
    const after = cli.run(['diagnose'], ctx(home, { cwd: repo }));
    assert.equal(after.result.ok, true, JSON.stringify(after.result));
    assert.deepEqual(after.result.meshTargets, before.result.meshTargets, 'meshTargets (liveRows/kind/split/deadSplit per group) must be byte-identical');
    assert.deepEqual(after.result.splits, before.result.splits);
    assert.deepEqual(after.result.deadSplits, before.result.deadSplits);
    assert.deepEqual(after.result.mixedSplits, before.result.mixedSplits);
  } finally { rm(home); rm(repo); }
});

// ---- 6: group-resolution failure falls back to single-partition read -------

test('group resolution failure (corrupt registry row) falls back to single-partition read without throwing', () => {
  const home = tmpHome();
  const repo = makeGitRepo('failopen');
  try {
    register(home, repo, 'failopen-primary');
    seedPartition(home, repo, 'failopen-primary', [{ body: 'still readable', ts: 1000 }]);

    const repoKey = repokey.repoKeyForWorktree(repo);
    // Corrupt the registry: inject a sibling row with a non-string/garbage
    // worktreePath so canonicalMeshId's resolution for THAT row throws/returns
    // nonsense, while `id`'s own row stays valid — the mesh grouping attempt
    // around it must not blow up the whole read.
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { s.upsertRegistry({ id: 'garbage-row', worktreePath: { not: 'a string' }, sessionId: null }); }
    finally { s.close(); }

    assert.doesNotThrow(() => {
      const rp = cli.run(['inbox', 'read-primary', 'failopen-primary', '--ack-as-owner'],
        ctx(home, { cwd: repo }));
      assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
      assert.equal(rp.result.count, 1, 'failopen: falls back to reading failopen-primary\'s own partition');
      assert.equal(rp.result.messages[0].body, 'still readable');
    });
  } finally { rm(home); rm(repo); }
});

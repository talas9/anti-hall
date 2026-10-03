'use strict';
// Defect e586afdaa968 (P1): the mesh store PARTITION for an explicitly-named
// workspace id was resolved from the CALLER'S CWD, not from the id's OWN
// registered repoKey.
//
// ROOT CAUSE (confirmed against the actual code, reproduced live below):
//   scripts/devswarm.js resolveWorkspaceStoreForRead()
//     - `callerRepoKeyForRead = repoKeyForCwd(ctx)` is the ONLY key handed to
//       store.openStore(), and
//     - the cross-project refusal guard consulted ONLY
//       `descriptorFreshRepoKey(desc)` — which RE-DERIVES the key from the
//       descriptor's worktreePath and returns null the moment that path stops
//       resolving (worktree removed / repo moved / git unavailable) — even
//       though the descriptor PERSISTS its registered `repoKey` field, and
//     - `maybeRehomeToCwdProject(home, id, ctx)` ran BEFORE that guard, so a
//       plain read from a foreign cwd could physically COPY another project's
//       messages + registry row into the caller's partition and rewrite the
//       descriptor's ownerKey to the caller's project.
//   => from a foreign cwd: `inbox count <id>` silently reported zeros that
//      read like "no mail" (consequence 1), and `inbox read-primary <id>`
//      succeeded against the CALLER'S partition and wrote cursor state there
//      (consequence 2 — a cursor in a partition that is not the workspace's).
//
// FIX: the id's REGISTERED repoKey (fresh-from-worktree, else the persisted
// `repoKey`/`ownerKey` field) is the authority whenever an explicit id is
// given; the mismatch refusal is evaluated FIRST (before any re-home / store
// open / cursor write), and `inbox count`/`read` report the store side as
// UNKNOWN (`known:false` + `storeUnavailable`) instead of 0.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-xrepo-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-xrepo-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function registerIn(home, cwd, worktree, id) {
  const inboxPath = path.join(home, 'di', id + '.ndjson');
  const cursorPath = path.join(home, 'dc', id + '.cursor');
  const r = cli.run(
    ['register', id, '--worktree', worktree, '--session', 's-' + id, '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, { cwd })
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
  return { inboxPath, cursorPath, descriptor: r.result.descriptor };
}

// storePartitionDir(home, repoKey) — the on-disk partition directory for one
// project key. Used to prove NOTHING (no cursor row, no message, no registry
// row) was written into the CALLER'S partition for a foreign workspace.
function storePartitionDir(home, repoKey) {
  return path.join(home, '.anti-hall', 'devswarm', 'store', repoKey);
}
function partitionFileText(home, repoKey, name) {
  try { return fs.readFileSync(path.join(storePartitionDir(home, repoKey), 'journal', name), 'utf8'); }
  catch (_) { return ''; }
}

test('e586afdaa968: `inbox count` from a FOREIGN cwd reports the store side as UNKNOWN, never a silent 0', () => {
  // RED (pre-fix, recorded from this exact repro):
  //   {"ok":true,...,"unreadStore":0,"cursorStore":0,"total":0,"known":true,...}
  //   i.e. indistinguishable from "no mail" for a workspace whose real
  //   partition held 1 genuinely unread message.
  const home = tmpHome();
  const repoA = makeGitRepo('A'); // caller's cwd
  const repoB = makeGitRepo('B'); // where the workspace is registered
  try {
    registerIn(home, repoB, repoB, 'child-foreign');
    const rSend = cli.run(['send', '--to', 'child-foreign', '--message', 'real unread message'], ctx(home, { cwd: repoB }));
    assert.equal(rSend.result.ok, true, JSON.stringify(rSend.result));

    // sanity: from its OWN project the message is plainly visible.
    const own = cli.run(['inbox', 'count', 'child-foreign'], ctx(home, { cwd: repoB })).result;
    assert.equal(own.unreadStore, 1, 'precondition: the real partition holds 1 unread');

    const foreign = cli.run(['inbox', 'count', 'child-foreign'], ctx(home, { cwd: repoA })).result;
    assert.equal(foreign.ok, true, 'count must stay fail-open, never a new hard failure');
    assert.equal(foreign.known, false, 'the store side is NOT readable from here — say so, do not report 0 as fact');
    // fl-wave5 addendum fix (item 7): a project-context-mismatch is NOT a
    // genuine store error (the store was never even attempted) — the
    // BOOLEAN `storeUnavailable` stays false for this reason (true is
    // reserved for a real EACCES/ENOTDIR/ESTOREUNAVAILABLE/corrupt-store
    // condition); the full refusal detail (reason/registeredRepoKey/
    // callerRepoKey) still lands under `storeUnavailableDetail`, never lost.
    assert.equal(foreign.storeUnavailable, false, 'project-context-mismatch is not a genuine store error');
    assert.ok(foreign.storeUnavailableDetail, 'must still carry WHY the store side is unknown, under storeUnavailableDetail');
    assert.equal(foreign.storeUnavailableDetail.reason, 'project-context-mismatch');
    assert.equal(
      foreign.storeUnavailableDetail.registeredRepoKey,
      require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js').repoKeyForWorktree(repoB),
      'must name the workspace\'s OWN registered project key');
    assert.equal(foreign.unreadStoreUnknown, true);
  } finally { rm(home); rm(repoA); rm(repoB); }
});

test('e586afdaa968: the REGISTERED repoKey stays the authority when the workspace\'s worktree no longer resolves — no cursor is written into the caller\'s partition', () => {
  // RED (pre-fix, recorded): with repoB deleted, descriptorFreshRepoKey went
  // null, the guard silently disengaged, and
  //   `inbox read-primary child-foreign --ack-as-owner` from repoA returned
  //   {"ok":true,"action":"read-primary",...,"acked":0}
  // after opening repoA's partition and writing
  //   store/<repoA-key>/journal/cursors.ndjson
  //   {"workspaceId":"child-foreign","value":0,...}
  // — a cursor row in a partition that is not the workspace's.
  const home = tmpHome();
  const repoA = makeGitRepo('A');
  const repoB = makeGitRepo('B');
  const repoKeyA = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js').repoKeyForWorktree(repoA);
  try {
    const reg = registerIn(home, repoB, repoB, 'child-vanished');
    assert.ok(reg.descriptor.repoKey, 'precondition: register persists the workspace\'s repoKey');
    cli.run(['send', '--to', 'child-vanished', '--message', 'unread'], ctx(home, { cwd: repoB }));

    rm(repoB); // the workspace's worktree is gone — fresh key resolution now fails

    const r = cli.run(['inbox', 'read-primary', 'child-vanished', '--ack-as-owner'], ctx(home, { cwd: repoA })).result;
    assert.equal(r.ok, false, 'must refuse rather than silently read the WRONG partition');
    assert.equal(r.reason, 'project-context-mismatch');

    // and NOTHING was written into the caller's own partition for that id.
    assert.doesNotMatch(partitionFileText(home, repoKeyA, 'cursors.ndjson'), /child-vanished/,
      'a cursor must NEVER be advanced in a partition not resolved from the workspace\'s registered repoKey');
    assert.doesNotMatch(partitionFileText(home, repoKeyA, 'registry.ndjson'), /child-vanished/);
    assert.doesNotMatch(partitionFileText(home, repoKeyA, 'messages.ndjson'), /child-vanished/);
  } finally { rm(home); rm(repoA); rm(repoB); }
});

test('e586afdaa968: a read from a foreign cwd must not RE-HOME another project\'s workspace into the caller\'s store', () => {
  // RED (pre-fix, recorded): maybeRehomeToCwdProject ran BEFORE the mismatch
  // guard, so `inbox count <id>` from repoA copied the workspace's message +
  // registry row into store/<repoA-key>/ and rewrote the descriptor's
  // ownerKey to repoA's project key.
  const home = tmpHome();
  const repoA = makeGitRepo('A');
  const repoB = makeGitRepo('B');
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-xrepo-nongit-'));
  const repoKeyA = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js').repoKeyForWorktree(repoA);
  try {
    // register from a NON-git cwd (-> stranded in the legacy per-id hash
    // bucket: ownerKey === hashFromWorkspaceId(id)) while the worktree itself
    // genuinely lives in repoB.
    registerIn(home, nonGit, repoB, 'stranded-foreign');
    const hashKey = storeLib.hashFromWorkspaceId('stranded-foreign');
    const s = storeLib.openStore({ home, hash: hashKey, backend: 'journal' });
    try { s.appendMessage({ workspaceId: 'stranded-foreign', body: 'legacy stranded message', hash: 'mesh:legacy1' }); }
    finally { s.close(); }

    cli.run(['inbox', 'count', 'stranded-foreign'], ctx(home, { cwd: repoA }));

    const descNow = JSON.parse(fs.readFileSync(
      path.join(home, '.anti-hall', 'devswarm', 'workspaces', 'stranded-foreign.json'), 'utf8'));
    assert.equal(descNow.ownerKey, hashKey, 'a foreign read must not take ownership of another project\'s workspace');
    assert.doesNotMatch(partitionFileText(home, repoKeyA, 'messages.ndjson'), /stranded-foreign/,
      'another project\'s messages must never be copied into the caller\'s partition');
    assert.doesNotMatch(partitionFileText(home, repoKeyA, 'registry.ndjson'), /stranded-foreign/);
    // the real (legacy) partition is untouched and still holds the message.
    assert.match(partitionFileText(home, hashKey, 'messages.ndjson'), /legacy stranded message/);
  } finally { rm(home); rm(repoA); rm(repoB); rm(nonGit); }
});

test('e586afdaa968 (no regression): a read from the workspace\'s OWN project still works, and the legacy no-project mode is unchanged', () => {
  const home = tmpHome();
  const repoB = makeGitRepo('B');
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-xrepo-ok-'));
  try {
    registerIn(home, repoB, repoB, 'child-ok');
    cli.run(['send', '--to', 'child-ok', '--message', 'hello'], ctx(home, { cwd: repoB }));
    const c = cli.run(['inbox', 'count', 'child-ok'], ctx(home, { cwd: repoB })).result;
    assert.equal(c.known, true);
    assert.equal(c.storeUnavailable, false, 'no storeUnavailable when the store IS readable');
    assert.equal(c.unreadStore, 1);

    // legacy no-project mode (non-git cwd, non-git worktree) keeps working.
    registerIn(home, nonGit, nonGit, 'legacy-ok');
    const l = cli.run(['inbox', 'count', 'legacy-ok'], ctx(home, { cwd: nonGit })).result;
    assert.equal(l.ok, true);
    assert.equal(l.known, true);
    assert.equal(l.storeUnavailable, false);
  } finally { rm(home); rm(repoB); rm(nonGit); }
});

// ---------------------------------------------------------------------------
// PRECEDENCE (vacuity fix). The four cases above all delete repoB before
// asserting, so `descriptorFreshRepoKey` is null in every one of them and
// REVERSING the fresh-vs-persisted precedence inside registeredRepoKey left all
// four green (verified with that exact mutant). This case is the discriminator:
// the worktree is ALIVE in repoB while the PERSISTED key lies and claims repoA.
// Fresh (the live filesystem fact) must win, so a repoA caller is refused.
// ---------------------------------------------------------------------------
test('e586afdaa968 PRECEDENCE: a RESOLVABLE worktree beats a persisted repoKey that claims the caller\'s project', () => {
  const home = tmpHome();
  const repoA = makeGitRepo('A');
  const repoB = makeGitRepo('B');
  const keyA = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js').repoKeyForWorktree(repoA);
  const keyB = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js').repoKeyForWorktree(repoB);
  try {
    registerIn(home, repoB, repoB, 'liar');
    const dp = path.join(home, '.anti-hall', 'devswarm', 'workspaces', 'liar.json');
    const desc = JSON.parse(fs.readFileSync(dp, 'utf8'));
    desc.repoKey = keyA; // persisted key LIES that it belongs to the caller's project
    desc.ownerKey = keyA;
    fs.writeFileSync(dp, JSON.stringify(desc));

    const r = cli.run(['inbox', 'read-primary', 'liar', '--ack-as-owner'], ctx(home, { cwd: repoA })).result;
    assert.equal(r.ok, false, 'the LIVE worktree-derived key is ground truth; a persisted key must never override it');
    assert.equal(r.reason, 'project-context-mismatch');
    assert.equal(r.registeredRepoKey, keyB, 'must resolve the id to its real, live project');
  } finally { rm(home); rm(repoA); rm(repoB); }
});

// The legacy per-id HASH bucket is NOT a project key. Asserted directly on the
// shared helper so the rule is pinned independently of any one CLI verb: a
// descriptor stranded in its own hash bucket must read as "names no project"
// (null), which is what keeps the sanctioned re-home heal alive and keeps every
// caller fail-open for the legacy no-project mode.
test('e586afdaa968: the legacy per-id hash bucket is never reported as a registered PROJECT', () => {
  const repokeyLib = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
  const hashKey = storeLib.hashFromWorkspaceId('legacy-id');
  assert.equal(repokeyLib.registeredRepoKey({ ownerKey: hashKey }, 'legacy-id'), null);
  assert.equal(repokeyLib.registeredRepoKey({ repoKey: hashKey }, 'legacy-id'), null);
  // ...while a REAL project key in either field is reported, ownerKey included
  // (the `rehomeCore` descriptor shape: ownerKey set, repoKey absent).
  assert.equal(repokeyLib.registeredRepoKey({ ownerKey: 'proj-abc123' }, 'legacy-id'), 'proj-abc123');
  assert.equal(repokeyLib.registeredRepoKey({ repoKey: 'proj-def456' }, 'legacy-id'), 'proj-def456');
  assert.equal(repokeyLib.registeredRepoKey(null, 'legacy-id'), null);
});

// ---------------------------------------------------------------------------
// P0: the MUTATING verbs. `maybeRehomeToCwdProject` / `rehomeCore` re-home to
// the CALLER'S cwd key, and `gate`, `ensure` and `archive` each ran it BEFORE
// their own ownership check — so a refused call had already physically moved
// another project's data. The precondition in every case is a workspace
// stranded in the legacy hash bucket (registered from a non-git cwd) whose
// worktree genuinely lives in repoB: "stranded" says WHERE the rows live, it
// says nothing about WHICH project owns them.
// ---------------------------------------------------------------------------
function strandedInB(home, nonGit, repoB, id) {
  registerIn(home, nonGit, repoB, id);
  const hashKey = storeLib.hashFromWorkspaceId(id);
  const s = storeLib.openStore({ home, hash: hashKey, backend: 'journal' });
  try { s.appendMessage({ workspaceId: id, body: 'B-owned message', hash: 'mesh:' + id }); }
  finally { s.close(); }
  return hashKey;
}
function descOf(home, id) {
  return JSON.parse(fs.readFileSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces', id + '.json'), 'utf8'));
}

test('e586afdaa968 P0: `gate` on a FOREIGN workspace refuses WITHOUT re-homing it first', () => {
  // RED (pre-fix, recorded from this exact repro): the call returned
  //   {"ok":false,...,"reason":"project-context-mismatch"}
  // and yet the descriptor's ownerKey had ALREADY been rewritten to repoA's key
  // and repoA's registry.ndjson had gained the foreign id.
  const home = tmpHome();
  const repoA = makeGitRepo('A');
  const repoB = makeGitRepo('B');
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-xrepo-ng-gate-'));
  const keyA = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js').repoKeyForWorktree(repoA);
  try {
    const hashKey = strandedInB(home, nonGit, repoB, 'gate-foreign');
    const r = cli.run(['gate', 'gate-foreign', '--set', 'merged'], ctx(home, { cwd: repoA })).result;
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'project-context-mismatch');
    assert.equal(descOf(home, 'gate-foreign').ownerKey, hashKey,
      'a REFUSED command must not have already taken ownership of another project\'s workspace');
    assert.doesNotMatch(partitionFileText(home, keyA, 'registry.ndjson'), /gate-foreign/);
    assert.doesNotMatch(partitionFileText(home, keyA, 'messages.ndjson'), /gate-foreign/);
    assert.doesNotMatch(partitionFileText(home, keyA, 'gates.ndjson'), /gate-foreign/);
    // the real (legacy) partition still holds its own message.
    assert.match(partitionFileText(home, hashKey, 'messages.ndjson'), /B-owned message/);
  } finally { rm(home); rm(repoA); rm(repoB); rm(nonGit); }
});

test('e586afdaa968 P0: `ensure` cannot STEAL a foreign workspace', () => {
  // RED (pre-fix): returned ok:true, moved repoB's message into repoA, and
  // rewrote ownerKey to repoA — the ownership check below the re-home was
  // validating a fact the re-home had just manufactured.
  const home = tmpHome();
  const repoA = makeGitRepo('A');
  const repoB = makeGitRepo('B');
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-xrepo-ng-ens-'));
  const keyA = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js').repoKeyForWorktree(repoA);
  try {
    const hashKey = strandedInB(home, nonGit, repoB, 'ensure-foreign');
    const r = cli.run(['ensure', 'ensure-foreign', '--worktree', repoB, '--session', 's2'], ctx(home, { cwd: repoA })).result;
    assert.equal(r.ok, false, 'ensure must refuse a workspace registered under another project');
    assert.equal(r.reason, 'project-context-mismatch');
    assert.equal(descOf(home, 'ensure-foreign').ownerKey, hashKey);
    assert.doesNotMatch(partitionFileText(home, keyA, 'messages.ndjson'), /ensure-foreign/);
    assert.doesNotMatch(partitionFileText(home, keyA, 'registry.ndjson'), /ensure-foreign/);
    assert.match(partitionFileText(home, hashKey, 'messages.ndjson'), /B-owned message/);
  } finally { rm(home); rm(repoA); rm(repoB); rm(nonGit); }
});

test('e586afdaa968 P0: `archive` cannot re-home AND retire a foreign workspace', () => {
  // RED (pre-fix): copied repoB's message into repoA and REMOVED the live
  // descriptor — the destructive variant of the same inversion.
  const home = tmpHome();
  const repoA = makeGitRepo('A');
  const repoB = makeGitRepo('B');
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-xrepo-ng-arc-'));
  const keyA = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js').repoKeyForWorktree(repoA);
  const descPath = path.join(home, '.anti-hall', 'devswarm', 'workspaces', 'archive-foreign.json');
  try {
    const hashKey = strandedInB(home, nonGit, repoB, 'archive-foreign');
    const r = cli.run(['archive', 'archive-foreign'], ctx(home, { cwd: repoA })).result;
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'project-context-mismatch');
    assert.equal(r.descriptorArchived, false);
    assert.ok(fs.existsSync(descPath), 'the LIVE descriptor of another project must never be removed');
    assert.equal(descOf(home, 'archive-foreign').ownerKey, hashKey);
    assert.doesNotMatch(partitionFileText(home, keyA, 'messages.ndjson'), /archive-foreign/);
    assert.match(partitionFileText(home, hashKey, 'messages.ndjson'), /B-owned message/);
  } finally { rm(home); rm(repoA); rm(repoB); rm(nonGit); }
});

test('e586afdaa968 P0: `inbox ack` on a FOREIGN workspace never advances its NDJSON cursor', () => {
  // RED (pre-fix): `advanceCursor` ran unconditionally, so a caller the store
  // resolver had ALREADY refused still got {"ok":true,...,"cursor":2} and the
  // owning workspace's mail was permanently marked consumed. NDJSON is the one
  // channel a refused caller could still mutate — and it is exactly what
  // devswarm-parent-gate.js counts.
  const home = tmpHome();
  const repoA = makeGitRepo('A');
  const repoB = makeGitRepo('B');
  try {
    const reg = registerIn(home, repoB, repoB, 'ack-foreign');
    fs.writeFileSync(reg.inboxPath, [JSON.stringify({ m: 'one' }), JSON.stringify({ m: 'two' })].join('\n') + '\n');

    const r = cli.run(['inbox', 'ack', 'ack-foreign'], ctx(home, { cwd: repoA })).result;
    assert.equal(r.ok, false, 'ack must refuse from a foreign project');
    assert.equal(r.reason, 'project-context-mismatch');

    // the cursor file must be untouched, and the mail still unread for its owner.
    const own = cli.run(['inbox', 'count', 'ack-foreign'], ctx(home, { cwd: repoB })).result;
    assert.equal(own.unreadNdjson, 2, 'the owning workspace must still see both messages as unread');

    // ...while the READ-ONLY path stays fail-open and drainable from anywhere —
    // this is what devswarm-parent-gate.js's foreign-row remediation relies on.
    const rd = cli.run(['inbox', 'read', 'ack-foreign'], ctx(home, { cwd: repoA })).result;
    assert.equal(rd.ok, true, '`inbox read` must stay fail-open from a foreign cwd');
    assert.equal(rd.lines.length, 2, 'the NDJSON channel is id-derived and partition-independent');
  } finally { rm(home); rm(repoA); rm(repoB); }
});

// A MOVED/RENAMED repo derives a NEW repoKey (the key is git-common-dir-path-
// derived, devswarm-repokey.js header), so a descriptor registered before the
// move resolves to the OLD key and the session is refused its own mail. This
// pins the behavior as an HONEST, named refusal. It is deliberately NOT healed
// automatically: a caller's cwd cannot PROVE it is the moved repo, so any
// cwd-claimable migration would re-open exactly the cross-project theft the
// tests above close. Pre-fix this same case reported `known:true, unreadStore:0`
// — a silent zero for mail that was equally unreachable — so nothing regressed
// in reachability; only the honesty of the answer changed.
test('e586afdaa968: a MOVED repo gets an honest, named refusal — never a silent zero', () => {
  const home = tmpHome();
  const proj = makeGitRepo('proj');
  const repokeyLib = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
  const oldKey = repokeyLib.repoKeyForWorktree(proj);
  const moved = proj + '-v2';
  try {
    registerIn(home, proj, proj, 'child-moved');
    cli.run(['send', '--to', 'child-moved', '--message', 'own mail'], ctx(home, { cwd: proj }));
    fs.renameSync(proj, moved);
    const newKey = repokeyLib.repoKeyForWorktree(moved);
    assert.notEqual(oldKey, newKey, 'precondition: the path-derived key genuinely changed');

    const c = cli.run(['inbox', 'count', 'child-moved'], ctx(home, { cwd: moved })).result;
    assert.equal(c.ok, true, 'count stays fail-open');
    assert.equal(c.known, false, 'must NOT claim 0 unread as fact for a partition it cannot open');
    // fl-wave5 addendum fix (item 7): project-context-mismatch is not a
    // genuine store error — see the sibling test above for the full
    // rationale. `storeUnavailable` stays a boolean false; the refusal
    // detail moves to `storeUnavailableDetail`.
    assert.equal(c.storeUnavailable, false, 'project-context-mismatch is not a genuine store error');
    assert.equal(c.storeUnavailableDetail.reason, 'project-context-mismatch');
    assert.equal(c.storeUnavailableDetail.registeredRepoKey, oldKey, 'must name the partition the mail is actually in');
    assert.equal(c.storeUnavailableDetail.callerRepoKey, newKey);
  } finally { rm(home); rm(proj); rm(moved); }
});

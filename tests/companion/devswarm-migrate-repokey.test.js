'use strict';
// devswarm-migrate — Phase 3 (v0.57 mesh, PLAN-v0.57-mesh.md D13): folding
// today's legacy hash-keyed per-project stores (store/<8-hex>/) into the
// shared repo-name-keyed layout (store/<repoKey>/), NON-DESTRUCTIVELY and
// IDEMPOTENTLY. Every git spawn is injected (io.run) — no real git binary or
// real worktree paths are touched.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const migrate = require('../../plugins/anti-hall/companion/devswarm-migrate.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const { repoKeyForWorktree, sanitizeRepoName } = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-migrate-repokey-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

// identityFs — realpathSync is the identity function so gitCommonDir's
// resolve+realpath logic is testable without touching the real filesystem.
const identityFs = { realpathSync: (p) => p };

// fakeGitRepo(map) -> an injectable `run` that resolves `git -C <cwd> rev-parse
// --git-common-dir` per-worktree from a plain { worktreePath: commonDirRaw }
// map (commonDirRaw === null simulates a git failure -> unresolvable, e.g. a
// deleted worktree).
function fakeGitRepo(map) {
  return function run(spec) {
    const cwd = spec && spec.cwd;
    const raw = Object.prototype.hasOwnProperty.call(map, cwd) ? map[cwd] : undefined;
    if (raw == null) return { ok: false, raw: '' };
    return { ok: true, raw };
  };
}

function expectedRepoKey(commonDir) {
  const base = sanitizeRepoName(path.basename(path.dirname(commonDir)));
  const suffix = crypto.createHash('sha256').update(commonDir).digest('hex').slice(0, 6);
  return `${base}-${suffix}`;
}

// seedLegacyStore(home, hash, workspaces) — writes a legacy 8-hex per-project
// store directly (store/<hash>/), matching the on-disk shape a pre-0.57
// per-project store (or the DEFAULT_HASH multi-workspace bucket) already has:
// a registry entry + messages + cursor + gates per workspace.
function seedLegacyStore(home, hash, workspaces) {
  const s = storeLib.openStore({ home, backend: 'journal', env: {}, hash });
  try {
    for (const w of workspaces) {
      s.upsertRegistry({
        id: w.id, worktreePath: w.worktreePath, sessionId: 's-' + w.id,
        inboxPath: null, cursorPath: null, nudgeCommand: null,
      });
      for (const body of (w.messages || [])) s.appendMessage({ workspaceId: w.id, body });
      if (Number.isFinite(w.cursor)) s.setCursor(w.id, w.cursor);
      for (const [name, value] of Object.entries(w.gates || {})) {
        s.setGate({ workspaceId: w.id, name, value });
      }
    }
    storeLib.deriveSummary(s, { home, workspaceId: workspaces[0].id, env: {} });
  } finally { s.close(); }
  return hash;
}

const LEGACY_HASH_A = 'aaaaaaaa';
const LEGACY_HASH_B = 'bbbbbbbb';

test('Primary + its child (same repo) fold into ONE store/<repoKey>/, all rows preserved, sources intact', () => {
  const home = tmpHome();
  try {
    const commonDir = '/repos/alpha/.git';
    const primaryWt = '/wt/alpha-primary';
    const childWt = '/wt/alpha-child';

    seedLegacyStore(home, LEGACY_HASH_A, [
      { id: 'primary-aaaaaaaa', worktreePath: primaryWt, messages: ['A1', 'A2', 'A3'], cursor: 1 },
    ]);
    seedLegacyStore(home, LEGACY_HASH_B, [
      { id: 'child-zzz', worktreePath: childWt, messages: ['C1'], gates: { done: true } },
    ]);

    const io = { run: fakeGitRepo({ [primaryWt]: commonDir, [childWt]: commonDir }), repokeyFs: identityFs };
    const rep = migrate.migrateHashStoresToRepoName({ home, backend: 'journal', env: {}, io });
    assert.equal(rep.ok, true);
    assert.equal(rep.locked, true);
    assert.equal(rep.verifiedAll, true, 'every migrated (non-skipped) workspace read-back verified');
    assert.equal(rep.workspaces, 2);
    assert.equal(rep.copied, 4, 'A1+A2+A3+C1');

    const repoKey = expectedRepoKey(commonDir);
    // both source workspaces resolved to the SAME repoKey (the intended fold)
    for (const m of rep.migrated) assert.equal(m.repoKey, repoKey);

    const merged = storeLib.openStore({ home, backend: 'journal', hash: repoKey });
    try {
      assert.equal(merged.messageCount('primary-aaaaaaaa'), 3, 'all 3 Primary rows preserved');
      assert.equal(merged.messageCount('child-zzz'), 1, "child's row preserved");
      assert.equal(merged.cursorValue('primary-aaaaaaaa'), 1, 'cursor copied');
      assert.deepEqual(merged.currentGates('child-zzz'), { done: true }, 'gate carried forward — no gate loss');
      const reg = merged.listRegistry().map((d) => d.id).sort();
      assert.deepEqual(reg, ['child-zzz', 'primary-aaaaaaaa'], 'shared registry is populated, not empty');
    } finally { merged.close(); }

    // NON-DESTRUCTIVE: both legacy sources remain byte-for-byte readable/intact.
    const srcA = storeLib.openStore({ home, backend: 'journal', hash: LEGACY_HASH_A });
    try { assert.equal(srcA.messageCount('primary-aaaaaaaa'), 3, 'source A left in place as backup'); } finally { srcA.close(); }
    const srcB = storeLib.openStore({ home, backend: 'journal', hash: LEGACY_HASH_B });
    try { assert.equal(srcB.messageCount('child-zzz'), 1, 'source B left in place as backup'); } finally { srcB.close(); }

    // directUnread/gates equal pre-migration values (no unread storm, no gate loss).
    const postSummary = storeLib.readSummaryForHash(home, repoKey);
    assert.equal(postSummary.workspaces['primary-aaaaaaaa'].directUnread, 2, '3 total - cursor 1, matches pre-migration unread');
    assert.equal(postSummary.workspaces['child-zzz'].directUnread, 1, 'no cursor set pre-migration -> unread 1, unchanged');
    assert.equal(postSummary.workspaces['child-zzz'].gates.done, true);

    // IDEMPOTENT: a re-run copies nothing new and stays verified.
    const rep2 = migrate.migrateHashStoresToRepoName({ home, backend: 'journal', env: {}, io });
    assert.equal(rep2.copied, 0, 're-run is a no-op');
    assert.equal(rep2.verifiedAll, true);
    const merged2 = storeLib.openStore({ home, backend: 'journal', hash: repoKey });
    try {
      assert.equal(merged2.messageCount('primary-aaaaaaaa'), 3, 'no duplicates on re-run');
      assert.equal(merged2.messageCount('child-zzz'), 1, 'no duplicates on re-run');
    } finally { merged2.close(); }

    // Source enumeration ignores repoKey stores: a THIRD run's `sources` count
    // must still equal exactly the 2 legacy dirs, never the repoKey dir it created.
    const rep3 = migrate.migrateHashStoresToRepoName({ home, backend: 'journal', env: {}, io });
    assert.equal(rep3.sources, 2, 'source enumeration is legacy-8-hex only, never the repoKey stores this fn creates');
  } finally { rm(home); }
});

test('a DEFAULT_HASH-shaped bucket holding two DIFFERENT-repo workspaces splits into two repoKeys (no cross-repo bleed)', () => {
  const home = tmpHome();
  try {
    const wtA = '/wt/proj-a';
    const wtB = '/wt/proj-b';
    const commonDirA = '/repos/proj-a/.git';
    const commonDirB = '/repos/proj-b/.git';

    seedLegacyStore(home, storeLib.DEFAULT_HASH, [
      { id: 'ws-a', worktreePath: wtA, messages: ['a1', 'a2'] },
      { id: 'ws-b', worktreePath: wtB, messages: ['b1'] },
    ]);

    const io = { run: fakeGitRepo({ [wtA]: commonDirA, [wtB]: commonDirB }), repokeyFs: identityFs };
    const rep = migrate.migrateHashStoresToRepoName({ home, backend: 'journal', env: {}, io });
    assert.equal(rep.ok, true);
    assert.equal(rep.verifiedAll, true);

    const repoKeyA = expectedRepoKey(commonDirA);
    const repoKeyB = expectedRepoKey(commonDirB);
    assert.notEqual(repoKeyA, repoKeyB);

    const storeA = storeLib.openStore({ home, backend: 'journal', hash: repoKeyA });
    try {
      assert.equal(storeA.messageCount('ws-a'), 2);
      assert.equal(storeA.messageCount('ws-b'), 0, 'no bleed: proj-b workspace never lands in proj-a repoKey store');
    } finally { storeA.close(); }
    const storeB = storeLib.openStore({ home, backend: 'journal', hash: repoKeyB });
    try {
      assert.equal(storeB.messageCount('ws-b'), 1);
      assert.equal(storeB.messageCount('ws-a'), 0, 'no bleed: proj-a workspace never lands in proj-b repoKey store');
    } finally { storeB.close(); }
  } finally { rm(home); }
});

test('an unresolvable worktree_path (deleted worktree) is SKIPPED + logged, never guessed', () => {
  const home = tmpHome();
  try {
    const deletedWt = '/wt/gone';
    seedLegacyStore(home, LEGACY_HASH_A, [
      { id: 'ws-gone', worktreePath: deletedWt, messages: ['x'] },
    ]);
    // fakeGitRepo with an EMPTY map -> every `-C <cwd>` lookup misses -> ok:false
    // (simulates `git -C /wt/gone rev-parse --git-common-dir` failing because the
    // worktree no longer exists).
    const io = { run: fakeGitRepo({}), repokeyFs: identityFs };
    const rep = migrate.migrateHashStoresToRepoName({ home, backend: 'journal', env: {}, io });
    assert.equal(rep.ok, true);
    assert.equal(rep.copied, 0);
    const entry = rep.migrated.find((m) => m.id === 'ws-gone');
    assert.equal(entry.skipped, true);
    assert.equal(entry.reason, 'unresolvable-git-worktree');
    assert.equal(rep.verifiedAll, true, 'a skip is not a verification failure');

    // Source is untouched — never guessed into some fallback store.
    const src = storeLib.openStore({ home, backend: 'journal', hash: LEGACY_HASH_A });
    try { assert.equal(src.messageCount('ws-gone'), 1, 'source left intact'); } finally { src.close(); }
  } finally { rm(home); }
});

test('a workspace with no registry descriptor at all is skipped (no worktree_path to resolve)', () => {
  const home = tmpHome();
  try {
    // Write a message for a workspace_id with NO matching registry entry
    // (simulates a stray/legacy message-only row).
    const s = storeLib.openStore({ home, backend: 'journal', env: {}, hash: LEGACY_HASH_A });
    try { s.appendMessage({ workspaceId: 'orphan-ws', body: 'stray' }); } finally { s.close(); }

    const io = { run: fakeGitRepo({}), repokeyFs: identityFs };
    const rep = migrate.migrateHashStoresToRepoName({ home, backend: 'journal', env: {}, io });
    const entry = rep.migrated.find((m) => m.id === 'orphan-ws');
    assert.equal(entry.skipped, true);
    assert.equal(entry.reason, 'no-registry-worktree-path');
    assert.equal(rep.verifiedAll, true);
  } finally { rm(home); }
});

test('with no legacy hash stores present, migration is a no-op success', () => {
  const home = tmpHome();
  try {
    const rep = migrate.migrateHashStoresToRepoName({ home, backend: 'journal', env: {} });
    assert.equal(rep.ok, true);
    assert.equal(rep.sources, 0);
    assert.equal(rep.workspaces, 0);
    assert.equal(rep.copied, 0);
    assert.equal(rep.verifiedAll, true);
  } finally { rm(home); }
});

test('a second migration racing the SAME lock is refused (single-consumer invariant)', () => {
  const home = tmpHome();
  try {
    const release = migrate.acquireMigrateLock(home, {});
    assert.ok(release, 'first lock acquired');
    try {
      const rep = migrate.migrateHashStoresToRepoName({ home, backend: 'journal', env: {} });
      assert.equal(rep.ok, false);
      assert.equal(rep.locked, false);
    } finally { release(); }
  } finally { rm(home); }
});

test('migrateToStore wires the Phase-3 fold in AFTER the global split, under the SAME lock (no deadlock)', () => {
  const home = tmpHome();
  try {
    // A descriptor-driven per-project store is created fresh by migrateToStore
    // itself (store/<hashFromWorkspaceId('primary-cccccccc')>/); its worktreePath
    // is fake (non-git), so io.run below must resolve it via the injected map,
    // proving migrateHashStoresToRepoNameLocked runs (and sees this SAME run's
    // freshly-created hash dir) inside migrateToStore's single lock acquisition.
    const wsDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    const inbox = path.join(home, 'inbox.ndjson');
    fs.writeFileSync(inbox, 'hello\n');
    fs.writeFileSync(path.join(wsDir, 'primary-cccccccc.json'), JSON.stringify({
      id: 'primary-cccccccc', worktreePath: '/wt/gamma', sessionId: 's', inboxPath: inbox, cursorPath: null, nudgeCommand: null,
    }));

    const commonDir = '/repos/gamma/.git';
    const io = { run: fakeGitRepo({ '/wt/gamma': commonDir }), repokeyFs: identityFs };
    const rep = migrate.migrateToStore({ home, backend: 'journal', env: {}, io });
    assert.equal(rep.ok, true);
    assert.ok(rep.repoKeyMigration, 'repoKeyMigration report attached');
    assert.equal(rep.repoKeyMigration.ok, true);
    assert.equal(rep.repoKeyMigration.copied, 1, 'the freshly-created hash store was folded within the SAME migrateToStore run');

    const repoKey = expectedRepoKey(commonDir);
    const merged = storeLib.openStore({ home, backend: 'journal', hash: repoKey });
    try { assert.equal(merged.messageCount('primary-cccccccc'), 1); } finally { merged.close(); }
  } finally { rm(home); }
});

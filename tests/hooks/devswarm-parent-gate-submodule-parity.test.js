'use strict';
// devswarm-parent-gate submodule identity parity (v0.102.2, defect: a gate
// firing from a cwd INSIDE A GIT SUBMODULE derived a DIFFERENT own.id than
// the family-grouping key, both nominally the SAME `primary-<hash>` shape.
//
// ROOT CAUSE (proven by trace, not re-derived here): readOwnUnread's `top`
// used to come from `findGitToplevel(cwd)` — a PURE fs walk-up that STOPS at
// the first `.git` ENTRY it finds. In a submodule, `.git` is a FILE (not a
// directory) — `fs.statSync` succeeds on it exactly as on a directory, so
// the walk incorrectly treats the submodule as its own toplevel instead of
// continuing up to the superproject. The family-grouping key
// (canonicalMeshId / resolveCallerWorktree, scripts/devswarm.js) already
// detects this exact shape (a `.git` FILE) and re-resolves onto the
// superproject via `git rev-parse --show-superproject-working-tree` — so the
// two id derivations disagreed only inside a submodule cwd. That divergence
// is what minted a phantom `primary-<hash>` id (no registry row, CLI reports
// known:false) and printed an unrunnable `inbox read-primary primary-<hash>`
// remediation command.
//
// THE DECISIVE TEST: a gate firing from a cwd inside a REAL submodule (a
// `.git` FILE, not a plain nested directory — that file-vs-directory
// distinction IS the bug; a fixture using a plain nested dir would prove
// nothing here) must derive the SAME own.id the superproject root would.
//
// VACUITY PROOF: the last test below reconstructs the OLD naive resolver
// (findGitToplevel's pure fs walk-up, which STOPS at the first `.git` ENTRY
// it finds — a submodule's `.git` is a FILE, and `fs.statSync` succeeds on a
// file exactly as on a directory, so the walk incorrectly treats the
// submodule as its own toplevel) inline, right here in the test file. It
// runs that naive reconstruction and the real, shipped `resolveWorktreeNoSpawn`
// against the SAME real submodule fixture and asserts they DISAGREE — that
// disagreement IS the bug, proven directly at the resolver boundary, with NO
// dependency on git history/shas being reachable (a `git show <sha>` against
// an old commit fails under CI's shallow clone — `actions/checkout@v4` with
// no `fetch-depth` only fetches the pushed commit — so that approach was
// dropped entirely, not kept as a conditional fallback). This makes the test
// self-contained: it runs (and proves something) in CI, on a fresh shallow
// clone, and for any other developer — never only during the fix author's
// own verification run with a full local clone.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const HOOKS_DIR = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks');
const FIXED_HOOK = path.join(HOOKS_DIR, 'devswarm-parent-gate.js');
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };

const GIT_AVAILABLE = (() => {
  try {
    const r = require('node:child_process').spawnSync('git', ['--version']);
    return !r.error && r.status === 0;
  } catch (_) { return false; }
})();

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// mkSuperprojectWithSubmodule() -> { superRepo, submodulePath, home, root }.
// A REAL `git submodule add` on disk — `<superRepo>/modules/sub/.git` is a
// FILE ('gitdir: ...'), never a directory. Mirrors
// tests/scripts/devswarm-fleet-d56bfaac2da0.test.js's own fixture builder
// (that defect fixed resolveCallerWorktree itself; this test proves
// readOwnUnread now routes through the SAME fixed resolver).
function mkSuperprojectWithSubmodule() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-gate-submod-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-gate-submod-home-'));
  const subRepo = path.join(root, 'sub-origin');
  const superRepo = path.join(root, 'super');

  fs.mkdirSync(subRepo, { recursive: true });
  git(['init', '-q', '-b', 'main'], subRepo);
  git(['config', 'user.email', 'a@b.c'], subRepo);
  git(['config', 'user.name', 'a'], subRepo);
  fs.writeFileSync(path.join(subRepo, 'f.txt'), 'x');
  git(['add', '.'], subRepo);
  git(['commit', '-q', '-m', 'init'], subRepo);

  fs.mkdirSync(superRepo, { recursive: true });
  git(['init', '-q', '-b', 'main'], superRepo);
  git(['config', 'user.email', 'a@b.c'], superRepo);
  git(['config', 'user.name', 'a'], superRepo);
  fs.writeFileSync(path.join(superRepo, 'root.txt'), 'x');
  git(['add', '.'], superRepo);
  git(['commit', '-q', '-m', 'init'], superRepo);
  git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subRepo, 'modules/sub'], superRepo);
  git(['commit', '-q', '-m', 'add submodule'], superRepo);

  const submodulePath = path.join(superRepo, 'modules', 'sub');
  // Confirm the fixture actually reproduces the FILE-vs-directory shape the
  // bug depends on — a fixture that silently degraded to a plain directory
  // would make every assertion below vacuous.
  const st = fs.lstatSync(path.join(submodulePath, '.git'));
  assert.ok(st.isFile(), 'fixture sanity: submodule .git must be a FILE, not a directory');

  return { superRepo, submodulePath, home, root };
}

function writeOwnSummaryAt(home, repoKey, id, unread) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const summary = { workspaces: { [id]: { unread } }, archivedRegistryRows: [] };
  fs.writeFileSync(path.join(dir, repoKey + '.json'), JSON.stringify(summary));
}

function stopPayloadAt(cwd) {
  return { hook_event_name: 'Stop', session_id: 'sess-submod', cwd };
}

// naiveFindGitToplevel(startDir) -> absolute repo-root path | null.
// RECONSTRUCTION of the PRE-FIX behavior — a pure fs walk-up that STOPS at
// the first `.git` ENTRY it finds, whether that entry is a directory (a real
// toplevel) or a FILE (a submodule's `.git` marker). This is a byte-for-byte
// behavioral copy of `findGitToplevel` above (and of the pre-fix
// `readOwnUnread`'s `top` derivation, which used to call it unconditionally,
// before `resolveWorktreeNoSpawn` was added in front of it) — kept as an
// inline reconstruction, not a shared require, specifically so this test
// depends on nothing but this file plus the real fixture and the real
// shipped resolver it is compared against.
function naiveFindGitToplevel(startDir) {
  try {
    let dir = path.resolve(String(startDir || ''));
    if (!dir) return null;
    for (;;) {
      try {
        fs.statSync(path.join(dir, '.git'));
        return dir;
      } catch (_) { /* keep walking up */ }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch (_) {
    return null;
  }
}

test('BLOCK: gate firing from inside a git submodule derives the SAME own.id as the superproject root (v0.102.2)', (t) => {
  if (!GIT_AVAILABLE) { t.skip('git not available on PATH'); return; }
  const { superRepo, submodulePath, home, root } = mkSuperprojectWithSubmodule();
  try {
    // The repoKey family key is ALREADY submodule-aware (devswarm-repokey.js's
    // gitCommonDir superproject re-resolution) — resolving it from the
    // submodule cwd must land on the SAME repoKey the superproject root does.
    const repoKeyFromSubmodule = repokey.repoKeyForWorktree(submodulePath);
    const repoKeyFromSuperRoot = repokey.repoKeyForWorktree(superRepo);
    assert.equal(repoKeyFromSubmodule, repoKeyFromSuperRoot, 'sanity: repoKey must already be submodule-aware');

    // The CORRECT own.id (post-fix): keyed off the SUPERPROJECT worktree,
    // exactly what canonicalMeshId(submodulePath) (the family key) resolves
    // to via resolveCallerWorktree's own submodule re-resolution.
    const correctOwnId = 'primary-' + installIngest.worktreeHash(superRepo);
    // The PHANTOM id the bug used to mint: keyed off the submodule's OWN
    // toplevel (findGitToplevel stops there — a `.git` FILE satisfies its
    // bare fs.statSync existence check).
    const phantomOwnId = 'primary-' + installIngest.worktreeHash(submodulePath);
    assert.notEqual(correctOwnId, phantomOwnId, 'sanity: the two candidate ids must actually differ for this test to mean anything');

    writeOwnSummaryAt(home, repoKeyFromSuperRoot, correctOwnId, 5);

    const r = testHook(FIXED_HOOK, stopPayloadAt(submodulePath), { home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(r.json, `stdout must be JSON; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.strictEqual(r.json.decision, 'block', `must block on the Primary's own 5 unread; reason=${r.json && r.json.reason}`);
    assert.ok(
      r.json.reason.includes('inbox read-primary ' + correctOwnId),
      `must name the CORRECT superproject-keyed id in the read-primary remediation; got reason=${r.json.reason}`
    );
    assert.ok(
      !r.json.reason.includes(phantomOwnId),
      `must NEVER print the phantom submodule-keyed id; got reason=${r.json.reason}`
    );
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// EDIT 2 — never force a survivor id the store's own registry does not know
// about. Belt-and-braces on top of edit 1: with readOwnUnread's own.id now
// routed through the SAME canonical resolver the family key uses
// (canonicalMeshId), own.id and the family-collapse key are, BY
// CONSTRUCTION, always identical once resolvable — which means
// collapseFamilies' OWN survivor pick (a member whose `id` already equals
// the resolved key wins outright) ALREADY always lands on the self row, and
// the explicit `selfFamily.survivor = selfEntry` force in
// devswarm-parent-gate.js is now provably unreachable-effect through the
// real, single, unified process boundary (there is no longer any live path
// where the two resolvers can disagree within one hook invocation). This
// test therefore exercises the guard PREDICATE directly against the real,
// exported `collapseFamilies` primitive, injecting the exact FUTURE-DRIFT
// shape the guard exists to survive (a resolver that disagrees with own.id,
// exactly what edit 1 closes for TODAY's two resolvers) — proving the guard
// itself is correct in isolation, independent of whether today's code can
// still reach it. A source-text assertion ties this copy to the hook's own
// guard so the two cannot silently drift apart.
// ---------------------------------------------------------------------------

test('EDIT 2: guard predicate matches the shipped hook source, and refuses to force a survivor id absent from registryRows', () => {
  const identityFamily = require('../../plugins/anti-hall/companion/lib/devswarm-identity-family.js');

  // Drift-guard: keep this test honest against the ACTUAL shipped condition,
  // not a copy that quietly went stale.
  const src = fs.readFileSync(FIXED_HOOK, 'utf8');
  assert.match(
    src,
    /const ownIdInRegistry = own\.id && Array\.isArray\(own\.registryRows\)\s*\n\s*&& own\.registryRows\.some\(\(r\) => r && r\.id === own\.id\);/,
    'the shipped guard predicate text changed — update this test\'s mirrored copy below to match'
  );
  assert.match(
    src,
    /if \(ownIdInRegistry\) selfFamily\.survivor = selfEntry;/,
    'the shipped guard\'s force-assignment changed — update this test\'s mirrored copy below to match'
  );

  // Mirrors the exact production guard (verified above to match source).
  function forceSurvivorIfRegistered(own, selfEntry, selfFamily) {
    const ownIdInRegistry = own.id && Array.isArray(own.registryRows)
      && own.registryRows.some((r) => r && r.id === own.id);
    if (ownIdInRegistry) selfFamily.survivor = selfEntry;
  }

  // FUTURE-DRIFT INJECTION: `resolve(worktreePath)` deliberately disagrees
  // with `selfEntry.id` (exactly the shape edit 1 closes for today's two
  // resolvers, reproduced here directly at the collapseFamilies boundary so
  // this guard's own correctness is provable independent of whether it is
  // reachable today).
  const selfEntry = { id: 'primary-phantom', worktreePath: '/fake/cwd' };
  const realEntry = { id: 'primary-real', worktreePath: '/fake/cwd' }; // SAME worktree as selfEntry -> same family
  const resolve = (wt) => (wt === '/fake/cwd' ? 'primary-real' : null);
  const families = identityFamily.collapseFamilies([selfEntry, realEntry], { resolve });
  const selfFamily = families.find((f) => f.members.indexOf(selfEntry) !== -1);
  assert.ok(selfFamily, 'selfEntry must land in some family');
  // Sanity: collapseFamilies' OWN pick, unforced, already prefers realEntry
  // (its id equals the resolved key) over the drifted selfEntry — the exact
  // "some other id already knows the truth" case the guard must not override.
  assert.equal(selfFamily.survivor, realEntry, 'sanity: collapseFamilies must naturally prefer the correctly-keyed member');

  // own.id ('primary-phantom') is ABSENT from registryRows -> must NOT force.
  const ownUnregistered = { id: 'primary-phantom', registryRows: [{ id: 'primary-real' }] };
  forceSurvivorIfRegistered(ownUnregistered, selfEntry, selfFamily);
  assert.equal(selfFamily.survivor, realEntry, 'must NOT force survivor onto an id absent from registryRows');

  // own.id present in registryRows -> the pre-existing force behavior is preserved.
  const ownRegistered = { id: 'primary-phantom', registryRows: [{ id: 'primary-phantom' }, { id: 'primary-real' }] };
  forceSurvivorIfRegistered(ownRegistered, selfEntry, selfFamily);
  assert.equal(selfFamily.survivor, selfEntry, 'must still force survivor onto own.id when the registry confirms it');
});

test('VACUITY PROOF: the naive pre-fix resolver and the real shipped resolver DISAGREE on the same submodule fixture, and the live hook uses the fixed one', (t) => {
  if (!GIT_AVAILABLE) { t.skip('git not available on PATH'); return; }
  const { superRepo, submodulePath, home, root } = mkSuperprojectWithSubmodule();
  try {
    const { resolveWorktreeNoSpawn } = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

    // --- THE DEFECT, PROVEN DIRECTLY AT THE RESOLVER BOUNDARY ---
    // naive walk-up (pre-fix behavior): stops AT the submodule's own `.git`
    // FILE, so it reports the submodule itself as toplevel.
    const naiveTop = naiveFindGitToplevel(submodulePath);
    assert.strictEqual(naiveTop, submodulePath, 'sanity: the naive resolver must reproduce the bug (stop at the submodule)');

    // real shipped resolver (the fix): continues past the submodule's `.git`
    // FILE onto the superproject.
    const fixedTop = resolveWorktreeNoSpawn(submodulePath);
    assert.strictEqual(fixedTop, superRepo, 'sanity: resolveWorktreeNoSpawn must resolve onto the superproject');

    // The two resolvers disagree — THIS divergence is the bug this whole
    // file exists to close. If a future change makes them agree (e.g. a
    // revert of resolveWorktreeNoSpawn back to naive-walk behavior), the
    // sanity assertions above fail loudly, and this assertion would too.
    assert.notEqual(naiveTop, fixedTop, 'the naive and fixed resolvers must disagree on a submodule cwd — that disagreement IS the bug');

    // --- BEHAVIORAL ASSERTION: the live, shipped hook derives its own.id via
    // the FIXED resolver, and therefore blocks naming the superproject-keyed id.
    const repoKeyFromSuperRoot = repokey.repoKeyForWorktree(superRepo);
    const correctOwnId = 'primary-' + installIngest.worktreeHash(superRepo);
    writeOwnSummaryAt(home, repoKeyFromSuperRoot, correctOwnId, 5);

    const rFixed = testHook(FIXED_HOOK, stopPayloadAt(submodulePath), { home, env: PRIMARY_ENV });
    assert.strictEqual(rFixed.status, 0, 'fixed hook must exit 0');
    assert.ok(rFixed.json, `fixed hook stdout must be JSON; stdout=${rFixed.stdout} stderr=${rFixed.stderr}`);
    assert.strictEqual(rFixed.json.decision, 'block', `fixed hook must block on the Primary's own 5 unread; reason=${rFixed.json && rFixed.json.reason}`);
    assert.ok(
      rFixed.json.reason.includes('inbox read-primary ' + correctOwnId),
      `fixed hook must name the CORRECT superproject-keyed id; got reason=${rFixed.json.reason}`
    );
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_) {}
  }
});

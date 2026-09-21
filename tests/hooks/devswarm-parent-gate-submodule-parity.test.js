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
// VACUITY PROOF: the last test below RECONSTRUCTS the pre-fix hook from git
// at test-run time (not a one-off scratch file that only existed on the
// author's machine) — `git show <PRE_FIX_SHA>:plugins/.../devswarm-parent-gate.js`
// into a tmp file inside hooks/ (so its relative `require('../scripts/
// devswarm.js')` etc. still resolve), runs it against the SAME submodule
// fixture, and asserts it reproduces the bug. This makes the test
// self-contained: it runs (and proves something) in CI, on a fresh clone, and
// for any other developer — never only during the fix author's own
// verification run.

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
const REPO_ROOT = path.join(__dirname, '..', '..');
// PRE_FIX_SHA — the v0.102.1 release commit, the LAST commit whose
// devswarm-parent-gate.js still derives readOwnUnread's `top` via the pure-fs
// findGitToplevel(cwd) (the bug this file's first test proves fixed). A
// PINNED, NAMED sha — never a relative ref like HEAD~1 — because a relative
// ref breaks the instant anything else is committed on top of this fix.
const PRE_FIX_SHA = 'becf37e0aed549a4834a66070d8b7250a13b2e02';
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

// materializePreFixHook() -> absolute path to a tmp copy of
// devswarm-parent-gate.js AS IT WAS at PRE_FIX_SHA, placed inside the real
// hooks/ dir so its relative `require('../scripts/devswarm.js')` /
// `require('../companion/...')` calls still resolve. Throws LOUDLY (never
// skips/swallows) when the sha cannot be read — a CI checkout that cannot
// reach a tagged release commit is a real problem this test must surface,
// not silently pass around.
function materializePreFixHook() {
  let content;
  try {
    content = execFileSync('git', ['show', PRE_FIX_SHA + ':plugins/anti-hall/hooks/devswarm-parent-gate.js'], {
      cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(
      `Cannot read the pre-fix devswarm-parent-gate.js from PRE_FIX_SHA=${PRE_FIX_SHA}. `
      + 'This sha (the v0.102.1 release commit) must be reachable for the vacuity-proof test to run — '
      + `a shallow clone or an unreachable sha is a real CI problem, not a reason to skip. Underlying error: ${e && e.message}`
    );
  }
  if (!content || content.indexOf('function readOwnUnread') === -1) {
    throw new Error(`git show ${PRE_FIX_SHA}:.../devswarm-parent-gate.js returned unexpected content (missing readOwnUnread) — refusing to run the vacuity proof against it.`);
  }
  const dest = path.join(HOOKS_DIR, '_scratch-parent-gate-prefix-' + process.pid + '.js');
  fs.writeFileSync(dest, content);
  return dest;
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

test('VACUITY PROOF: the SAME fixture reproduces the bug against the pre-fix hook, reconstructed from git at PRE_FIX_SHA (v0.102.1)', (t) => {
  if (!GIT_AVAILABLE) { t.skip('git not available on PATH'); return; }
  const { superRepo, submodulePath, home, root } = mkSuperprojectWithSubmodule();
  let preFixHookPath = null;
  try {
    preFixHookPath = materializePreFixHook(); // throws loudly if PRE_FIX_SHA is unreachable — never skips
    const repoKeyFromSuperRoot = repokey.repoKeyForWorktree(superRepo);
    const correctOwnId = 'primary-' + installIngest.worktreeHash(superRepo);
    writeOwnSummaryAt(home, repoKeyFromSuperRoot, correctOwnId, 5);

    // --- pre-fix: must reproduce the bug ---
    const rUnfixed = testHook(preFixHookPath, stopPayloadAt(submodulePath), { home, env: PRIMARY_ENV });
    // findGitToplevel(submodulePath) stops AT the submodule, so own.id never
    // equals correctOwnId and the summary entry (keyed under correctOwnId)
    // is never found -> no block on the Primary's own unread. Assert the
    // BUG's actual failure shape: no block that names the correct id.
    const blockedOnOwnUnreadUnfixed = rUnfixed.json && rUnfixed.json.decision === 'block'
      && rUnfixed.json.reason.includes('inbox read-primary ' + correctOwnId);
    assert.ok(
      !blockedOnOwnUnreadUnfixed,
      `VACUOUS TEST: the pre-fix hook (PRE_FIX_SHA=${PRE_FIX_SHA}) must reproduce the divergence (fail to name the correct id), but it didn't; `
      + `got status=${rUnfixed.status} json=${JSON.stringify(rUnfixed.json)} stderr=${rUnfixed.stderr}`
    );

    // --- fixed (current working tree): must NOT reproduce the bug ---
    const rFixed = testHook(FIXED_HOOK, stopPayloadAt(submodulePath), { home, env: PRIMARY_ENV });
    assert.strictEqual(rFixed.status, 0, 'fixed hook must exit 0');
    assert.ok(rFixed.json, `fixed hook stdout must be JSON; stdout=${rFixed.stdout} stderr=${rFixed.stderr}`);
    assert.strictEqual(rFixed.json.decision, 'block', `fixed hook must block on the Primary's own 5 unread; reason=${rFixed.json && rFixed.json.reason}`);
    assert.ok(
      rFixed.json.reason.includes('inbox read-primary ' + correctOwnId),
      `fixed hook must name the CORRECT superproject-keyed id; got reason=${rFixed.json.reason}`
    );
  } finally {
    if (preFixHookPath) { try { fs.unlinkSync(preFixHookPath); } catch (_) {} }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_) {}
  }
});

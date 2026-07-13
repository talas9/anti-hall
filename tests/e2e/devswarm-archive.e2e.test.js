'use strict';
// tests/e2e/devswarm-archive.e2e.test.js — v0.56.0 archive-flow E2E.
//
// STUB BOUNDARY (the ONLY thing this suite ever fakes): the hivecontrol
// subprocess. Two distinct mechanisms, each documented at its own call site
// below — nothing else in this file is stubbed or reimplemented:
//   1. scripts/devswarm.js's `archive-request` and `inbox pull` subcommands are
//      invoked IN-PROCESS via the CLI's own exported `run(argv, ctx)` with an
//      injected `ctx.io.run` — the SAME seam the module documents itself
//      ("ctx.io is undefined in production (real hivecontrol spawn); tests
//      inject { run } so the CLI path is exercised without touching a real
//      binary" — see cmdInboxPull's comment in scripts/devswarm.js). This still
//      drives the real dispatcher/store/fs code end to end; only the hivecontrol
//      subprocess spawn itself is swapped for a fake in-memory queue.
//   2. Hooks (devswarm-child-turn.js, devswarm-child-gate.js, devswarm-parent-
//      inbox.js) are spawned as REAL child processes (tests/helpers/spawn-hook.js
//      testHook), exactly like the sibling devswarm-substrate.e2e.test.js suite.
//      devswarm-child-gate.js can itself spawn a bare `hivecontrol` (its STRICT
//      native message-count fallback probe) — PATH is pinned to a directory that
//      does not exist, so that probe deterministically fails open (ENOENT ->
//      null -> "no unread"), the same hermetic-PATH pattern already used by
//      tests/hooks/devswarm-child-gate.test.js's NO_NATIVE_BIN_PATH. No fake
//      hivecontrol binary is written to disk anywhere in this file.
// launchd/systemd and the ingest-daemon installer are never touched here.
//
// Everything else — the store, the CLI dispatch, every hook's own fs reads and
// writes, the descriptor registry, the durable inbox/cursor files — is the REAL
// shipped code, exercised through its real entry points.
//
// Isolation: every test uses a fresh tmp HOME (tests/e2e/helpers.js's
// makeHome()) and rm()'s it in a finally, mirroring the sibling suite.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const H = require('./helpers.js');
const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function ctxOf(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}
function segOf(c, banner) {
  return c.split('\n\n').find((s) => s.startsWith(banner)) || '';
}
const cliCtx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

// A PATH pointing at a directory that does not exist — guarantees no real
// hivecontrol binary is ever found by a hook's own native probe, regardless of
// what happens to be installed on the host running this test. Mirrors
// tests/hooks/devswarm-child-gate.test.js's NO_NATIVE_BIN_PATH.
const NO_NATIVE_BIN_PATH = path.join(os.tmpdir(), 'antihall-e2e-archive-no-native-bin');

// gitOnlyPath() -> a PATH string containing ONLY git's own directory + the
// (nonexistent) NO_NATIVE_BIN_PATH — never the host's full real PATH. v0.57
// mesh (PLAN-v0.57-mesh.md D1/D2): repoKeyForWorktree() spawns a real `git`
// (unlike the pre-mesh pure-fs readDescriptors path this test used to rely
// on), so the hermetic NO_NATIVE_BIN_PATH-only env would make `git` ENOENT
// and repoKey never resolve. Adding ONLY git's directory keeps the SAME "no
// real hivecontrol reachable" isolation guarantee (no other host binary is
// exposed) while letting the git spawn succeed. Resolved ONCE (module load).
function resolveGitDir() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = cp.spawnSync(cmd, ['git'], { encoding: 'utf8' });
    const first = (r.stdout || '').split(/\r?\n/).find((l) => l.trim());
    return first ? path.dirname(first.trim()) : null;
  } catch (_) { return null; }
}
const GIT_DIR = resolveGitDir();
function gitOnlyPath() {
  return GIT_DIR ? (GIT_DIR + path.delimiter + NO_NATIVE_BIN_PATH) : NO_NATIVE_BIN_PATH;
}

// ============================================================================
// 1. CHILD REGISTRATION -> PARENT VISIBILITY (the #31 fix). Nothing but the
//    child's own turn mechanically writes its descriptor; the parent then
//    discovers it purely through readDescriptors().
// ============================================================================

test('1 REGISTRATION: a child-turn hook run mechanically registers the descriptor, and the parent-inbox hook then lists it', () => {
  const home = H.makeHome();
  try {
    const childId = 'child-reg-1';
    const childEnv = {
      DEVSWARM_REPO_ID: 'repo-1',
      DEVSWARM_SOURCE_BRANCH: 'feature/child-reg-1',
      DEVSWARM_BUILDER_ID: childId,
      PATH: gitOnlyPath(),
    };
    // cwd = this repo's own worktree (a REAL git repo) so registerChildDescriptor's
    // pure-fs findGitToplevel walk resolves a genuine worktreePath.
    const payload = { hook_event_name: 'UserPromptSubmit', session_id: 'sess-reg-1', prompt: 'go', cwd: H.REPO_ROOT };
    const r = testHook('devswarm-child-turn.js', payload, { home, env: childEnv, expectJson: true });
    assert.strictEqual(r.status, 0, `child-turn must exit 0; stderr=${r.stderr}`);
    assert.ok(r.json, `child-turn must emit JSON; stdout=${r.stdout}`);

    // The descriptor was mechanically written (#31 HOTFIX) — no explicit `register`
    // call from the child; this is registerChildDescriptor's own fs write.
    const descPath = H.descriptorPath(home, childId);
    assert.ok(fs.existsSync(descPath), 'child-turn must write the descriptor');
    const desc = JSON.parse(fs.readFileSync(descPath, 'utf8'));
    assert.strictEqual(desc.id, childId);
    assert.strictEqual(desc.sessionId, 'sess-reg-1');
    assert.strictEqual(desc.worktreePath, path.resolve(H.REPO_ROOT));

    // A Primary turn now sees this child in its live status table. Pre-mesh
    // (#31 fix) this was via raw readDescriptors(); v0.57 mesh (Phase 8) reads
    // the shared summaries/<repoKey>.json instead — populated by the SAME
    // child-turn call above's D24 gap-close (registerStoreDescriptor). cwd
    // must resolve the SAME repoKey (H.REPO_ROOT, as above) for the Primary
    // to read the project this child was mechanically registered into.
    const pr = testHook('devswarm-parent-inbox.js',
      { hook_event_name: 'UserPromptSubmit', session_id: 'primary', prompt: 'hi', cwd: H.REPO_ROOT },
      { home, env: { DEVSWARM_REPO_ID: 'repo-1', PATH: gitOnlyPath() }, expectJson: true });
    const c = ctxOf(pr);
    assert.match(c, /DEVSWARM WORKSPACES/);
    assert.match(segOf(c, 'DEVSWARM WORKSPACES'), new RegExp(childId), `child must be listed in the live table; ctx=${c}`);
  } finally { H.rm(home); }
});

// ============================================================================
// 2. ARCHIVE-REQUEST ROUND-TRIP (v0.58 mesh-only messaging, PLAN.md CLI VERB
//    CONTRACT): `archive-request` is now a STORE WRITE straight into the
//    child's own mesh partition — ZERO hivecontrol calls (the old `list
//    children` lookup + `message-child` spawn is DELETED). `deriveSummary`
//    marks `archive_requested:true` for that workspace, and the child's next
//    turn surfaces the priority archive-request segment — recommendation
//    only, NEVER auto-archive.
// ============================================================================

test('2 ARCHIVE-REQUEST: parent posts a STORE mesh row (zero hivecontrol calls) -> deriveSummary marks archive_requested -> child-turn surfaces the priority archive-request segment', () => {
  const home = H.makeHome();
  try {
    const childId = 'child-arc-1';
    const childBranch = 'feature/child-arc-1';
    const worktree = path.join(home, 'wt', childId);

    // The child is already an ACTIVE, registered workspace — the real-world
    // precondition for a parent addressing it by childId (mirrors the
    // mechanical registration devswarm-child-turn.js itself performs).
    const regRes = cli.run(
      ['register', childId, '--worktree', worktree, '--session', 'sess-arc-1'],
      cliCtx(home, { cwd: H.REPO_ROOT }),
    );
    assert.strictEqual(regRes.code, 0, `register must succeed; result=${JSON.stringify(regRes.result)}`);

    // --- PARENT SIDE: devswarm.js archive-request is a STORE WRITE — NEVER a
    // native hivecontrol spawn. Inject a runner that FAILS on ANY hivecontrol
    // call to mechanically prove zero native calls occur (the old `list
    // children` + `message-child` spawn is genuinely deleted, not just untested).
    const parentIo = {
      run: (spec) => { throw new Error('UNEXPECTED hivecontrol call: ' + JSON.stringify(spec && spec.args)); },
    };
    const reqRes = cli.run(
      ['archive-request', childId, '--reason', 'merged + tested + deployed'],
      cliCtx(home, { io: parentIo, cwd: H.REPO_ROOT }),
    );
    assert.strictEqual(reqRes.code, 0, `archive-request must succeed; result=${JSON.stringify(reqRes.result)}`);
    assert.strictEqual(reqRes.result.posted, true);
    assert.strictEqual(reqRes.result.childId, childId);

    // --- STORE ROW: verified straight from the store (not inferred from the
    // CLI's own report) — a mesh-direct row landed in the child's OWN
    // partition, carrying the marker, urgency high.
    const repoKey = repokey.repoKeyForWorktree(H.REPO_ROOT);
    assert.ok(repoKey, 'precondition: this repo resolves a repoKey');
    const s = store.openStore({ home, hash: repoKey, backend: 'journal', env: {} });
    let rows;
    try { rows = s.listMessages(childId); } finally { s.close(); }
    assert.strictEqual(rows.length, 1, 'exactly one mesh row landed in the child partition');
    assert.strictEqual(rows[0].mtype, 'direct');
    assert.strictEqual(rows[0].urgency, 'high');
    assert.match(rows[0].body, /\[\[ANTIHALL_ARCHIVE_REQUEST\]\]/);
    assert.match(rows[0].body, /devswarm\.js archive <id>/);

    // --- deriveSummary: archive_requested:true for this workspace (the CLI
    // call above already re-derives it; read the persisted projection back).
    const summary = store.readSummaryForHash(home, repoKey);
    assert.ok(summary && summary.workspaces && summary.workspaces[childId],
      `summary must carry this workspace; summary=${JSON.stringify(summary)}`);
    assert.strictEqual(summary.workspaces[childId].archive_requested, true);

    // --- CHILD TURN: the real hook surfaces the priority archive-request
    // segment — a recommendation only, requiring the child's OWN user to
    // confirm. cwd resolves the SAME repoKey as the parent side above.
    const turnPayload = {
      hook_event_name: 'UserPromptSubmit', session_id: 'sess-arc-1', prompt: 'go', cwd: H.REPO_ROOT,
    };
    const turnEnv = {
      DEVSWARM_REPO_ID: 'repo-1',
      DEVSWARM_SOURCE_BRANCH: childBranch,
      DEVSWARM_BUILDER_ID: childId,
      // gitOnlyPath (not NO_NATIVE_BIN_PATH): the mesh summary read below this
      // hook needs repoKeyForWorktree() to resolve, which spawns a real `git`
      // (v0.57 mesh D1/D2) — a hermetic PATH with no git at all would fail
      // repoKey resolution and silently skip the archive_requested read. git's
      // directory is the ONLY real host binary exposed; no hivecontrol reachable.
      PATH: gitOnlyPath(),
      // Pin the SAME backend the parent-side cli.run() calls above use
      // (cliCtx's `backend: 'journal'`) — this hook's own registerStoreDescriptor
      // opens the store with NO explicit backend, so on node>=22.5 (sqlite
      // available) it would otherwise auto-select sqlite while the parent wrote
      // via journal: two DISJOINT stores, and the archive-request row would
      // silently vanish from this hook's point of view. Real production has no
      // such split (both sides share the SAME auto-detect, no forcing anywhere);
      // this env var only reconciles the deliberate 'journal' pin the parent-side
      // calls make above for test determinism.
      ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal',
    };
    const tr = testHook('devswarm-child-turn.js', turnPayload, { home, env: turnEnv, expectJson: true });
    assert.strictEqual(tr.status, 0, `child-turn must exit 0; stderr=${tr.stderr}`);
    const c = ctxOf(tr);
    assert.match(c, /DEVSWARM ARCHIVE REQUEST/);
    assert.match(c, new RegExp('devswarm\\.js archive ' + childId));
    assert.match(c, /Confirm with YOUR user/);
    assert.match(c, /NEVER\s+auto-archive/i);

    // INVARIANT: nothing in this entire round-trip ever ran an archive/delete —
    // the descriptor remains exactly where registration put it.
    const descPath = H.descriptorPath(home, childId);
    assert.ok(fs.existsSync(descPath), 'descriptor must remain (never auto-archived)');
  } finally { H.rm(home); }
});

// ============================================================================
// 3. CHILD-GATE INBOUND BLOCK: unread parent messages force an `inbox pull`
//    before Stop (up to the shared forced-ack cap); STRICT=0 relies on the
//    pure-fs durable check only.
// ============================================================================

test('3 CHILD-GATE: unread parent messages block Stop demanding `inbox pull`, capped, then yields', () => {
  const home = H.makeHome();
  try {
    const childId = 'child-gate-1';
    H.seedWorkspace(home, childId, { inbox: ['from parent: rebase please'], cursor: 0 });
    const env = {
      DEVSWARM_REPO_ID: 'repo-1',
      DEVSWARM_SOURCE_BRANCH: 'feature/child-gate-1',
      DEVSWARM_BUILDER_ID: childId,
      PATH: NO_NATIVE_BIN_PATH,
    };
    const stopPayload = { hook_event_name: 'Stop', session_id: 'sess-gate-1' };

    const r1 = testHook('devswarm-child-gate.js', stopPayload, { home, env, expectJson: true });
    assert.strictEqual(r1.json && r1.json.decision, 'block', 'first stop blocks');
    assert.match(r1.json.reason, /inbox pull/);

    const r2 = testHook('devswarm-child-gate.js', stopPayload, { home, env, expectJson: true });
    assert.strictEqual(r2.json && r2.json.decision, 'block', 'second stop blocks (still within the cap)');

    const r3 = testHook('devswarm-child-gate.js', stopPayload, { home, env });
    assert.strictEqual(r3.status, 0);
    assert.strictEqual(r3.stdout, '', 'third stop yields — the shared forced-ack cap is never bypassed');
  } finally { H.rm(home); }
});

test('3 CHILD-GATE: STRICT=0 relies on the durable fs check ONLY — no unread there means no inbound instruction, outbound-only block', () => {
  const home = H.makeHome();
  try {
    const childId = 'child-gate-2';
    H.seedWorkspace(home, childId, { inbox: [], cursor: 0 }); // caught up, nothing unread
    const env = {
      DEVSWARM_REPO_ID: 'repo-1',
      DEVSWARM_SOURCE_BRANCH: 'feature/child-gate-2',
      DEVSWARM_BUILDER_ID: childId,
      PATH: NO_NATIVE_BIN_PATH,
      ANTIHALL_DEVSWARM_CHILD_GATE_STRICT: '0',
    };
    const r = testHook('devswarm-child-gate.js', { hook_event_name: 'Stop', session_id: 'sess-gate-2' },
      { home, env, expectJson: true });
    assert.strictEqual(r.json && r.json.decision, 'block', 'the outbound forced-ack still fires');
    // v0.58 mesh-only messaging: the forced-ack reason names the mesh CLI verb
    // (`heartbeat --summary`), never the blocked native `message-parent`.
    assert.match(r.json.reason, /devswarm\.js heartbeat <DEVSWARM_BUILDER_ID> --summary/);
    assert.ok(!/message-parent/.test(r.json.reason), 'must never emit the blocked native verb');
    assert.ok(!/inbox pull/.test(r.json.reason),
      'STRICT=0 + no durable unread -> the pure-fs check found nothing, no inbound instruction');
  } finally { H.rm(home); }
});

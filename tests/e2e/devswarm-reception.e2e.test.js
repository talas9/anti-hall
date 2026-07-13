'use strict';
// ============================================================================
// DevSwarm RECEPTION — v0.55.0 release-gate E2E suite.
//
// Proves the FULL anti-hall <-> DevSwarm reception loop end to end, using the
// REAL modules against an isolated temp HOME (never the real machine's
// ~/.anti-hall). Companion to tests/e2e/devswarm-substrate.e2e.test.js (which
// covers the hook-level guard/gate/classify/archive-ready surface); this file
// covers the STORE-INGEST-RECOVERY reception pipeline that landed this session:
// devswarm-store.js, scripts/devswarm.js, companion/lib/recovery.js,
// companion/devswarm-ingest.js, companion/install-devswarm-ingest.js, and the
// read-guard pair (hooks/inbox-read-guard.js + hooks/command-guard.js).
//
// STUB BOUNDARY (read this before trusting the coverage below):
//   STUBBED (cannot run in CI, by design):
//     - the `hivecontrol workspace monitor` subprocess itself — every
//       runIngestLoop() call below passes an injected `run()` that returns a
//       canned payload instead of spawning the real hivecontrol binary.
//     - real OS scheduling (launchd plist load / systemd unit start / cron).
//       install-devswarm-ingest.js's macInstall/linuxInstall (which shell out to
//       `launchctl`/`systemctl`) are NEVER called. Where a unit's on-disk shape
//       matters (scenario 2), the test writes the plist FILE CONTENT the real
//       installer would have produced (via the real, pure buildPlist()) and
//       then exercises the real, read-only listInstalledIngestUnits() against
//       it — no process is scheduled or spawned.
//   REAL (exercised as the actual shipped code, not a mock):
//     - the store (both write AND the store's own read-back: appendMessage,
//       listMessages, messageCount, setCursor, cursorValue, deriveSummary),
//       reached either in-process or through a real `node scripts/devswarm.js`
//       subprocess (H.runCli — matches how an agent actually invokes it).
//     - the ingest loop's lock/dedupe/heartbeat machinery (acquireIngestLock,
//       ingestPayload's hash-dedupe, writeIngestHeartbeat) — only the ONE
//       external boundary (the monitor subprocess call) is stubbed.
//     - the per-worktree identity functions (worktreeHash, primaryWorkspaceId,
//       labelForWorktree) and the installer's plist-content builder (buildPlist)
//       and its real, read-only unit scanner (listInstalledIngestUnits).
//     - the supervisor escalation path (pokeOrEscalate -> notifyParentEscalation)
//       against the real store (an injected openParentStore that still opens
//       the REAL store module — injected only so the test can assert it was
//       actually used, not to fake its behavior).
//     - both read-guards (hooks/inbox-read-guard.js for the Read tool,
//       hooks/command-guard.js for Bash), spawned as real child processes.
//
// Every test uses a fresh tmp HOME (H.makeHome()) and rm()'s it in a finally.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const H = require('./helpers.js');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const ingest = require('../../plugins/anti-hall/companion/devswarm-ingest.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const recovery = require('../../plugins/anti-hall/companion/lib/recovery.js');
const liveness = require('../../plugins/anti-hall/companion/lib/liveness.js');

const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const COORD_ENV = { CLAUDE_CODE_ENTRYPOINT: 'cli', DEVSWARM_REPO_ID: 'repo-1' };
const JOURNAL_ENV = { ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal' };

// mkWorktree(home, ...segs) -> an absolute, REAL (mkdir'd) directory under the
// isolated tmp HOME standing in for a git worktree. worktreeHash/primaryWorkspaceId
// only need a resolvable real path (fs.realpathSync), not an actual git repo, and
// creating it under `home` means H.rm(home) cleans it up too.
function mkWorktree(home, ...segs) {
  const p = path.join(home, ...segs);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// ============================================================================
// 1. RECEPTION ROUND-TRIP — a stubbed daemon ingest cycle lands a child message
//    in the store; the Primary reads it via the real CLI; read-primary advances
//    BOTH cursors (#22 fix) so summary.json's projected unread drops to 0.
// ============================================================================

test('1 RECEPTION ROUND-TRIP: stubbed ingest -> inbox messages -> read-primary -> summary.json unread=0', () => {
  const home = H.makeHome();
  try {
    const worktree = mkWorktree(home, 'repo');
    const id = installIngest.primaryWorkspaceId(worktree);

    // Register the Primary descriptor for this worktree via the REAL CLI (creates
    // both the on-disk descriptor and the store registry row deriveSummary needs).
    // cwd: worktree (v0.57 mesh, D24) — `worktree` is deliberately NOT a real git
    // repo (see mkWorktree's header comment), so this pins repoKey===null for
    // every store-touching CLI call below, matching the in-process
    // runIngestLoop call's own null repoKey (same fake `worktree`) — both sides
    // then consistently fall back to the SAME pre-mesh per-id hash store.
    // Without this, the subprocess would otherwise inherit the TEST RUNNER's
    // OWN cwd (the real anti-hall repo) and resolve a DIFFERENT, real repoKey.
    const reg = H.runCli(home, ['register-primary', '--worktree', worktree], JOURNAL_ENV, { cwd: worktree });
    assert.strictEqual(reg.status, 0, `register-primary ok; stdout=${reg.stdout}`);
    assert.strictEqual(reg.json.id, id, 'derived id matches primaryWorkspaceId(worktree)');

    // Simulate the daemon: ONE bounded ingest cycle with a STUBBED hivecontrol
    // monitor call returning a single child message for this worktree's id.
    const run = () => ({
      ok: true,
      raw: JSON.stringify([
        { message: 'child finished phase 1', fromBranch: 'feat-x', createdAt: '2026-01-01T00:00:00Z' },
      ]),
    });
    const ing = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: id, worktree, maxIterations: 1, run, sleep: () => {},
    });
    assert.strictEqual(ing.started, true);
    assert.strictEqual(ing.stats.inserted, 1, 'the stubbed message was ingested into the store');

    // Primary reads it via the real CLI (non-destructive `inbox messages`).
    // cwd: worktree — see the register-primary call above (D24 repoKey parity).
    const msgs = H.runCli(home, ['inbox', 'messages', id, '--json'], JOURNAL_ENV, { cwd: worktree });
    assert.strictEqual(msgs.status, 0);
    assert.strictEqual(msgs.json.action, 'messages');
    assert.strictEqual(msgs.json.count, 1);
    assert.strictEqual(msgs.json.messages[0].body, 'child finished phase 1', 'store body reaches the Primary CLI');

    // Advance via `inbox read-primary` — the #22 fix also syncs the STORE's OWN
    // cursor (store.setCursor), not just the ack-cursor file, so deriveSummary's
    // projected unread reflects the read immediately. The ack-ownership guard
    // (bug #2) requires the caller's identity to match the target id; identity
    // derives from cwd (ground truth), NOT a declared DEVSWARM_BUILDER_ID — so
    // this spawns the CLI subprocess FROM `worktree` itself (cwd has no real
    // `.git` anywhere in its chain, so callerIdentity's raw-cwd fallback derives
    // exactly `id`, matching how `installIngest.primaryWorkspaceId(worktree)`
    // computed it above). This is the Primary reading its OWN inbox from its OWN
    // worktree, matching the self-ack pattern used for the same call in
    // tests/scripts/devswarm-cli.test.js (a DECLARED env identity would be
    // ignored here anyway once cwd genuinely resolves to a workspace — see that
    // file's env-spoof-closed test — so this deliberately proves identity via
    // cwd alone, no env declaration at all).
    const readPrimary = H.runCli(home, ['inbox', 'read-primary', id], JOURNAL_ENV, { cwd: worktree });
    assert.strictEqual(readPrimary.status, 0);
    assert.strictEqual(readPrimary.json.action, 'read-primary');
    assert.strictEqual(readPrimary.json.cursor, 1, 'ack cursor advanced to the current total');

    // summary.json — the projection the parent-inbox hook reads — must now show
    // 0 unread. This is the actual proof of the #22 cursor-reconcile. PER-PROJECT:
    // target this worktree's own store explicitly (the CLI subprocess's cwd is the
    // test runner's cwd, not `worktree`, so it would otherwise resolve a different
    // project's store).
    const list = H.runCli(home, ['workspaces', 'list', '--worktree', worktree], JOURNAL_ENV);
    assert.strictEqual(list.status, 0);
    const ws = list.json.workspaces.find((w) => w.id === id);
    assert.ok(ws, `registered workspace ${id} present in the projection`);
    assert.strictEqual(ws.total, 1);
    assert.strictEqual(ws.unread, 0, '#22 cursor-reconcile: unread drops to 0 after read-primary');
  } finally { H.rm(home); }
});

// ============================================================================
// 2. PER-WORKTREE ISOLATION (multi-repo) — distinct worktrees hash + id
//    differently, store rows never cross, install-identity (label) differs too,
//    and ingest locking is per-worktree (Option A): same worktree refuses a 2nd
//    holder, a different worktree gets its own independent lock.
// ============================================================================

test('2 PER-WORKTREE ISOLATION: distinct hash/id/label, store rows never cross, per-worktree ingest locking', () => {
  const home = H.makeHome();
  try {
    const wtA = mkWorktree(home, 'repos', 'a');
    const wtB = mkWorktree(home, 'repos', 'b');

    const hashA = installIngest.worktreeHash(wtA);
    const hashB = installIngest.worktreeHash(wtB);
    assert.notStrictEqual(hashA, hashB, 'distinct worktrees hash differently');

    const idA = installIngest.primaryWorkspaceId(wtA);
    const idB = installIngest.primaryWorkspaceId(wtB);
    assert.notStrictEqual(idA, idB, 'distinct worktrees derive distinct primary workspace ids');
    assert.strictEqual(idA, 'primary-' + hashA);

    // Install-identity (label) differs per worktree too — the same identity the
    // ingest lock/heartbeat and the (never-invoked-here) macInstall/linuxInstall
    // would key on.
    const labelA = installIngest.labelForWorktree(wtA);
    const labelB = installIngest.labelForWorktree(wtB);
    assert.notStrictEqual(labelA, labelB);
    assert.strictEqual(labelA, `${installIngest.LABEL}.${hashA}`);

    // Simulate what macInstall() WOULD have written (the real, pure buildPlist()
    // content) WITHOUT ever calling macInstall itself (which shells out to
    // `launchctl` — exactly the boundary this suite stubs). Then prove the real,
    // read-only listInstalledIngestUnits() reads it back correctly.
    const plistDir = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(plistDir, { recursive: true });
    fs.writeFileSync(path.join(plistDir, labelA + '.plist'), installIngest.buildPlist({ label: labelA, workdir: wtA }));
    const units = installIngest.listInstalledIngestUnits({ home, platform: 'darwin' });
    const unitA = units.find((u) => u.hash === hashA);
    assert.ok(unitA, 'the per-worktree unit is discoverable by its hash');
    assert.strictEqual(unitA.workingDir, wtA, 'the baked WorkingDirectory round-trips');

    // Ingest ONE message for repo A only (stubbed monitor).
    const run = () => ({
      ok: true, raw: JSON.stringify([{ message: 'A-only message', fromBranch: 'x', createdAt: '2026-01-01T00:00:00Z' }]),
    });
    const ing = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: idA, worktree: wtA, maxIterations: 1, run, sleep: () => {},
    });
    assert.strictEqual(ing.stats.inserted, 1);

    // listMessages isolation: repo B's id sees NOTHING of repo A's message. PER-
    // PROJECT: each id selects its OWN physical store, so open each scoped to its
    // own workspaceId (a bare no-workspaceId handle would open the unrelated
    // DEFAULT_HASH bucket, not either repo's store).
    const sA = store.openStore({ home, backend: 'journal', workspaceId: idA });
    try {
      assert.strictEqual(sA.listMessages(idA, {}).length, 1, 'repo A has its own message');
    } finally { sA.close(); }
    const sB = store.openStore({ home, backend: 'journal', workspaceId: idB });
    try {
      assert.strictEqual(sB.listMessages(idB, {}).length, 0, 'repo B is isolated — 0 messages');
      assert.strictEqual(sB.messageCount(idB), 0);
    } finally { sB.close(); }

    // acquireIngestLock is PER-WORKTREE (Option A): the SAME worktree refuses a
    // 2nd holder; a DIFFERENT worktree acquires its own, independent lock.
    const heldA = ingest.acquireIngestLock(home, undefined, wtA);
    assert.ok(heldA, 'repo A acquires its own lock');
    try {
      const refused = ingest.runIngestLoop({
        home, backend: 'journal', workspaceId: idA, worktree: wtA, maxIterations: 1,
        run: () => ({ ok: true, raw: '[]' }), sleep: () => {},
      });
      assert.strictEqual(refused.started, false, 'a 2nd consumer for the SAME worktree is refused');
      assert.match(refused.reason, /lock|consumer/i);

      const heldB = ingest.acquireIngestLock(home, undefined, wtB);
      assert.ok(heldB, 'a DIFFERENT worktree acquires its own, independent lock while A is held');
      heldB();
    } finally { heldA(); }
  } finally { H.rm(home); }
});

// ============================================================================
// 3. SUPERVISOR ESCALATION — pokeOrEscalate (no nudgeCommand -> immediate
//    escalate) mechanically notifies the PARENT store (the idle-child fix), and
//    the notice is idempotent across a repeat sweep tick.
// ============================================================================

test('3 SUPERVISOR ESCALATION: pokeOrEscalate escalates into the PARENT store, idempotent across repeat sweeps', () => {
  const home = H.makeHome();
  try {
    const worktree = mkWorktree(home, 'repo');
    const childId = 'child-x';
    const parentId = installIngest.primaryWorkspaceId(worktree);

    const descriptor = { id: childId, worktreePath: worktree, sessionId: 'c1', nudgeCommand: null };
    const now = Date.now();
    let opens = 0;
    // Injected openParentStore — still opens the REAL store module; the injection
    // seam is used here only to PROVE it was actually invoked, not to fake behavior.
    const openParentStore = (o) => { opens++; return store.openStore(o); };

    // First sweep: verdict is 'stale' (not yet escalated). No nudgeCommand on the
    // descriptor -> pokeOrEscalate escalates immediately (no nudge phase).
    const verdict1 = { status: 'stale', staleSince: now - 10 * 60 * 1000, nudgeAttempts: 0, nudgedAt: null };
    const res1 = recovery.pokeOrEscalate(descriptor, verdict1, { home, now, env: JOURNAL_ENV }, { openParentStore });
    assert.strictEqual(res1.action, 'escalate');
    assert.strictEqual(opens, 1, 'the injected openParentStore was actually used');

    const s1 = store.openStore({ home, backend: 'journal', workspaceId: parentId });
    let msgs1;
    try { msgs1 = s1.listMessages(parentId, {}); } finally { s1.close(); }
    assert.strictEqual(msgs1.length, 1, 'exactly one escalation notice landed in the PARENT store');
    assert.match(msgs1[0].body, /child-x/);
    assert.match(msgs1[0].body, /idle/);

    // Re-read the REAL persisted verdict (what the next automatic sweep would
    // observe) and call pokeOrEscalate again — simulating a repeat sweep tick.
    const verdictPath = liveness.livenessPathFor(childId, home);
    const verdict2 = JSON.parse(fs.readFileSync(verdictPath, 'utf8'));
    assert.strictEqual(verdict2.status, 'escalated', 'the escalation transition was actually persisted');

    const res2 = recovery.pokeOrEscalate(descriptor, verdict2, { home, now: now + 1000, env: JOURNAL_ENV }, { openParentStore });
    assert.strictEqual(res2.action, 'escalate');

    const s2 = store.openStore({ home, backend: 'journal', workspaceId: parentId });
    let msgs2;
    try { msgs2 = s2.listMessages(parentId, {}); } finally { s2.close(); }
    assert.strictEqual(msgs2.length, 1, 'idempotent: a repeat sweep does NOT duplicate the parent notice');
  } finally { H.rm(home); }
});

// ============================================================================
// 4. PERIODIC DAEMON HEARTBEAT — with a stubbed run() returning NO messages,
//    runIngestLoop still writes a fresh ingestHeartbeatPath (#22: liveness is
//    independent of message arrival, not just "did anything get inserted").
// ============================================================================

test('4 PERIODIC HEARTBEAT: zero messages inserted across 3 bounded cycles, heartbeat file still written fresh', () => {
  const home = H.makeHome();
  try {
    const worktree = mkWorktree(home, 'repo');
    const id = installIngest.primaryWorkspaceId(worktree);
    const hash = installIngest.worktreeHash(worktree);

    const before = Date.now();
    const run = () => ({ ok: true, raw: '[]' }); // native queue empty on every poll
    const res = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: id, worktree, maxIterations: 3, run, sleep: () => {},
    });
    assert.strictEqual(res.started, true);
    assert.strictEqual(res.stats.iterations, 3, 'the loop actually ran 3 bounded cycles');
    assert.strictEqual(res.stats.inserted, 0, 'zero messages arrived this run (proves independence from message count)');

    const hbPath = ingest.ingestHeartbeatPath(home, hash);
    assert.ok(fs.existsSync(hbPath),
      'the daemon liveness heartbeat is written even on an all-empty run (#22: freshness independent of message arrival)');
    const hb = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
    assert.strictEqual(hb.workspaceId, id);
    assert.strictEqual(hb.workingDir, worktree);
    assert.ok(hb.ts >= before && hb.ts - before < 10000, 'heartbeat timestamp is fresh (written this run), not stale/pre-existing');
  } finally { H.rm(home); }
});

// ============================================================================
// 5. READ-GUARD END TO END — raw inbox/store surfaces blocked via BOTH the
//    Read tool (inbox-read-guard.js) and Bash `cat` (command-guard.js's
//    companion redirect); summary.json/cursors/* allowed; native `read-messages`
//    still blocks unconditionally under DevSwarm.
// ============================================================================

test('5 READ-GUARD: raw inbox/store blocked (Read tool + Bash cat); summary.json/cursors allowed; native read-messages blocked', () => {
  const home = H.makeHome();
  try {
    const inboxFile = path.join(H.swarmRoot(home), 'inbox', 'x.ndjson');
    const storeDb = path.join(H.swarmRoot(home), 'store', 'devswarm.db');
    const summaryFile = H.summaryPath(home);
    const cursorFile = path.join(H.swarmRoot(home), 'cursors', 'x.json');

    // --- Read tool (hooks/inbox-read-guard.js) ---
    const readInbox = testHook('inbox-read-guard.js',
      { tool_name: 'Read', tool_input: { file_path: inboxFile }, cwd: home },
      { home, env: PRIMARY_ENV });
    assert.strictEqual(readInbox.status, 2, `raw inbox Read must block; stdout=${readInbox.stdout}`);
    assert.ok(readInbox.json && readInbox.json.decision === 'block');
    assert.match(readInbox.json.reason, /DEVSWARM INBOX READ-GUARD/);

    const readStore = testHook('inbox-read-guard.js',
      { tool_name: 'Read', tool_input: { file_path: storeDb }, cwd: home },
      { home, env: PRIMARY_ENV });
    assert.strictEqual(readStore.status, 2, `raw store .db Read must block; stdout=${readStore.stdout}`);
    assert.ok(readStore.json && readStore.json.decision === 'block');
    assert.match(readStore.json.reason, /DEVSWARM STORE READ-GUARD/);

    const readSummary = testHook('inbox-read-guard.js',
      { tool_name: 'Read', tool_input: { file_path: summaryFile }, cwd: home },
      { home, env: PRIMARY_ENV });
    assert.strictEqual(readSummary.status, 0, `summary.json Read must be allowed; stdout=${readSummary.stdout}`);
    assert.strictEqual(readSummary.stdout, '');

    const readCursor = testHook('inbox-read-guard.js',
      { tool_name: 'Read', tool_input: { file_path: cursorFile }, cwd: home },
      { home, env: PRIMARY_ENV });
    assert.strictEqual(readCursor.status, 0, `cursors/* Read must be allowed; stdout=${readCursor.stdout}`);

    // --- Bash (hooks/command-guard.js) — the companion `cat` bypass this
    //     Bash-verb-only guard would otherwise miss, plus the unconditional
    //     native-read redirect. ---
    const catStore = testHook('command-guard.js', bashPayload('cat ' + storeDb), { home, env: COORD_ENV });
    assert.strictEqual(catStore.status, 2, `cat of the raw store db must block; stdout=${catStore.stdout}`);
    assert.ok(catStore.json && catStore.json.decision === 'block');
    assert.match(catStore.json.reason, /DEVSWARM STORE READ-GUARD/);

    const readMessages = testHook('command-guard.js', bashPayload('hivecontrol workspace read-messages'),
      { home, env: COORD_ENV });
    assert.strictEqual(readMessages.status, 2, `read-messages must block unconditionally; stdout=${readMessages.stdout}`);
    assert.ok(readMessages.json && readMessages.json.decision === 'block');
    assert.match(readMessages.json.reason, /COORDINATOR-READ REDIRECT/);
  } finally { H.rm(home); }
});

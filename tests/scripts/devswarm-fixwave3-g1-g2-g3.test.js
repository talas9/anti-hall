'use strict';
// Fix Wave 3 (DevSwarm P0 batch, Round 3 verdict — HOLD, Codex found a NEW P0
// that Wave 2's own F5 null-guard created). All findings live in the SAME
// shared `foldSiblingGapRows(rows, seenHashes)` helper (scripts/devswarm.js,
// ~line 1437) that Fix Wave 2's test file (devswarm-fixwave2-f1-f2-f3-f4-f5
// .test.js) covers — see that file for F1-F5's own history.
//
// G1 — P0, NEW. Wave 2's F5 null-guard (`if (!row) { gapSeen = true;
// continue; }`) never counted a corrupted/null row toward `deliveredCount`.
// The sibling ack target was `part.cursor + deliveredCount` — for a window
// `[null-hole, direct]` that is `part.cursor + 0`, so the cursor NEVER
// advances past the hole. Consequences: `count` reports `unreadTotal: 0`
// (nothing counted as delivered), which `hooks/lib/devswarm-wake.js`'s
// drain-gate text told an automated agent meant "stop, nothing to do" —
// automatic drain never runs. A MANUAL `read-primary`/`ack` computes the
// SAME zero-advance ack target, so the cursor never moves past the hole
// either — the mailbox is a PERMANENT, operator-unrecoverable wedge,
// silently reported as empty.
//
// REACHABILITY (triple-confirmed, not assumed): a literal `null` array
// element can NOT actually reach `foldSiblingGapRows` through either real
// production call site today:
//   - Both call sites tag each sibling row via
//     `.map((r, i) => Object.assign({ partitionId: pid }, r, {...}))`
//     (scripts/devswarm.js ~line 4029 for cmdInboxMessages/read-primary/
//     peek-primary, ~line 4557 for count/read/ack) — `Object.assign(t, null,
//     s2)` treats a `null`/`undefined` source as contributing NO properties
//     (never throws), so a hole is silently converted into a harmless STUB
//     object (`{partitionId, ...}`, no mtype/sender/recipient) BEFORE the
//     fold ever runs. `isForwardableRow` on that stub returns `false`
//     (companion/lib/devswarm-noise.js), so it is treated as an ordinary
//     (temporary, safe) gap trigger, not the permanent-wedge case.
//   - Even if that sanitizing map were bypassed, the JOURNAL/JSON backend's
//     own `listMessages` (companion/lib/devswarm-store.js ~line 1288) does
//     `for (const row of readAll(files.messages)) { if
//     (String(row.workspaceId) !== wid) ... }` — a literal `null` LINE in
//     the underlying store file would CRASH there (`row.workspaceId` throws
//     on `null`) before ever reaching a caller, let alone `rows`. The sqlite
//     backend's `listMessages` (~line 727) builds its output via `.push()`
//     from real DB rows only — it structurally cannot yield `null` either.
// The Round-3 Reviewer's "possible by construction but currently
// unreachable" verdict is therefore CORRECT, on evidence beyond what that
// review apparently cited. Per this batch's explicit instruction, the fix is
// applied anyway: `foldSiblingGapRows` is the single shared, general-purpose
// helper both read surfaces funnel through, and an operator-unrecoverable
// wedge shape with zero real-world cost to close is worth closing regardless
// of today's reachability (this batch has been wrong about "unreachable"
// twice already). This file's G1 test therefore drives the REAL end-to-end
// `count` -> `read-primary` -> `count` -> `read-primary` flow through the
// REAL cmdInboxMessages/cmdInbox code, with ONLY the store's `listMessages`
// return value intercepted (a monkeypatch on the shared
// `devswarm-store.js` module singleton, restored in a `finally`) to inject
// a hole as the literal first element of one sibling partition's unread
// window — everything above the store (fold, ack arithmetic, `count`'s
// `unreadTotal`/`meshGapWithheld`, the wake-relevant fields) is exercised
// for real.
//
// FIX CHOSEN: option (a), track a separate consumed/ackable prefix length
// (`consumedCount`/`consumedThrough`) alongside `deliveredRows`/
// `deliveredCount` in `foldSiblingGapRows` — NOT option (b) (a hard
// corruption state bypassing the wake-stop). Rationale: (a) fixes the ROOT
// CAUSE (a corrupt/gap row can now be safely acked PAST, since there both
// was never a real message there and it is unrecoverable either way) so the
// mailbox ALWAYS makes progress on the next read/ack — no operator action
// can be permanently blocked. (b) alone would only silence the symptom
// (never look silently empty) without fixing the underlying non-progress.
// Both consequences named in the finding are addressed: the wedge itself is
// fixed via (a) in `scripts/devswarm.js`, and the automated-wake blind spot
// is ALSO closed (cheaply, additively) by teaching
// `hooks/lib/devswarm-wake.js`'s drain-gate text to stop ONLY when
// `unreadTotal` is 0 AND `meshGapWithheld` is not `true` — see
// tests/hooks/devswarm-wake.test.js for that half's own coverage.
//
// G2 — P1, NEW. `deliveredRows` was NOT a contiguous PHYSICAL index-prefix
// of a partition's raw rows whenever the defensive hash-dedup guard fires
// (`if (row.hash && seenHashes.has(row.hash)) continue;` — never pushed,
// never counted). `[deduped row, deliverable row]` delivered only physical
// row 1 (`deliveredCount: 1`), and the ack target `part.cursor +
// deliveredCount` then advanced past only physical row 0 — UNDER-covering
// the two physical rows actually resolved. Safe direction (under-ack,
// re-delivers on the next read — never data loss) but it disproves Wave 2's
// own stated invariant that `deliveredRows` is a genuine index-prefix.
//
// REACHABILITY (triple-confirmed, corrected after an initial WRONG read):
// this file originally claimed the journal backend's per-workspace-only
// READ-time dedupe in `listMessages` (~line 1288) made a cross-partition
// duplicate reachable there. That is FALSE — verified live by seeding the
// scenario via real `appendMeshMessage` calls and observing the second
// insert silently vanish. The actual guard is at INSERT time, and it is
// STORE-WIDE on BOTH backends: sqlite's `appendMeshRow` runs `INSERT OR
// IGNORE ... UNIQUE(hash)` (devswarm-store.js ~line 525); the journal
// backend's `appendMeshRow` (~line 1078) does `for (const row of
// readAll(files.messages)) { if (row.hash === hash) return { inserted:
// false, seq: null }; }` — a scan over the ENTIRE store, not scoped to
// `workspaceId`. So `appendMeshRow`/`appendMeshMessage` (the only sanctioned
// insert path on EITHER backend) cannot itself create a genuine
// cross-partition hash duplicate — the second insert is silently dropped
// before it ever reaches a partition. The dedup guard in
// `foldSiblingGapRows` is therefore ALSO defensive/unreachable through the
// normal insert path on both backends, just like G1. It still could, in
// principle, be reached by a write that bypasses `appendMeshRow` entirely
// (a raw low-level file/DB mutation — a migration, or a reconciliation bug
// writing directly to the underlying store) — not ruled out, just not
// exercised by any code this batch has reviewed. Given that (and this
// batch's now-two-for-two record of "unreachable" claims being wrong or, as
// here, initially mis-verified), the fix is kept and this file's G2 test
// drives the SAME kind of store-layer interception G1 uses (monkeypatching
// `listMessages`'s return value, restored in a `finally`) rather than a
// real duplicate insert — the only honest way to exercise this path at all.
//
// FIX CHOSEN: option (a) — the SAME `consumedCount`/`consumedThrough`
// mechanism as G1 (one fix, not two): the ack loops now derive the PHYSICAL
// ack target from `consumedThrough`/`consumedCount`, which count a resolved
// dedup skip as consumed (it correctly advances the cursor past it) without
// counting it as delivered (it is never re-shown to the caller). Option (b)
// (delete the dedup guard entirely, relying on the insert-time uniqueness
// on both backends) was considered and REJECTED anyway: the guard is cheap,
// and the insert-time uniqueness check is enforced by `appendMeshRow`
// specifically — any write path that bypasses it (see REACHABILITY above)
// would make (b) unsafe. Keeping the guard costs nothing and closes that
// door regardless of whether such a path exists today.
//
// G3 — P1, NEW. No test exercised `read-primary` acking a gapped SIBLING
// window before this file (the Fix Wave 2 suite's inbox-ack test used
// `inbox ack`, not `read-primary`; its peek-primary test never asserted
// on the sibling cursor; its `read-primary` test used two of `id`'s OWN
// partition rows, never a sibling). Three wrong variants could pass that
// gap: (1) `cmdInboxMessages` subtracts a flat "1" from `deliveredCount`
// whenever ANY gap exists, regardless of how many rows were actually
// consumed; (2) `read-primary` drops the gap-trigger row from its RETURNED
// payload while still counting it as delivered — acking mail the caller
// never actually saw; (3) the G2 dedup-index drift, scoped specifically to
// the `read-primary` surface (not just `inbox ack`/F1's own coverage). This
// file's G3 test asserts all FOUR properties Fix Wave 3 requires in one
// place — the trigger body IS in the returned payload, the sibling cursor
// advances by EXACTLY one, the withheld suffix survives, and the next read
// delivers it completely — then proves each of the three variants above is
// killed by mutating the real source and confirming this test goes RED.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DEVSWARM_PATH = path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js');
const cli = require(DEVSWARM_PATH);
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const livenessLib = require('../../plugins/anti-hall/companion/lib/liveness.js');
const mutantKit = require('./lib/devswarm-mutant-kit.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fixwave3-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fixwave3-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

// Fix Wave 7 Item 2: `sessionId` defaults to a well-formed real session
// (unchanged, pre-existing behavior) — pass an `unclaimed:`-prefixed one
// explicitly for a fixture that must model a GENUINE orphan (register-only
// phantom, never claimed by a real session) under the new
// isSiblingPartitionLive gate (companion/lib/liveness.js): a well-formed
// `--session` string alone no longer proves liveness OR death — see that
// function's own header for why (a real session with no heartbeat/transcript
// signal at all now correctly reads as LIVE, not orphaned, since absence of
// a signal is never evidence of death).
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

// seedPartition: forwardable ("direct") rows, appended straight into `toId`'s
// own partition (bypasses send's resolveMeshTarget/fold entirely).
function seedPartition(home, repoDir, toId, rows) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  assert.ok(repoKey, 'repoKey must resolve for a real git repo');
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    for (const row of rows) {
      const fields = { from: row.from || 'sender', to: toId, type: 'direct', urgency: row.urgency || 'normal', message: row.body, timestamp: row.ts };
      const hash = row.hash || storeLib.meshMessageHash(fields);
      storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash }));
    }
  } finally { s.close(); }
  return repoKey;
}

// seedNativeRow: a non-forwardable native-shaped row (mtype/sender/recipient
// all NULL — mirrors devswarm-ingest.js's bare appendMessage path).
function seedNativeRow(home, repoDir, toId, row) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    s.appendMeshRow({
      workspaceId: toId, ts: row.ts, hash: row.hash || ('native:' + toId + ':' + row.ts), body: row.body,
      sender: null, recipient: null, mtype: null, urgency: null, isHeartbeat: false, needsReply: false,
    });
  } finally { s.close(); }
}

// Wave 6 (live-sibling ack gate) fixture helpers ----------------------------
//
// G2/G3 originally registered BOTH `primary-gN` and `sibling-gN` with their
// own distinct well-formed `--session s-<id>` and nothing else — under the
// PRE-Wave-6 code (no liveness check on the sibling-ack path at all) that
// was harmless, but it also means the fixture, unmodified, models TWO LIVE
// children sharing one canonical worktree: exactly the P0 shape (one live
// child silently acking a DIFFERENT live child's own mail) Wave 6 closes.
// Post-Wave-6, `cmdInboxMessages`'s sibling-ack loop gates the cursor WRITE
// on `hasFreshHeartbeat(part.id, home, {now})` (companion/lib/liveness.js) —
// the raw `heartbeats/<id>.json` `ts`, NOT `--session` well-formedness (a
// `--session` string proves nothing about whether a process is actually
// running; see Wave 6's STEP 1 feasibility note in scripts/devswarm.js).
// `register()` alone never writes a heartbeat file, so G2/G3's ORIGINAL
// fixtures were incidentally already "no heartbeat = orphan" under the new
// gate — this rewrite makes that EXPLICIT (rather than relying on an
// absence) by giving the sibling a heartbeat that once existed and has since
// expired well past `DEFAULT_HEARTBEAT_FRESH_MS` (15 min): the genuinely
// dead/stale/unreaped case cross-partition drain+ack exists for, not merely
// "a partition that never happened to heartbeat".
function writeHeartbeatFile(home, id, ts) {
  const p = livenessLib.heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ id, ts }));
}
function markSiblingOrphaned(home, id, now) {
  writeHeartbeatFile(home, id, (now || Date.now()) - (livenessLib.DEFAULT_HEARTBEAT_FRESH_MS + 5 * 60 * 1000));
}
function markSiblingLive(home, id, now) {
  writeHeartbeatFile(home, id, now || Date.now());
}

function readCursorFile(home, repo, id) {
  const repoKey = repokey.repoKeyForWorktree(repo);
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { return s.cursorValue(id); } finally { s.close(); }
}

// withMutant: byte-exact string-replace, applied to an ISOLATED SCRATCH
// COPY of devswarm.js (never the live file — see
// tests/scripts/lib/devswarm-mutant-kit.js for why), used only transiently
// inside a single test to prove a specific assertion is a real RED/GREEN
// pair. The scratch copy is discarded when `fn` returns; the live source is
// proven untouched afterward. `fn` also receives the scratch `copy`
// ({dir, devswarmPath}) so a caller can compose a FURTHER mutation onto the
// same copy (see the "G1 mutation check" test below, nested inside
// withNullPreservingMaps).
function withMutant(oldStr, newStr, fn) {
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  mutantKit.withMutant(oldStr, newStr, fn, { prefix: 'anti-hall-fixwave3' });
  mutantKit.assertLiveUntouched(liveBefore, assert);
}

// withInjectedHole: monkeypatches the shared devswarm-store.js module
// singleton's `openStore` so that every store handle it returns, for the
// lifetime of `fn`, prepends a literal `null` to `id`'s unread window as its
// FIRST element (models a store-layer hole/corruption at the point
// `listMessages` returns its rows — see the G1 REACHABILITY note above for
// why this can't be reached through the real store implementation itself,
// and why intercepting exactly here is the most honest way to drive a real
// end-to-end flow through the fix). The fake hole occupies exactly ONE unit
// of the EXTERNAL ack-cursor's numbering that corresponds to no real
// physical row, so every subsequent call translates the caller's
// `sinceCursor` back into the REAL store's own numbering by subtracting 1
// (once the external cursor has advanced past the fake hole) — this keeps
// the REAL underlying data consistent across repeated calls, exactly as a
// real corrupt slot would (a genuine hole "uses up" one cursor position
// without ever having been real data). Restored in a `finally`.
function withInjectedHole(id, fn) {
  const realOpenStore = storeLib.openStore;
  storeLib.openStore = function (opts) {
    const s = realOpenStore(opts);
    const realListMessages = s.listMessages.bind(s);
    s.listMessages = function (pid, o) {
      if (String(pid) !== String(id)) return realListMessages(pid, o);
      const since = (o && Number.isFinite(o.sinceCursor)) ? o.sinceCursor : 0;
      if (since <= 0) {
        const rows = realListMessages(pid, { sinceCursor: 0 });
        return rows.length ? [null].concat(rows) : rows;
      }
      return realListMessages(pid, Object.assign({}, o, { sinceCursor: since - 1 }));
    };
    return s;
  };
  try {
    fn();
  } finally {
    storeLib.openStore = realOpenStore;
  }
}

// withNullPreservingMaps: mutates BOTH production call sites' sibling-row
// tagging maps (scripts/devswarm.js ~line 4029 for cmdInboxMessages/
// read-primary/peek-primary, ~line 4557 for count/read/ack) so a literal
// `null` element survives instead of being silently sanitized into a
// harmless stub object by `Object.assign({...}, r, ...)` (`Object.assign`
// treats a `null`/`undefined` SOURCE as contributing no properties, per
// spec — see this file's G1 REACHABILITY note). This is what makes a
// TRUE end-to-end null actually reach `foldSiblingGapRows` through the
// real command dispatch, ack arithmetic, and `count`/`read-primary`
// output — everything except this one, explicitly-documented bypass of
// otherwise-real sanitizing behavior is exercised for real. Reverts and
// diffs byte-identical, same contract as `withMutant`.
// Same isolated-scratch-copy contract as withMutant above. `fn` receives
// (mutatedCli, copy) — several callers (see "G1 mutation check" below)
// apply a SECOND mutation on top of `copy.devswarmPath` to reproduce a
// compound regression; since the copy is single-use and discarded by this
// function's own `finally`, composing further mutations onto it needs no
// restore step of its own.
function withNullPreservingMaps(fn) {
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  const site1Old = ".map((r, i) => Object.assign({ partitionId: pid }, r, { __srcId: 'sibling:' + pid, __srcIdx: i }));";
  const site1New = ".map((r, i) => (r == null ? null : Object.assign({ partitionId: pid }, r, { __srcId: 'sibling:' + pid, __srcIdx: i })));";
  const site2Old = '.map((r) => Object.assign({ partitionId: pid }, r));';
  const site2New = '.map((r) => (r == null ? null : Object.assign({ partitionId: pid }, r)));';
  assert.ok(liveBefore.includes(site1Old), 'site1 (cmdInboxMessages) sibling-tagging map not found verbatim');
  assert.ok(liveBefore.includes(site2Old), 'site2 (count/read/ack) sibling-tagging map not found verbatim');
  const copy = mutantKit.createCopy('anti-hall-fixwave3-nullmap');
  try {
    mutantKit.mutateWith(copy.devswarmPath, (src) => src.replace(site1Old, site1New).replace(site2Old, site2New));
    fn(mutantKit.requireFresh(copy.devswarmPath), copy);
  } finally {
    mutantKit.discardCopy(copy);
  }
  mutantKit.assertLiveUntouched(liveBefore, assert);
}

// ---------------------------------------------------------------------------
// G1 — corrupted/null sibling row permanently wedges a mailbox (P0)
// ---------------------------------------------------------------------------

test('G1 RED/GREEN (end-to-end): a null/hole sibling row must not permanently wedge the mailbox — count is not silently 0, and read-primary makes real progress', () => {
  withNullPreservingMaps((mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('g1');
    try {
      register(home, repo, 'primary-g1', undefined);
      register(home, repo, 'sibling-g1', undefined, 'unclaimed:sibling-g1'); // Fix Wave 7 Item 2: genuine orphan fixture (never claimed by a real session)
      seedPartition(home, repo, 'sibling-g1', [{ body: 'G1row-direct', ts: 2000, urgency: null }]);

      withInjectedHole('sibling-g1', () => {
        // Call 1: `count`, with the hole still in place.
        const c1 = mutatedCli.run(['inbox', 'count', 'primary-g1'], ctx(home, { cwd: repo }));
        assert.equal(c1.result.ok, true, JSON.stringify(c1.result));
        // The hole itself delivers nothing this call — unreadTotal is
        // genuinely 0 on this FIRST call.
        assert.equal(c1.result.unreadTotal, 0, 'the hole itself delivers nothing this call — unreadTotal is genuinely 0 on this FIRST call');
        // THE FIX (the wake-blind-spot half): `count` must carry the honesty
        // signal a caller (or hooks/lib/devswarm-wake.js's drain-gate text)
        // needs to avoid treating this as "nothing to do" — a 0 here is
        // never SILENT.
        assert.equal(c1.result.meshGapWithheld, true, 'count must flag that something is withheld — a 0 here must never be silent');
        assert.equal(c1.result.meshGapWithheldCount, 1);

        // Call 2: `read-primary` — must consume (ack past) the hole even
        // though nothing is delivered yet.
        const r1 = mutatedCli.run(['inbox', 'read-primary', 'primary-g1', '--ack-as-owner'], ctx(home, { cwd: repo }));
        assert.equal(r1.result.ok, true, JSON.stringify(r1.result));
        assert.deepEqual(r1.result.messages.map((m) => m.body), [], 'first read-primary: nothing delivered yet (the hole still poisons this window)');

        const sibCursor = readCursorFile(home, repo, 'sibling-g1');
        assert.equal(sibCursor, 1, 'THE FIX: the ack must advance past the hole itself (1 physical row consumed) — this is what breaks the wedge');

        // Call 3: `count` again — THE FIX: the hole is now behind the
        // cursor, so the window is clean and G1row is reported normally.
        const c2 = mutatedCli.run(['inbox', 'count', 'primary-g1'], ctx(home, { cwd: repo }));
        assert.equal(c2.result.unreadTotal, 1, 'THE FIX: after the hole is consumed, the next count sees G1row as ordinary unread mail — no residual gap');
        assert.equal(c2.result.meshGapWithheld, undefined, 'no gap remains — the honesty flag must not be set once the hole is gone');

        // Call 4: `read-primary` again — THE FIX: real, permanent progress.
        const r2 = mutatedCli.run(['inbox', 'read-primary', 'primary-g1', '--ack-as-owner'], ctx(home, { cwd: repo }));
        assert.deepEqual(r2.result.messages.map((m) => m.body), ['G1row-direct'], 'THE FIX: the second read-primary DELIVERS G1row — the mailbox made real, permanent progress; the wedge is broken');
      });
    } finally { rm(home); rm(repo); }
  });
});

test('G1 mutation check: reverting the ack target to plain deliveredCount reproduces the permanent wedge', () => {
  withNullPreservingMaps((_nullPreservingCli, copy) => {
    const oldStr = 'const consumedThrough = Array.isArray(part.consumedThrough) ? part.consumedThrough : null;\n'
      + '        const physicalConsumed = (deliveredCount >= fullDeliveredCount && Number.isFinite(part.consumedCount))\n'
      + '          ? part.consumedCount\n'
      + '          : (deliveredCount <= 0\n'
      + '            ? 0\n'
      + '            : (consumedThrough && Number.isFinite(consumedThrough[deliveredCount - 1])\n'
      + '              ? consumedThrough[deliveredCount - 1]\n'
      + '              : deliveredCount));\n'
      + '        const ackTarget = part.cursor + physicalConsumed;';
    assert.ok(fs.readFileSync(copy.devswarmPath, 'utf8').includes(oldStr), 'G1 fix block not found verbatim in cmdInboxMessages ack loop (under the null-preserving-maps mutant)');
    const buggyStr = 'const ackTarget = part.cursor + deliveredCount;';
    // Compose a SECOND mutation onto the SAME scratch copy (rather than
    // calling the module-level `withMutant`, which would spin up its own
    // independent copy without the null-preserving-maps mutation already
    // applied) — this test needs BOTH mutations together to reproduce the
    // real end-to-end regression.
    mutantKit.mutate(copy.devswarmPath, oldStr, buggyStr);
    const mutatedCli = mutantKit.requireFresh(copy.devswarmPath);
    const home = tmpHome();
    const repo = makeGitRepo('g1-mutant');
    try {
      register(home, repo, 'primary-g1m', undefined);
      register(home, repo, 'sibling-g1m', undefined, 'unclaimed:sibling-g1m'); // Fix Wave 7 Item 2: genuine orphan fixture (never claimed by a real session)
      seedPartition(home, repo, 'sibling-g1m', [{ body: 'G1row-direct', ts: 2000, urgency: null }]);

      withInjectedHole('sibling-g1m', () => {
        mutatedCli.run(['inbox', 'read-primary', 'primary-g1m', '--ack-as-owner'], ctx(home, { cwd: repo }));
        const sibCursor = readCursorFile(home, repo, 'sibling-g1m');
        assert.equal(sibCursor, 0, 'BUGGY (pre-G1-fix): the cursor never advances past the hole — this IS the permanent wedge');

        // A second read-primary call — WITHOUT the fix, this must ALSO
        // make zero progress (the hole recurs at the same position every
        // time).
        const r2 = mutatedCli.run(['inbox', 'read-primary', 'primary-g1m', '--ack-as-owner'], ctx(home, { cwd: repo }));
        assert.deepEqual(r2.result.messages.map((m) => m.body), [], 'BUGGY: G1row is STILL never delivered on a second call — reproduces "nothing an operator can do recovers it"');
      });
    } finally { rm(home); rm(repo); }
  });
});

// ---------------------------------------------------------------------------
// G2 — deliveredRows is not a physical index-prefix under hash-dedup (P1)
// ---------------------------------------------------------------------------

test('G2 unit: foldSiblingGapRows consumedCount/consumedThrough correctly account for a dedup-skipped physical row', () => {
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  const anchor = 'run, parseArgs, one, many, csvList,';
  assert.ok(liveBefore.includes(anchor), 'module.exports anchor not found verbatim');
  const copy = mutantKit.createCopy('anti-hall-fixwave3-g2-export');
  try {
    mutantKit.mutate(copy.devswarmPath, anchor, anchor + '\n  foldSiblingGapRows,');
    const mutatedCli = mutantKit.requireFresh(copy.devswarmPath);
    const dupHash = 'forced-dup-hash-g2';
    const rows = [
      { hash: dupHash, body: 'dedup-row', mtype: 'direct', sender: 'a', recipient: 'b' },
      { hash: 'unique-hash-g2', body: 'deliverable-row', mtype: 'direct', sender: 'a', recipient: 'b' },
    ];
    const seenHashes = new Set([dupHash]); // simulates the hash already seen in `id`'s own store rows
    const result = mutatedCli.foldSiblingGapRows(rows, seenHashes);
    assert.deepEqual(result.deliveredRows.map((r) => r.body), ['deliverable-row'], 'only the non-dup row is delivered');
    assert.equal(result.deliveredCount, 1, 'deliveredCount reflects only what was actually delivered');
    assert.equal(result.consumedCount, 2, 'THE FIX: consumedCount must cover BOTH physical rows — the dedup skip is a resolved physical row too');
    assert.deepEqual(result.consumedThrough, [2], 'THE FIX: consumedThrough[0] (physical count through the 1st delivered row) must be 2, not 1 — the dedup row sits physically BEFORE it');
  } finally {
    mutantKit.discardCopy(copy);
  }
  mutantKit.assertLiveUntouched(liveBefore, assert);
});

// withInjectedDuplicate: same store-layer-interception technique as
// `withInjectedHole` above (see this file's G2 REACHABILITY note for why a
// real duplicate-hash `appendMeshMessage` insert cannot reach this scenario
// at all — the insert itself is silently dropped, store-wide, on BOTH
// backends). Prepends `dupRow` (a full, non-null row object — it survives
// the production `.map(Object.assign(...))` sanitizer unmodified, unlike
// G1's literal `null`) to `id`'s unread window, with the SAME cursor-space
// translation `withInjectedHole` uses so repeated calls stay consistent
// with the real underlying (single-row) data.
function withInjectedDuplicate(id, dupRow, fn) {
  const realOpenStore = storeLib.openStore;
  storeLib.openStore = function (opts) {
    const s = realOpenStore(opts);
    const realListMessages = s.listMessages.bind(s);
    s.listMessages = function (pid, o) {
      if (String(pid) !== String(id)) return realListMessages(pid, o);
      const since = (o && Number.isFinite(o.sinceCursor)) ? o.sinceCursor : 0;
      if (since <= 0) {
        const rows = realListMessages(pid, { sinceCursor: 0 });
        return [dupRow].concat(rows);
      }
      return realListMessages(pid, Object.assign({}, o, { sinceCursor: since - 1 }));
    };
    return s;
  };
  try {
    fn();
  } finally {
    storeLib.openStore = realOpenStore;
  }
}

test('G2 RED/GREEN (end-to-end): a cross-partition hash duplicate must not leave its physical predecessor un-acked', () => {
  const home = tmpHome();
  const repo = makeGitRepo('g2');
  try {
    register(home, repo, 'primary-g2', undefined);
    register(home, repo, 'sibling-g2', undefined, 'unclaimed:sibling-g2'); // Fix Wave 7 Item 2: genuine orphan fixture (never claimed by a real session)
    markSiblingOrphaned(home, 'sibling-g2'); // explicit orphan fixture — see helper comment above
    const dupHash = 'forced-cross-partition-dup-g2';
    // `id`'s OWN partition carries a row with this hash — seeds `seenHashes`.
    seedPartition(home, repo, 'primary-g2', [{ body: 'own-row', ts: 500, hash: dupHash }]);
    // The sibling's REAL data is just one genuinely new row; the duplicate
    // is injected via `withInjectedDuplicate` (see REACHABILITY above).
    seedPartition(home, repo, 'sibling-g2', [{ body: 'sib-new-row', ts: 2000 }]);
    const dupRow = {
      index: 0, seq: 0, ts: 1000, hash: dupHash, body: 'sib-dup-row',
      sender: 'sender', recipient: 'sibling-g2', mtype: 'direct', urgency: 'normal',
      isHeartbeat: false, needsReply: false, storeSeq: 0,
    };

    withInjectedDuplicate('sibling-g2', dupRow, () => {
      const r1 = cli.run(['inbox', 'read-primary', 'primary-g2', '--ack-as-owner'], ctx(home, { cwd: repo }));
      assert.equal(r1.result.ok, true, JSON.stringify(r1.result));
      const bodies = r1.result.messages.map((m) => m.body).sort();
      assert.deepEqual(bodies, ['own-row', 'sib-new-row'], 'THE FIX: the dedup row is silently skipped (never re-delivered), the genuinely new row IS delivered');

      const sibCursor = readCursorFile(home, repo, 'sibling-g2');
      assert.equal(sibCursor, 2, 'THE FIX: the ack must cover BOTH physical sibling rows (the dedup skip AND the delivered row) — under the bug this was 1, under-acking and leaving sib-dup-row to be re-evaluated forever');

      // A second read-primary must see nothing new (no redelivery, no stall).
      const r2 = cli.run(['inbox', 'read-primary', 'primary-g2', '--ack-as-owner'], ctx(home, { cwd: repo }));
      assert.deepEqual(r2.result.messages, [], 'second read: nothing left — the fix does not under- or over-deliver');
    });
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// G3 — no test previously exercised read-primary acking a gapped sibling
// window (P1)
// ---------------------------------------------------------------------------

function seedG3GapWindow(home, repo, siblingId) {
  seedNativeRow(home, repo, siblingId, { body: 'N0-native-trigger', ts: 1000 });
  seedPartition(home, repo, siblingId, [{ body: 'G3row-withheld', ts: 2000, urgency: null }]);
}

test('G3 RED/GREEN: read-primary acking a gapped sibling window — trigger delivered, cursor advances by exactly one, withheld suffix survives and is delivered next read', () => {
  const home = tmpHome();
  const repo = makeGitRepo('g3');
  try {
    register(home, repo, 'primary-g3', undefined);
    register(home, repo, 'sibling-g3', undefined, 'unclaimed:sibling-g3'); // Fix Wave 7 Item 2: genuine orphan fixture (never claimed by a real session)
    markSiblingOrphaned(home, 'sibling-g3'); // explicit orphan fixture — see helper comment above
    seedG3GapWindow(home, repo, 'sibling-g3');

    const r1 = cli.run(['inbox', 'read-primary', 'primary-g3', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r1.result.ok, true, JSON.stringify(r1.result));
    const bodies1 = r1.result.messages.map((m) => m.body);
    // (1) the trigger body IS in the returned payload
    assert.ok(bodies1.includes('N0-native-trigger'), 'the gap-trigger row must be delivered, not just acked past unseen');
    assert.ok(!bodies1.includes('G3row-withheld'), 'the withheld row must NOT be in this call\'s payload');

    // (2) the sibling cursor advances by EXACTLY one
    const sibCursor = readCursorFile(home, repo, 'sibling-g3');
    assert.equal(sibCursor, 1, 'the ack must advance the sibling cursor by exactly one physical row (the trigger), never zero and never two');

    // (3) the withheld suffix survives (still reachable directly)
    const direct = cli.run(['inbox', 'messages', 'sibling-g3'], ctx(home, { cwd: repo }));
    assert.ok(direct.result.messages.some((m) => m.body === 'G3row-withheld'), 'G3row must still be reachable by reading the sibling directly — never lost');

    // (4) the next read delivers it completely
    const r2 = cli.run(['inbox', 'read-primary', 'primary-g3', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.deepEqual(r2.result.messages.map((m) => m.body), ['G3row-withheld'], 'the next read-primary must deliver the previously-withheld row, completely');
  } finally { rm(home); rm(repo); }
});

test('G3 mutation check (variant 1): subtracting a flat "1" from deliveredCount whenever any gap exists (instead of the real physical count) breaks the exactly-one cursor advance', () => {
  const oldStr = 'const consumedThrough = Array.isArray(part.consumedThrough) ? part.consumedThrough : null;\n'
    + '        const physicalConsumed = (deliveredCount >= fullDeliveredCount && Number.isFinite(part.consumedCount))\n'
    + '          ? part.consumedCount\n'
    + '          : (deliveredCount <= 0\n'
    + '            ? 0\n'
    + '            : (consumedThrough && Number.isFinite(consumedThrough[deliveredCount - 1])\n'
    + '              ? consumedThrough[deliveredCount - 1]\n'
    + '              : deliveredCount));\n'
    + '        const ackTarget = part.cursor + physicalConsumed;';
  assert.ok(fs.readFileSync(DEVSWARM_PATH, 'utf8').includes(oldStr), 'G1/G3 fix block not found verbatim');
  const buggyStr = 'const physicalConsumed = deliveredCount - (meshGapWithheldCount > 0 ? 1 : 0);\n'
    + '        const ackTarget = part.cursor + physicalConsumed;';
  withMutant(oldStr, buggyStr, (mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('g3-mutant1');
    try {
      register(home, repo, 'primary-g3m1', undefined);
      register(home, repo, 'sibling-g3m1', undefined, 'unclaimed:sibling-g3m1'); // Fix Wave 7 Item 2: genuine orphan fixture (never claimed by a real session)
      markSiblingOrphaned(home, 'sibling-g3m1'); // explicit orphan fixture — see helper comment above
      seedG3GapWindow(home, repo, 'sibling-g3m1');
      mutatedCli.run(['inbox', 'read-primary', 'primary-g3m1', '--ack-as-owner'], ctx(home, { cwd: repo }));
      const sibCursor = readCursorFile(home, repo, 'sibling-g3m1');
      assert.notEqual(sibCursor, 1, 'BUGGY variant 1: deliveredCount(1) - 1 = 0 — the cursor fails to advance at all, reproducing the wedge shape');
    } finally { rm(home); rm(repo); }
  });
});

test('G3 mutation check (variant 2): dropping the trigger row from the payload while keeping deliveredCount acks mail the caller never saw', () => {
  const oldStr = 'for (const row of folded.deliveredRows) {\n'
    + '          dedupedSiblingRows.push(row);\n'
    + '        }';
  assert.ok(fs.readFileSync(DEVSWARM_PATH, 'utf8').includes(oldStr), 'sibling payload-assembly loop not found verbatim');
  const buggyStr = 'for (let __i = 0; __i < folded.deliveredRows.length; __i++) {\n'
    + '          if (__i === 0) continue; // BUG: drop the trigger row from the payload\n'
    + '          dedupedSiblingRows.push(folded.deliveredRows[__i]);\n'
    + '        }';
  withMutant(oldStr, buggyStr, (mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('g3-mutant2');
    try {
      register(home, repo, 'primary-g3m2', undefined);
      register(home, repo, 'sibling-g3m2', undefined, 'unclaimed:sibling-g3m2'); // Fix Wave 7 Item 2: genuine orphan fixture (never claimed by a real session)
      markSiblingOrphaned(home, 'sibling-g3m2'); // explicit orphan fixture — see helper comment above
      seedG3GapWindow(home, repo, 'sibling-g3m2');
      const r1 = mutatedCli.run(['inbox', 'read-primary', 'primary-g3m2', '--ack-as-owner'], ctx(home, { cwd: repo }));
      const bodies1 = r1.result.messages.map((m) => m.body);
      assert.ok(!bodies1.includes('N0-native-trigger'), 'BUGGY variant 2: the trigger row is missing from the payload — the caller never saw it');
      const sibCursor = readCursorFile(home, repo, 'sibling-g3m2');
      assert.equal(sibCursor, 1, 'BUGGY variant 2: the cursor STILL advances past the trigger (deliveredCount unchanged) — mail was acked that the caller never received');
    } finally { rm(home); rm(repo); }
  });
});

test('G3 mutation check (variant 3): reverting the ack target to plain deliveredCount (the G2 dedup-index drift) on the read-primary surface', () => {
  const oldStr = 'const consumedThrough = Array.isArray(part.consumedThrough) ? part.consumedThrough : null;\n'
    + '        const physicalConsumed = (deliveredCount >= fullDeliveredCount && Number.isFinite(part.consumedCount))\n'
    + '          ? part.consumedCount\n'
    + '          : (deliveredCount <= 0\n'
    + '            ? 0\n'
    + '            : (consumedThrough && Number.isFinite(consumedThrough[deliveredCount - 1])\n'
    + '              ? consumedThrough[deliveredCount - 1]\n'
    + '              : deliveredCount));\n'
    + '        const ackTarget = part.cursor + physicalConsumed;';
  assert.ok(fs.readFileSync(DEVSWARM_PATH, 'utf8').includes(oldStr), 'G1/G3 fix block not found verbatim');
  const buggyStr = 'const ackTarget = part.cursor + deliveredCount;';
  withMutant(oldStr, buggyStr, (mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('g3-mutant3');
    try {
      register(home, repo, 'primary-g3m3', undefined);
      register(home, repo, 'sibling-g3m3', undefined, 'unclaimed:sibling-g3m3'); // Fix Wave 7 Item 2: genuine orphan fixture (never claimed by a real session)
      markSiblingOrphaned(home, 'sibling-g3m3'); // explicit orphan fixture — see helper comment above
      const dupHash = 'forced-cross-partition-dup-g3m3';
      seedPartition(home, repo, 'primary-g3m3', [{ body: 'own-row', ts: 500, hash: dupHash }]);
      // Injected (not a real insert) — see this file's G2 REACHABILITY note:
      // a real duplicate-hash `appendMeshMessage` is silently dropped,
      // store-wide, on both backends' `appendMeshRow`.
      seedPartition(home, repo, 'sibling-g3m3', [{ body: 'sib-new-row', ts: 2000 }]);
      const dupRow = {
        index: 0, seq: 0, ts: 1000, hash: dupHash, body: 'sib-dup-row',
        sender: 'sender', recipient: 'sibling-g3m3', mtype: 'direct', urgency: 'normal',
        isHeartbeat: false, needsReply: false, storeSeq: 0,
      };
      withInjectedDuplicate('sibling-g3m3', dupRow, () => {
        mutatedCli.run(['inbox', 'read-primary', 'primary-g3m3', '--ack-as-owner'], ctx(home, { cwd: repo }));
        const sibCursor = readCursorFile(home, repo, 'sibling-g3m3');
        assert.notEqual(sibCursor, 2, 'BUGGY variant 3: deliveredCount(1) under-acks — the cursor lands at 1 instead of the real physical count 2, reproducing the G2 index drift');
      });
    } finally { rm(home); rm(repo); }
  });
});

// ---------------------------------------------------------------------------
// Wave 6 — live-sibling ack gate regression (P0). Two live children sharing
// one canonical worktree used to silently ack each other's mail: whichever
// child called `read-primary` first advanced the OTHER (still-live) child's
// own cursor via the sibling-ack loop, so that child's own next read saw its
// own real backlog as already consumed. `canonicalMeshId(worktreePath)`
// groups purely on worktree path with no liveness check at all
// (`meshCandidateRows`), so nothing before this fix distinguished "a genuine
// mesh-drain orphan" from "a live sibling that just hasn't read yet".
//
// FIX (scripts/devswarm.js cmdInboxMessages, sibling-ack loop): gate the
// CURSOR WRITE per-partition on `hasFreshHeartbeat(part.id, home, {now})` —
// the raw `heartbeats/<id>.json` `ts`, NOT `readActivityTs`'s composed union
// of heartbeat/transcriptMtime/lastOutbound (that union can read a DEAD
// session's worktree as "alive" from unrelated fs activity — see the fix's
// own comment). Delivery (`messages`) is computed BEFORE this loop and is
// therefore unaffected — a live sibling's mail is still RETURNED, only its
// cursor is protected.
// ---------------------------------------------------------------------------

test('Wave 6 RED/GREEN: a LIVE sibling\'s cursor is unchanged after a foreign caller\'s read-primary, while its message is still returned', () => {
  const home = tmpHome();
  const repo = makeGitRepo('w6-live');
  try {
    register(home, repo, 'primary-w6', undefined);
    register(home, repo, 'sibling-w6', undefined);
    markSiblingLive(home, 'sibling-w6'); // THE explicit live fixture — a fresh heartbeat, not merely a well-formed --session
    seedPartition(home, repo, 'sibling-w6', [{ body: 'live-sibling-row', ts: 2000 }]);

    const before = readCursorFile(home, repo, 'sibling-w6');
    assert.equal(before, 0, 'sanity: sibling starts unread');

    const r1 = cli.run(['inbox', 'read-primary', 'primary-w6', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r1.result.ok, true, JSON.stringify(r1.result));

    // Visibility must NOT regress: the live sibling's message is still
    // returned to the foreign caller.
    assert.ok(r1.result.messages.some((m) => m.body === 'live-sibling-row'), 'THE FIX must not withhold delivery — only the cursor write is gated');

    // THE FIX: the live sibling's OWN cursor must be untouched by this
    // foreign caller's ack.
    const sibCursorAfter = readCursorFile(home, repo, 'sibling-w6');
    assert.equal(sibCursorAfter, 0, 'THE FIX: a live sibling\'s cursor must be UNCHANGED by a foreign read-primary — only a genuinely orphaned sibling may be ack-written');

    // Observability: the skip is surfaced, not silent.
    assert.deepEqual(r1.result.liveSiblingsSkipped, ['sibling-w6'], 'the live-sibling skip must be reported, not silently dropped');

    // The sibling's OWN next read must still see its own message as unread
    // (proof the ack genuinely never happened, not just that the field
    // reports 0 by coincidence).
    const ownRead = cli.run(['inbox', 'read-primary', 'sibling-w6', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.deepEqual(ownRead.result.messages.map((m) => m.body), ['live-sibling-row'], 'the live sibling must still see (and be able to ack) its own message itself — nothing was silently consumed out from under it');
  } finally { rm(home); rm(repo); }
});

// Mutation list for the Wave 6 gate (non-vacuousness proof — each mutant
// applied to an ISOLATED SCRATCH COPY via mutantKit, never the live file):
//   1. Delete the gate entirely (reproduces the pre-Wave-6 P0: a live
//      sibling's cursor gets clobbered by a foreign caller).
//   2. Invert the gate's sense (`if (!siblingLive)` instead of
//      `if (siblingLive)`) — reproduces the SAME clobber via a flipped
//      condition, and additionally proves the orphan-drain case (G2/G3
//      above) would wrongly be PROTECTED forever (the real regression this
//      variant would cause in production, not just this one test).

// Fix Wave 7 Item 1/2: the inline `hasFreshHeartbeat`-only gate was replaced
// by a call to the ONE shared `siblingAckGate` (scripts/devswarm.js), reused
// verbatim by `inbox ack`'s own sibling loop too — see that function's own
// header for why. Updated here to match; the mutation intent (delete the
// gate / invert its sense) is unchanged.
const LIVE_GATE_OLD = "        if (siblingAckGate(s, part.id, home, ctx.now)) { liveSiblingsSkipped.push(part.id); continue; }\n";

test('Wave 6 mutation check (variant 1): deleting the live-sibling gate reproduces the cross-partition clobber', () => {
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  assert.ok(liveBefore.includes(LIVE_GATE_OLD), 'Wave 6 gate block not found verbatim in the sibling-ack loop');
  withMutant(LIVE_GATE_OLD, '', (mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('w6-mutant1');
    try {
      register(home, repo, 'primary-w6m1', undefined);
      register(home, repo, 'sibling-w6m1', undefined);
      markSiblingLive(home, 'sibling-w6m1');
      seedPartition(home, repo, 'sibling-w6m1', [{ body: 'live-sibling-row', ts: 2000 }]);
      mutatedCli.run(['inbox', 'read-primary', 'primary-w6m1', '--ack-as-owner'], ctx(home, { cwd: repo }));
      const sibCursor = readCursorFile(home, repo, 'sibling-w6m1');
      assert.notEqual(sibCursor, 0, 'BUGGY (gate deleted): the live sibling\'s cursor IS clobbered by the foreign caller — reproduces the P0');
    } finally { rm(home); rm(repo); }
  });
  mutantKit.assertLiveUntouched(liveBefore, assert);
});

test('Wave 6 mutation check (variant 2): inverting the gate\'s sense protects live siblings\' cursors from ANY ack while wrongly clobbering them too (flipped condition)', () => {
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  assert.ok(liveBefore.includes(LIVE_GATE_OLD), 'Wave 6 gate block not found verbatim in the sibling-ack loop');
  const invertedGate = "        if (!siblingAckGate(s, part.id, home, ctx.now)) { liveSiblingsSkipped.push(part.id); continue; }\n";
  withMutant(LIVE_GATE_OLD, invertedGate, (mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('w6-mutant2');
    try {
      register(home, repo, 'primary-w6m2', undefined);
      register(home, repo, 'sibling-w6m2', undefined);
      markSiblingLive(home, 'sibling-w6m2');
      seedPartition(home, repo, 'sibling-w6m2', [{ body: 'live-sibling-row', ts: 2000 }]);
      const r = mutatedCli.run(['inbox', 'read-primary', 'primary-w6m2', '--ack-as-owner'], ctx(home, { cwd: repo }));
      const sibCursor = readCursorFile(home, repo, 'sibling-w6m2');
      // BUGGY: with the condition flipped, `siblingLive:true` now falls
      // through to ack — the exact clobber this fix exists to prevent.
      assert.notEqual(sibCursor, 0, 'BUGGY (inverted condition): the live sibling is STILL ack-clobbered — inverting the check does not protect it');
      assert.ok(!r.result.liveSiblingsSkipped, 'BUGGY (inverted condition): the live sibling is never reported as skipped — the observability field silently disagrees with reality too');
    } finally { rm(home); rm(repo); }
  });
  mutantKit.assertLiveUntouched(liveBefore, assert);
});

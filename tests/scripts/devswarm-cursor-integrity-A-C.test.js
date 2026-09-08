'use strict';
// Cursor-integrity investigation (field data: partition primary-63f9261d with
// a UUID twin row) — regression tests for two of the three CONFIRMED findings:
//
// (A) `read-primary`'s mesh-sibling union read pulled a NEVER-READ sibling's
//     ENTIRE history (sinceCursor:0), unbounded except by the general
//     DEFAULT_INBOX_READ_LIMIT (2000) merged-total cap, which a field case
//     (753 messages / 1.7MB, three never-read siblings) never even triggered.
//     Fix: NEVER_READ_SIBLING_CAP (scripts/devswarm.js) caps a never-read
//     sibling's OWN contribution to a bounded structural PREFIX before it
//     ever reaches the general merge/cap pipeline — loss-free (a withheld
//     row's partition cursor can never be advanced past it, because the
//     ack-target math derives its target from the rows actually present,
//     never from `part.total`).
//
// (C) A UUID twin row of the SAME agent (crossLinkedIdentity: one row's
//     sessionId IS the other row's id — companion/lib/devswarm-identity-
//     family.js) never heartbeats under its own id (only its
//     `primary-<hash>` twin does), so `siblingAckGate` read it as NOT live
//     and drained + acked it during the caller's OWN read — the caller's own
//     twin, treated as a foreign sibling. Fix: `siblingAckGate` now takes the
//     CALLER's own id and treats a cross-linked twin of the CALLER as SELF
//     (skip — the caller's own read/ack path governs it), and a not-live
//     partition whose OWN cross-linked twin reads live as live too (skip).
//
// Every mutation here targets ONLY an isolated scratch copy of
// scripts/devswarm.js (devswarm-mutant-kit.js) — the live file is proven
// byte-identical before/after via assertLiveUntouched.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DEVSWARM_PATH = path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js');
const cli = require(DEVSWARM_PATH);
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const mutantKit = require('./lib/devswarm-mutant-kit.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-cursor-integrity-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-cursor-integrity-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function register(home, repoDir, id, sessionId) {
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const r = cli.run(
    ['register', id, '--worktree', repoDir, '--session', sessionId || ('s-' + id), '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, { cwd: repoDir })
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
  return { inboxPath, cursorPath };
}

function seedPartition(home, repoDir, toId, rows) {
  const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
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

// registerDirect: inserts a registry row DIRECTLY via the store's
// upsertRegistry, bypassing `cmdRegister`'s own retireWorktreeDuplicates
// call (which eagerly TOMBSTONES a same-worktree candidate whose sessionId
// is a "stale cross-reference" — exactly the identity-family cross-link
// shape a UUID-twin-of-caller row has — see foldGroupIntoSurvivor's
// isStaleCrossReference, scripts/devswarm.js). The field-observed twin row
// coexists with its primary-<hash> twin in production; a plain `register`
// CLI call for both would retire one of them before this test could ever
// reach siblingAckGate, so identity-family fixtures use this helper instead.
function registerDirect(home, repoDir, id, sessionId) {
  const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  assert.ok(repoKey, 'repoKey must resolve for a real git repo');
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    const ok = s.upsertRegistry({ id, worktreePath: repoDir, sessionId, inboxPath, cursorPath });
    assert.notEqual(ok, false, 'registerDirect upsertRegistry was refused for ' + id);
  } finally { s.close(); }
  return { inboxPath, cursorPath };
}

function readCursorFile(home, repo, id) {
  const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
  const repoKey = repokey.repoKeyForWorktree(repo);
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { return s.cursorValue(id); } finally { s.close(); }
}

const livenessLib = require('../../plugins/anti-hall/companion/lib/liveness.js');
function writeHeartbeatFile(home, id, ts) {
  const p = livenessLib.heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ id, ts }));
}
function markLive(home, id, now) { writeHeartbeatFile(home, id, now || Date.now()); }

function withMutant(oldStr, newStr, fn) {
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  mutantKit.withMutant(oldStr, newStr, fn, { prefix: 'anti-hall-cursor-integrity' });
  mutantKit.assertLiveUntouched(liveBefore, assert);
}

// ---------------------------------------------------------------------------
// (A) NEVER_READ_SIBLING_CAP
// ---------------------------------------------------------------------------

// resolveMeshPartitionIds groups by canonicalMeshId(worktreePath) — three
// registrations sharing ONE worktree form one mesh group, exactly the field
// case's "senders split across THREE primary-* partitions" shape.
test('(A) RED/GREEN: a never-read sibling\'s history is capped to a bounded prefix, and the withheld tail is never lost', () => {
  const home = tmpHome();
  const repo = makeGitRepo('a-basic');
  try {
    register(home, repo, 'caller-a1');
    // ORPHANED (register-only phantom, `unclaimed:` sessionId): the ONLY
    // shape whose cursor a foreign caller's ack is even allowed to advance
    // (siblingAckGate's own, pre-existing legitimate cross-drain case) — a
    // LIVE sibling's cursor is never advanced by a foreign caller at all
    // (Fix Wave 6/7), so it cannot demonstrate the cap's loss-free property
    // (cursor <= delivered, never past the withheld tail).
    register(home, repo, 'sib-a1', 'unclaimed:sib-a1');
    markLive(home, 'caller-a1');
    // Seed the never-read sibling with MORE than NEVER_READ_SIBLING_CAP (200) rows.
    const rows = [];
    for (let i = 0; i < 250; i++) rows.push({ body: 'row-' + i, ts: 1000 + i });
    seedPartition(home, repo, 'sib-a1', rows);

    const r = cli.run(['inbox', 'read-primary', 'caller-a1', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));

    // THE FIX: only the first 200 rows are delivered this call.
    const delivered = r.result.messages.filter((m) => m.body && m.body.startsWith('row-'));
    assert.equal(delivered.length, 200, 'THE FIX: a never-read sibling\'s contribution is capped to NEVER_READ_SIBLING_CAP (200)');
    assert.equal(r.result.meshNeverReadCapped, true, 'the cap must be reported, never silent');
    assert.equal(r.result.meshNeverReadWithheldCount, 50, '250 - 200 = 50 withheld this call');

    // LOSS-FREE: the sibling's cursor must be EXACTLY 200 (this orphaned
    // sibling IS ack-drained by the caller) — never past the 200 rows
    // actually delivered, so the withheld 50 remain reachable.
    const sibCursorAfter = readCursorFile(home, repo, 'sib-a1');
    assert.equal(sibCursorAfter, 200, 'sibling cursor must advance to EXACTLY the delivered prefix, never past the withheld tail; got ' + sibCursorAfter);

    // Reading again (same caller) must make forward progress on the
    // withheld tail — nothing is permanently stuck or dropped.
    const r2 = cli.run(['inbox', 'read-primary', 'caller-a1', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r2.result.ok, true, JSON.stringify(r2.result));
    const delivered2 = r2.result.messages.filter((m) => m.body && m.body.startsWith('row-'));
    assert.ok(delivered2.length > 0, 'the previously-withheld tail must be delivered on a subsequent read, never dropped');

    const bodiesSeenSoFar = new Set(delivered.concat(delivered2).map((m) => m.body));
    // Directly reading the sibling id proves nothing was lost even before
    // a second read-primary call happens to reach it: every one of the 250
    // seeded rows exists on the sibling's own partition, untouched by the cap.
    const direct = cli.run(['inbox', 'messages', 'sib-a1'], ctx(home, { cwd: repo }));
    assert.equal(direct.result.messages.length, 250, 'the sibling\'s own full history is never mutated/dropped by the cap — reading it directly still shows all 250 rows');
  } finally { rm(home); rm(repo); }
});

test('(A) mutation check: removing the NEVER_READ_SIBLING_CAP slice reproduces the unbounded never-read-sibling dump', () => {
  // WAVE 9 (c): the cap's gate is now backlog SIZE (was `pCursor === 0`) and
  // its shape depends on whether this call can ack the partition — see
  // devswarm-wave9-neverread-cap.test.js. Disabling the gate is still the
  // mutation that reproduces the unbounded dump.
  const oldStr = '        if (unreadOnly && pMessages.length > NEVER_READ_SIBLING_CAP) {\n';
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  assert.ok(liveBefore.includes(oldStr), 'NEVER_READ_SIBLING_CAP gate not found verbatim');
  withMutant(oldStr, '        if (false) {\n', (mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('a-mutant');
    try {
      register(home, repo, 'caller-am');
      register(home, repo, 'sib-am');
      markLive(home, 'caller-am');
      markLive(home, 'sib-am');
      const rows = [];
      for (let i = 0; i < 250; i++) rows.push({ body: 'row-' + i, ts: 1000 + i });
      seedPartition(home, repo, 'sib-am', rows);
      const r = mutatedCli.run(['inbox', 'read-primary', 'caller-am', '--ack-as-owner'], ctx(home, { cwd: repo }));
      const delivered = r.result.messages.filter((m) => m.body && m.body.startsWith('row-'));
      assert.equal(delivered.length, 250, 'BUGGY (cap removed): the never-read sibling\'s FULL history is dumped in one call — reproduces the unbounded read');
    } finally { rm(home); rm(repo); }
  });
});

test('(A) does not regress an already-read sibling (pCursor > 0): no cap applies, full remaining unread still delivered', () => {
  const home = tmpHome();
  const repo = makeGitRepo('a-already-read');
  try {
    register(home, repo, 'caller-a2');
    register(home, repo, 'sib-a2', 'unclaimed:sib-a2'); // orphaned so the ack step actually advances its cursor between calls
    markLive(home, 'caller-a2');
    const rows = [];
    for (let i = 0; i < 210; i++) rows.push({ body: 'row-' + i, ts: 1000 + i });
    seedPartition(home, repo, 'sib-a2', rows);
    // First read establishes a non-zero cursor for sib-a2 (still capped, since it starts at 0).
    cli.run(['inbox', 'read-primary', 'caller-a2', '--ack-as-owner'], ctx(home, { cwd: repo }));
    // Second call: sib-a2's cursor is now > 0 — NOT "never read" anymore — its
    // remaining backlog (10 rows) must be delivered uncapped this call.
    const r2 = cli.run(['inbox', 'read-primary', 'caller-a2', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r2.result.meshNeverReadCapped, undefined, 'a partition already past its first read must not be reported as never-read-capped');
    const delivered2 = r2.result.messages.filter((m) => m.body && m.body.startsWith('row-'));
    assert.equal(delivered2.length, 10, 'the remaining 10 rows (210 - 200 capped) must all be delivered once the sibling is no longer "never read"');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// (C) identity-family self/twin gate
// ---------------------------------------------------------------------------

// WAVE 9 CORRECTION (P1, see devswarm-wave9-self-twin-ack.test.js): this test
// originally asserted the twin's cursor must stay UNTOUCHED, on siblingAckGate's
// stated theory that "the caller's own read/ack path already governs it". That
// theory was traced and DISPROVEN — the own-store ack writes only the CALLER's
// own two cursors, never the twin partition's, so the twin's rows were delivered
// on every call forever and its cursor never moved. The corrected contract: a
// SELF twin is the caller's own identity, so the CALLER acks it (same
// ack-target arithmetic as any partition); only FOREIGN siblings (live, or
// twin-of-live — the two tests below) keep the no-ack protection.
test('(C) RED/GREEN: a UUID twin row of the CALLER itself is acked BY THE CALLER (it is SELF, not a foreign sibling)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('c-self-twin');
  try {
    // The caller's OWN sessionId IS the twin's id (the real-world shape: the
    // primary process's session is identified by the same builder-id UUID
    // it spawned as a child descriptor) — this is the cross-link
    // devswarm-identity-family.js's crossLinkedIdentity defines
    // (b.sessionId === a.id). The twin itself is a genuine register-only
    // phantom (`unclaimed:` sessionId — never claimed by a real session of
    // its OWN), so in ISOLATION its row reads NOT live via
    // isSiblingPartitionLive, exactly the field-reported shape ("never
    // heartbeats under its own id"). The twin is inserted DIRECTLY into the
    // registry (registerDirect), bypassing `cmdRegister`'s own
    // retireWorktreeDuplicates fold — see that helper's own header comment
    // for why a plain `register` CLI call for both would tombstone it first.
    register(home, repo, 'caller-primary-c1', 'twin-uuid-c1');
    registerDirect(home, repo, 'twin-uuid-c1', 'unclaimed:twin-uuid-c1');
    markLive(home, 'caller-primary-c1'); // only the caller heartbeats, under its OWN id
    seedPartition(home, repo, 'twin-uuid-c1', [{ body: 'twin-own-row', ts: 2000 }]);

    const before = readCursorFile(home, repo, 'twin-uuid-c1');
    assert.equal(before, 0, 'sanity: twin starts unread');

    const r = cli.run(['inbox', 'read-primary', 'caller-primary-c1', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));

    // Delivery is unaffected either way — only the cursor WRITE is gated.
    assert.ok(r.result.messages.some((m) => m.body === 'twin-own-row'), 'the twin\'s row is still delivered to the caller');

    // THE (corrected) FIX: the twin's OWN cursor advances to exactly the
    // delivered prefix. Skipping it stranded the cursor at `before` forever
    // while the same row kept being delivered on every call.
    const after = readCursorFile(home, repo, 'twin-uuid-c1');
    assert.equal(after, 1, 'a same-agent UUID twin IS acked by its own agent\'s read, to the delivered prefix (was: stuck at ' + before + ' forever)');
    assert.ok(!(r.result.liveSiblingsSkipped || []).includes('twin-uuid-c1'), 'and it is NOT reported as a skipped live sibling — it is SELF, and it was acked');
    // The re-delivery loop is closed.
    const r2 = cli.run(['inbox', 'read-primary', 'caller-primary-c1', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.ok(!r2.result.messages.some((m) => m.body === 'twin-own-row'), 'the twin\'s row must not be re-delivered on the next read');
  } finally { rm(home); rm(repo); }
});

test('(C) RED/GREEN: a partition whose OWN cross-linked twin is live reads as live too (not ack-drained)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('c-twin-of-live');
  try {
    // A DIFFERENT foreign agent's two rows: foreign-uuid-c2 is a genuine
    // register-only phantom (`unclaimed:` sessionId — reads NOT live in
    // ISOLATION, the exact field shape), cross-linked to foreign-primary-c2
    // via foreign-primary-c2's sessionId === foreign-uuid-c2's id (the
    // real-world shape: that agent's live process's own session is
    // identified by the same builder-id UUID it registered as a phantom).
    // foreign-primary-c2 has a FRESH HEARTBEAT under its OWN id — it is the
    // one actually alive. foreign-uuid-c2 is inserted via registerDirect
    // (see that helper's own comment) so it survives alongside
    // foreign-primary-c2 instead of being eagerly tombstoned by the
    // same-worktree fold.
    register(home, repo, 'caller-c2');
    register(home, repo, 'foreign-primary-c2', 'foreign-uuid-c2');
    markLive(home, 'foreign-primary-c2'); // the twin heartbeats, not foreign-uuid-c2 itself
    registerDirect(home, repo, 'foreign-uuid-c2', 'unclaimed:foreign-uuid-c2');
    markLive(home, 'caller-c2');
    seedPartition(home, repo, 'foreign-uuid-c2', [{ body: 'foreign-row', ts: 2000 }]);

    const r = cli.run(['inbox', 'read-primary', 'caller-c2', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.ok(r.result.messages.some((m) => m.body === 'foreign-row'), 'delivery unaffected');

    const after = readCursorFile(home, repo, 'foreign-uuid-c2');
    assert.equal(after, 0, 'THE FIX: foreign-uuid-c2 is live via its own cross-linked twin\'s heartbeat — must not be ack-drained');
    assert.ok((r.result.liveSiblingsSkipped || []).includes('foreign-uuid-c2'), 'the twin-of-live skip must be observable');
  } finally { rm(home); rm(repo); }
});

test('(C) constraint preserved: a genuinely orphaned partition with NO live twin is still ack-drained', () => {
  const home = tmpHome();
  const repo = makeGitRepo('c-orphan-preserved');
  try {
    register(home, repo, 'caller-c3');
    markLive(home, 'caller-c3');
    register(home, repo, 'orphan-c3', 'unclaimed:orphan-c3');
    seedPartition(home, repo, 'orphan-c3', [{ body: 'orphan-row', ts: 3000 }]);

    const r = cli.run(['inbox', 'read-primary', 'caller-c3', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    const after = readCursorFile(home, repo, 'orphan-c3');
    assert.equal(after, 1, 'a genuinely orphaned partition (no live twin, no cross-link to the caller) must still be ack-drainable — the extension must not over-protect');
    assert.ok(!(r.result.liveSiblingsSkipped || []).includes('orphan-c3'), 'must not be reported as skipped');
  } finally { rm(home); rm(repo); }
});

// WAVE 9 CORRECTION: the SELF branch now returns FALSE (the caller acks its own
// twin) rather than true. Its observable effect therefore inverts — the branch
// matters exactly when the twin would OTHERWISE read as live, which is the
// normal field shape: the twin never heartbeats under its own id, but its
// cross-linked partner (the CALLER) does, so the TWIN-OF-LIVE rule below would
// classify it live and skip the ack. Removing the SELF branch hands the twin to
// that rule and restores the perpetual re-delivery this fix closes.
test('(C) mutation check: removing the SELF cross-link check restores the twin\'s stranded cursor (perpetual re-delivery)', () => {
  const oldStr = "  if (idFam && callerId != null) {\n"
    + "    try {\n"
    + "      const callerRow = registry.find((r) => r && String(r.id) === String(callerId));\n"
    + "      if (callerRow && idFam.crossLinkedIdentity(callerRow, row)) {\n"
    + "        // WORKTREE-SCOPED SELF (defect 8b211241bbe9). `crossLinkedIdentity`\n"
    + "        // compares ONLY ids and sessionIds \u2014 a pure ROW-level link with no\n"
    + "        // process, instance, or LOCATION component. So a caller invoking with a\n"
    + "        // child's meshId while standing in the PARENT's worktree passed this\n"
    + "        // SELF test and acked the child's twin partition, consuming mail the\n"
    + "        // child was never shown (field repro: uuid cursor found already at 31\n"
    + "        // with no tick in the child's own turn).\n"
    + "        //\n"
    + "        // Genuine SELF also requires standing in the partition's OWN worktree.\n"
    + "        // FAIL OPEN to the pre-fix SELF verdict when `worktreePath` is missing\n"
    + "        // or unresolvable (a pre-migration or partial row behaves exactly as it\n"
    + "        // does today), so this can only ever REFUSE a cross-worktree ack, never\n"
    + "        // strand a legitimate self-ack. `--ack-as-owner` never reaches here: it\n"
    + "        // is the sanctioned cross-workspace override and is gated before this.\n"
    + "        const rowWt = row.worktreePath ? (canonicalWorktreeRealPath(String(row.worktreePath)) || String(row.worktreePath)) : null;\n"
    + "        const callerCwd = (opts && opts.cwd) ? String(opts.cwd) : null;\n"
    + "        const callerWt = callerCwd ? (canonicalWorktreeRealPath(callerCwd) || callerCwd) : null;\n"
    + "        if (!rowWt || !callerWt) return false; // fail open \u2014 today's SELF verdict\n"
    + "        if (rowWt === callerWt) return false;  // genuinely self: same worktree\n"
    + "        return true;                            // cross-worktree caller: NOT self, never ack\n"
    + "      }\n"
    + "    } catch (_) { /* fall through to the plain liveness check below */ }\n"
    + "  }\n";
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  assert.ok(liveBefore.includes(oldStr), 'SELF cross-link check not found verbatim in siblingAckGate');
  withMutant(oldStr, '', (mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('c-mutant-self');
    try {
      // The exact field shape: only the CALLER heartbeats, under its own id.
      // With the SELF branch gone, TWIN-OF-LIVE sees the twin's cross-linked
      // partner (the caller) as live and skips the ack.
      register(home, repo, 'caller-primary-cm', 'twin-uuid-cm');
      registerDirect(home, repo, 'twin-uuid-cm', 'unclaimed:twin-uuid-cm');
      markLive(home, 'caller-primary-cm');
      seedPartition(home, repo, 'twin-uuid-cm', [{ body: 'twin-own-row', ts: 2000 }]);
      const r = mutatedCli.run(['inbox', 'read-primary', 'caller-primary-cm', '--ack-as-owner'], ctx(home, { cwd: repo }));
      assert.ok(r.result.messages.some((m) => m.body === 'twin-own-row'), 'sanity: the twin\'s row is delivered on the mutant too');
      const after = readCursorFile(home, repo, 'twin-uuid-cm');
      assert.equal(after, 0, 'BUGGY (SELF check removed): the caller\'s own UUID twin is never acked — its own cursor stays stranded at 0');
      assert.ok((r.result.liveSiblingsSkipped || []).includes('twin-uuid-cm'),
        'BUGGY (SELF check removed): the caller\'s OWN twin is misclassified as a foreign live sibling and its ack is refused');

      // v0.90.1 P0 HOTFIX — WHY THE OLD SECOND ASSERTION WAS RETIRED.
      //
      // This used to assert "and it comes back again on the very next read".
      // That symptom is now prevented INDEPENDENTLY: a sibling whose ack is
      // refused gets a CALLER-SCOPED watermark, so the caller stops being
      // re-served rows it has already seen even when the ack gate wrongly
      // refuses. Defence in depth — the SELF branch is still the fix (without
      // it the twin's OWN cursor is stranded, above), but the re-delivery
      // symptom is no longer the way to observe its absence.
      const r2 = mutatedCli.run(['inbox', 'read-primary', 'caller-primary-cm', '--ack-as-owner'], ctx(home, { cwd: repo }));
      assert.ok(!r2.result.messages.some((m) => m.body === 'twin-own-row'),
        'the P0 watermark stops the re-delivery even on this mutant — the stranded cursor above is what still exposes the missing SELF branch');
      assert.equal(readCursorFile(home, repo, 'twin-uuid-cm'), 0,
        'and the twin\'s own cursor is STILL stranded: its own reader would re-read everything it already handled');
    } finally { rm(home); rm(repo); }
  });
});

test('(C) mutation check: removing the TWIN-OF-LIVE check reproduces the misread of a live agent registered under a different id', () => {
  const oldStr = "  if (idFam) {\n"
    + "    try {\n"
    + "      const twins = idFam.identityFamilyTwins(row, registry.filter((r) => r && String(r.id) !== String(partId)));\n"
    + "      for (const t of twins) {\n"
    + "        let twinLive = false;\n"
    + "        try { twinLive = isSiblingPartitionLive({ id: t.id, worktreePath: t.worktreePath, sessionId: t.sessionId }, home, { now }); } catch (_) { twinLive = false; }\n"
    + "        if (twinLive) return true; // partId's own twin identity is live -> partId is live too\n"
    + "      }\n"
    + "    } catch (_) { /* fall through — partId's own (not-live) verdict stands */ }\n"
    + "  }\n"
    + "  return false;\n";
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  assert.ok(liveBefore.includes(oldStr), 'TWIN-OF-LIVE check not found verbatim in siblingAckGate');
  withMutant(oldStr, '  return false;\n', (mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('c-mutant-twin');
    try {
      register(home, repo, 'caller-cm2');
      register(home, repo, 'foreign-primary-cm2', 'foreign-uuid-cm2');
      markLive(home, 'foreign-primary-cm2');
      registerDirect(home, repo, 'foreign-uuid-cm2', 'unclaimed:foreign-uuid-cm2');
      markLive(home, 'caller-cm2');
      seedPartition(home, repo, 'foreign-uuid-cm2', [{ body: 'foreign-row', ts: 2000 }]);
      mutatedCli.run(['inbox', 'read-primary', 'caller-cm2', '--ack-as-owner'], ctx(home, { cwd: repo }));
      const after = readCursorFile(home, repo, 'foreign-uuid-cm2');
      assert.notEqual(after, 0, 'BUGGY (twin-of-live check removed): a live agent registered under a different id IS ack-drained — reproduces the misread');
    } finally { rm(home); rm(repo); }
  });
});

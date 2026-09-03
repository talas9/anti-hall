'use strict';
// Fix Wave 2 (DevSwarm P0 batch, Round 2 HOLD verdict — Reviewer + Auditor).
// All findings live in scripts/devswarm.js's mesh-sibling-partition
// gap-withholding machinery, now factored into the single shared
// foldSiblingGapRows(rows, seenHashes) helper (~line 1408) used by BOTH
// `inbox count/read/ack` (cmdInbox) and `inbox messages`/`read-primary`/
// `peek-primary` (cmdInboxMessages).
//
// F1 — P0, message LOSS. Wave 1's gap-withholding fold set `gapSeen` on a
// non-forwardable/null row but still PUSHED that row into `deliveredRows`,
// so withholding was NON-SUFFIX: a withheld forwardable row could sit
// BETWEEN two delivered rows. The sibling ack target is POSITIONAL
// (`part.cursor + deliveredCount`), valid only over a genuine CONTIGUOUS
// PREFIX. A `[native N0, direct F1row, native N2]` window delivered
// `[N0, N2]` (2 rows) while withholding only F1row (1 row) — the ack then
// advanced the sibling cursor by 2, past BOTH N0 and F1row, permanently
// losing F1row (still reachable in the store, but positionally behind the
// cursor forever — the next read starts at N2).
//
// FIX CHOSEN: option (b) — restore the documented invariant VERBATIM. Once
// `gapSeen`, EVERY subsequent row is withheld, including non-forwardable
// ones (the row that TRIGGERS the gap is itself still delivered — "never
// excluded" — but nothing after it is). This makes `deliveredRows` a
// genuine index-based PREFIX of the partition's natural order, so
// `part.cursor + deliveredCount` is always a safe, real position. Judged the
// smaller change vs. capping `ackTarget` at the first-withheld-row index
// (which would need a second piece of state tracked alongside `gapSeen`).
// Cost: N2 (individually safe, non-forwardable) is now ALSO withheld until
// the next read/fold — a real behavior change, but never a loss (no cursor
// is ever advanced past it either).
//
// F2 — P1, `count` undercounted AND omitted the honesty flag.
// `meshAddedUnreadCount` was computed AFTER gap-withholding AND after the
// P2-D cap (`storeOnlyUnreadRows.length - ownKeptCount`), so `count`'s
// `unreadTotal`/`unread` silently dropped below the real total whenever the
// cap actually withheld something — contradicting `cmdInboxMessages`, which
// computes its own `meshAddedUnreadCount` PRE-cap. `count`'s return block
// also never carried `meshGapWithheld`/`meshGapWithheldCount` (only `read`/
// `ack` did). FIX: compute `meshAddedUnreadCount` from `part.deliveredRows`
// (the gap-fold output, untouched by the cap step) — the real, pre-cap
// total — and add `meshGapWithheld`/`meshGapWithheldCount` to `count`'s
// return.
//
// F3 — P1, surface divergence. `cmdInboxMessages` (`read-primary`/
// `peek-primary`, the verb `hooks/lib/devswarm-wake.js:135-136` actually
// routes the Primary through) never had ANY gap/forwardable tracking — pure
// hash-only dedup, every sibling row delivered. FIX: both surfaces now
// share ONE fold (`foldSiblingGapRows`), so they can no longer silently
// disagree; `cmdInboxMessages`'s output also gained
// `meshGapWithheld`/`meshGapWithheldCount`.
//
// F4 — P2, `--limit 0.5` floored to 0, disabling the cap (and, in the
// `count/read/ack` path, driving `meshAddedUnreadCount` to a false zero via
// `inboxCapLimit === 0`). FIX (both sites): `Math.max(1, Math.floor(n))`.
//
// F5 — P2, a null store row (corruption) used to be pushed into
// `deliveredRows` as a literal `null` after poisoning the rest of the
// window. FIX: `if (!row) { gapSeen = true; continue; }` before any other
// check — skipped entirely, but still poisons subsequent rows (its safety
// is unknowable).
//
// MUTATION CHECK (documented per anti-hall protocol; each mutant applied
// directly to plugins/anti-hall/scripts/devswarm.js via a byte-exact
// string-replace, run against the specific test named, confirmed RED, then
// reverted and diffed byte-identical against the pre-mutant file):
//   F1/M1 (the literal Wave-1 regression): replace `foldSiblingGapRows`'s
//       body with the OLD buggy inline algorithm (`gapSeen` set but the
//       triggering row still falls through to push, and EVERY later
//       non-forwardable row also still falls through to push — i.e. only
//       forwardable-after-gap rows are ever withheld) -> KILLED by "F1
//       RED/GREEN" below (F1row's body vanishes from the follow-up read;
//       the sibling cursor advances to 2 instead of 1).
//   F2/M1: revert `meshAddedUnreadCount` to be computed from
//       `storeOnlyUnreadRows.length - ownKeptCount` (the POST-cap value)
//       instead of summing `part.deliveredRows.length` -> KILLED by "F2
//       RED/GREEN" below (capped `count`'s `unreadTotal` drops from 5 to 3).
//   F2/M2: delete the `meshGapWithheldCount > 0` block from `count`'s
//       return -> KILLED by "F2: count surfaces meshGapWithheld" below.
//   F3/M1: revert the `cmdInboxMessages` sibling loop to hash-dedup-only
//       (no `foldSiblingGapRows` call, every row delivered) -> KILLED by "F3
//       RED/GREEN" below (read-primary's delivered bodies include F1row,
//       which count/read/ack would withhold — the two surfaces disagree).
//   F4/M1: revert `Math.max(1, Math.floor(n))` to plain `Math.floor(n)` at
//       BOTH sites -> KILLED by "F4" below (a `--limit 0.5` count call
//       returns 0 rows / a false-zero unreadTotal instead of the real one).
//   F5/M1: delete the `if (!row) { gapSeen = true; continue; }` line ->
//       KILLED by "F5" below (the call throws reading `.hash` off `null`,
//       or a null literal appears in `meshMessages`).

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
const mutantKit = require('./lib/devswarm-mutant-kit.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fixwave2-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fixwave2-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

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
      const hash = storeLib.meshMessageHash(fields);
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
      workspaceId: toId, ts: row.ts, hash: 'native:' + toId + ':' + row.ts, body: row.body,
      sender: null, recipient: null, mtype: null, urgency: null, isHeartbeat: false, needsReply: false,
    });
  } finally { s.close(); }
}

function readCursorFile(home, repo, id) {
  const repoKey = repokey.repoKeyForWorktree(repo);
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { return s.cursorValue(id); } finally { s.close(); }
}

// withMutant: byte-exact string-replace, applied to an ISOLATED SCRATCH
// COPY of devswarm.js (never the live file — see
// tests/scripts/lib/devswarm-mutant-kit.js for why), used only transiently
// inside a single test to prove a specific new assertion is a real
// RED/GREEN pair (not merely narrated). The scratch copy is discarded when
// `fn` returns; the live source is proven untouched afterward.
function withMutant(oldStr, newStr, fn) {
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  mutantKit.withMutant(oldStr, newStr, fn, { prefix: 'anti-hall-fixwave2' });
  mutantKit.assertLiveUntouched(liveBefore, assert);
}

// ---------------------------------------------------------------------------
// F1 — ack-destroys-withheld-row (P0 message loss)
// ---------------------------------------------------------------------------

function seedF1GapWindow(home, repo, siblingId) {
  seedNativeRow(home, repo, siblingId, { body: 'N0-native', ts: 1000 });
  seedPartition(home, repo, siblingId, [{ body: 'F1row-direct', ts: 2000, urgency: null }]);
  seedNativeRow(home, repo, siblingId, { body: 'N2-native', ts: 3000 });
}

test('F1 RED/GREEN: `inbox ack` never advances a sibling cursor past a gap-withheld row — F1row survives an ack of the gap window', () => {
  const home = tmpHome();
  const repo = makeGitRepo('f1');
  try {
    register(home, repo, 'primary-f1', undefined);
    register(home, repo, 'sibling-f1', undefined, 'unclaimed:sibling-f1');
    seedF1GapWindow(home, repo, 'sibling-f1');

    const acked = cli.run(['inbox', 'ack', 'primary-f1', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(acked.result.ok, true, JSON.stringify(acked.result));
    // Fix (b): once gapSeen (at N0), everything after is withheld — F1row
    // AND N2-native both wait for the next call.
    assert.equal(acked.result.meshGapWithheld, true, 'the ack call must flag that something was withheld');
    assert.equal(acked.result.meshGapWithheldCount, 2, 'F1row and N2-native are both withheld (suffix, not just the forwardable row)');

    const sibCursor = readCursorFile(home, repo, 'sibling-f1');
    assert.equal(sibCursor, 1, 'the sibling cursor must advance ONLY past the one row actually delivered (N0-native) — never past F1row');

    const after = cli.run(['inbox', 'read', 'primary-f1'], ctx(home, { cwd: repo }));
    assert.equal(after.result.ok, true, JSON.stringify(after.result));
    const bodies = after.result.meshMessages.map((m) => m.body);
    assert.ok(bodies.includes('F1row-direct'), 'F1row must still be reachable after the ack — THE FIX: it must never be permanently lost. Got: ' + JSON.stringify(bodies));
    assert.ok(bodies.includes('N2-native'), 'N2-native must also still be reachable (withheld, not delivered, by the ack)');
  } finally { rm(home); rm(repo); }
});

test('F1 mutation check: the OLD Wave-1 non-suffix fold DOES lose F1row permanently (proves the RED half is real, not narrated)', () => {
  const oldSrc = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  const start = oldSrc.indexOf('function foldSiblingGapRows(rows, seenHashes) {');
  assert.ok(start >= 0, 'foldSiblingGapRows not found');
  const end = oldSrc.indexOf('\n}\n', start) + 3;
  const currentFn = oldSrc.slice(start, end);
  assert.ok(currentFn.includes('wasGapSeen) { gapWithheldCount++; continue; }'), 'unexpected current fold body, refusing to mutate blind');

  const buggyFn = 'function foldSiblingGapRows(rows, seenHashes) {\n'
    + '  const deliveredRows = [];\n'
    + '  let gapSeen = false;\n'
    + '  let gapWithheldCount = 0;\n'
    + '  for (const row of rows) {\n'
    + '    if (row && row.hash && seenHashes.has(row.hash)) continue;\n'
    + '    if (!row || !isForwardable(row)) {\n'
    + '      gapSeen = true;\n'
    + '    } else if (gapSeen) {\n'
    + '      gapWithheldCount++;\n'
    + '      continue;\n'
    + '    }\n'
    + '    if (row && row.hash) seenHashes.add(row.hash);\n'
    + '    deliveredRows.push(row);\n'
    + '  }\n'
    + '  return { deliveredRows, deliveredCount: deliveredRows.length, gapWithheldCount };\n'
    + '}\n';

  withMutant(currentFn, buggyFn, (mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('f1-mutant');
    try {
      register(home, repo, 'primary-f1m', undefined);
      register(home, repo, 'sibling-f1m', undefined, 'unclaimed:sibling-f1m');
      seedNativeRow(home, repo, 'sibling-f1m', { body: 'N0-native', ts: 1000 });
      seedPartition(home, repo, 'sibling-f1m', [{ body: 'F1row-direct', ts: 2000, urgency: null }]);
      seedNativeRow(home, repo, 'sibling-f1m', { body: 'N2-native', ts: 3000 });

      const acked = mutatedCli.run(['inbox', 'ack', 'primary-f1m', '--ack-as-owner'], ctx(home, { cwd: repo }));
      assert.equal(acked.result.ok, true, JSON.stringify(acked.result));

      const sibCursor = readCursorFile(home, repo, 'sibling-f1m');
      // The bug: deliveredCount = 2 (N0-native AND N2-native both pushed,
      // only F1row skipped) -> ackTarget = 0 + 2 = 2, past F1row's index (1).
      assert.equal(sibCursor, 2, 'OLD buggy fold: cursor over-advances to 2, past F1row');

      const after = mutatedCli.run(['inbox', 'read', 'primary-f1m'], ctx(home, { cwd: repo }));
      const bodies = after.result.meshMessages.map((m) => m.body);
      assert.ok(!bodies.includes('F1row-direct'), 'OLD buggy fold: F1row is now PERMANENTLY UNREACHABLE (the exact F1 defect) — bodies: ' + JSON.stringify(bodies));
    } finally { rm(home); rm(repo); }
  });
});

test('F1 guard (P0 non-regression): a gap-free sibling window is completely unaffected — nothing withheld', () => {
  const home = tmpHome();
  const repo = makeGitRepo('f1-guard');
  try {
    register(home, repo, 'primary-f1g', undefined);
    register(home, repo, 'sibling-f1g', undefined);
    seedPartition(home, repo, 'sibling-f1g', [{ body: 'plain-1', ts: 1000 }, { body: 'plain-2', ts: 1100 }]);

    const r = cli.run(['inbox', 'count', 'primary-f1g'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.unreadTotal, 2);
    assert.equal(r.result.meshGapWithheld, undefined, 'no gap, no withholding, no flag');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// F2 — count undercount + missing honesty flag
// ---------------------------------------------------------------------------

test('F2 RED/GREEN: `inbox count --limit` reports the REAL uncapped unreadTotal, matching an unlimited count', () => {
  const home = tmpHome();
  const repo = makeGitRepo('f2');
  try {
    register(home, repo, 'primary-f2', undefined);
    register(home, repo, 'sibling-f2', undefined);
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push({ body: 'f2-msg-' + i, ts: 1000 + i, from: 'childF2' });
    seedPartition(home, repo, 'sibling-f2', rows);

    const uncapped = cli.run(['inbox', 'count', 'primary-f2'], ctx(home, { cwd: repo }));
    assert.equal(uncapped.result.ok, true, JSON.stringify(uncapped.result));
    assert.equal(uncapped.result.unreadTotal, 5);

    const capped = cli.run(['inbox', 'count', 'primary-f2', '--limit', '3'], ctx(home, { cwd: repo }));
    assert.equal(capped.result.ok, true, JSON.stringify(capped.result));
    assert.equal(capped.result.truncated, true);
    assert.equal(capped.result.truncatedCount, 2);
    assert.equal(capped.result.unreadStore, 3, 'unreadStore reflects only what THIS call actually delivered');
    assert.equal(capped.result.unreadTotal, 5, 'unreadTotal must be the REAL total, identical to the uncapped call — THE FIX (was undercounted to 3 pre-fix)');
  } finally { rm(home); rm(repo); }
});

test('F2 mutation check: reverting to the POST-cap formula reproduces the undercount', () => {
  const oldStr = 'meshAddedUnreadCount = meshSiblingPartitions.reduce((n, p) => n + (p.deliveredRows ? p.deliveredRows.length : 0), 0);';
  assert.ok(fs.readFileSync(DEVSWARM_PATH, 'utf8').includes(oldStr), 'fix line not found verbatim');
  const buggyStr = 'meshAddedUnreadCount = storeOnlyUnreadRows.length - ownKeptCount;';
  withMutant(oldStr, buggyStr, (mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('f2-mutant');
    try {
      register(home, repo, 'primary-f2m', undefined);
      register(home, repo, 'sibling-f2m', undefined);
      const rows = [];
      for (let i = 0; i < 5; i++) rows.push({ body: 'f2m-msg-' + i, ts: 1000 + i });
      seedPartition(home, repo, 'sibling-f2m', rows);
      const capped = mutatedCli.run(['inbox', 'count', 'primary-f2m', '--limit', '3'], ctx(home, { cwd: repo }));
      assert.equal(capped.result.unreadTotal, 3, 'OLD buggy formula: unreadTotal undercounts to the capped value (3), not the real total (5)');
    } finally { rm(home); rm(repo); }
  });
});

test('F2: count surfaces meshGapWithheld/meshGapWithheldCount (previously read/ack-only)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('f2-gap');
  try {
    register(home, repo, 'primary-f2gap', undefined);
    register(home, repo, 'sibling-f2gap', undefined);
    seedF1GapWindow(home, repo, 'sibling-f2gap');

    const r = cli.run(['inbox', 'count', 'primary-f2gap'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.meshGapWithheld, true, 'THE FIX: count must expose the same honesty flag read/ack already do');
    assert.equal(r.result.meshGapWithheldCount, 2);
    assert.equal(r.result.unreadTotal, 1, 'only N0-native is actually deliverable this call');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// F3 — cmdInboxMessages (read-primary/peek-primary) surface parity
// ---------------------------------------------------------------------------

test('F3 RED/GREEN: `peek-primary` applies the SAME gap withholding as `inbox count/read` — the two surfaces agree', () => {
  const home = tmpHome();
  const repo = makeGitRepo('f3');
  try {
    register(home, repo, 'primary-f3', undefined);
    register(home, repo, 'sibling-f3', undefined);
    seedF1GapWindow(home, repo, 'sibling-f3');

    const viaCountRead = cli.run(['inbox', 'read', 'primary-f3'], ctx(home, { cwd: repo }));
    assert.equal(viaCountRead.result.ok, true, JSON.stringify(viaCountRead.result));
    const countReadBodies = viaCountRead.result.meshMessages.map((m) => m.body).sort();

    const viaPeek = cli.run(['inbox', 'peek-primary', 'primary-f3'], ctx(home, { cwd: repo }));
    assert.equal(viaPeek.result.ok, true, JSON.stringify(viaPeek.result));
    const peekBodies = viaPeek.result.messages.map((m) => m.body).sort();

    assert.deepEqual(peekBodies, countReadBodies, 'THE FIX: peek-primary and inbox read must deliver the identical set of bodies from the same gap window — got peek=' + JSON.stringify(peekBodies) + ' read=' + JSON.stringify(countReadBodies));
    assert.equal(viaPeek.result.meshGapWithheld, true, 'peek-primary must ALSO surface meshGapWithheld now');
    assert.equal(viaPeek.result.meshGapWithheldCount, 2);
  } finally { rm(home); rm(repo); }
});

test('F3 mutation check: reverting cmdInboxMessages to hash-dedup-only reproduces the surface divergence', () => {
  const oldStr = 'for (const part of meshSiblingPartitions) {\n'
    + '        const folded = foldSiblingGapRows(part.messages, seenHashes);\n'
    + '        meshGapWithheldCount += folded.gapWithheldCount;\n'
    + '        for (const row of folded.deliveredRows) {\n'
    + '          dedupedSiblingRows.push(row);\n'
    + '        }\n'
    + '        part.deliveredCount = folded.deliveredCount;\n'
    + '        // G1/G2 fix: `consumedThrough` lets the ack loop below derive the\n'
    + '        // PHYSICAL row count to advance past for however many of this\n'
    + '        // partition\'s leading `deliveredRows` actually survive the P2-D cap\n'
    + '        // — see foldSiblingGapRows\'s own header comment (~line 1437).\n'
    + '        part.consumedThrough = folded.consumedThrough;\n'
    + '        part.consumedCount = folded.consumedCount;\n'
    + '      }';
  assert.ok(fs.readFileSync(DEVSWARM_PATH, 'utf8').includes(oldStr), 'fix block not found verbatim');
  const buggyStr = 'for (const part of meshSiblingPartitions) {\n'
    + '        let delivered = 0;\n'
    + '        for (const row of part.messages) {\n'
    + '          if (row && row.hash && seenHashes.has(row.hash)) continue;\n'
    + '          if (row && row.hash) seenHashes.add(row.hash);\n'
    + '          dedupedSiblingRows.push(row);\n'
    + '          delivered++;\n'
    + '        }\n'
    + '        part.deliveredCount = delivered;\n'
    + '      }';
  withMutant(oldStr, buggyStr, (mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('f3-mutant');
    try {
      register(home, repo, 'primary-f3m', undefined);
      register(home, repo, 'sibling-f3m', undefined);
      seedNativeRow(home, repo, 'sibling-f3m', { body: 'N0-native', ts: 1000 });
      seedPartition(home, repo, 'sibling-f3m', [{ body: 'F1row-direct', ts: 2000, urgency: null }]);
      seedNativeRow(home, repo, 'sibling-f3m', { body: 'N2-native', ts: 3000 });

      const viaCountRead = mutatedCli.run(['inbox', 'read', 'primary-f3m'], ctx(home, { cwd: repo }));
      const countReadBodies = viaCountRead.result.meshMessages.map((m) => m.body).sort();

      const viaPeek = mutatedCli.run(['inbox', 'peek-primary', 'primary-f3m'], ctx(home, { cwd: repo }));
      const peekBodies = viaPeek.result.messages.map((m) => m.body).sort();

      assert.notDeepEqual(peekBodies, countReadBodies, 'OLD buggy cmdInboxMessages: peek-primary delivers everything (no gap tracking) while inbox read withholds — the two surfaces disagree, reproducing F3');
    } finally { rm(home); rm(repo); }
  });
});

// ---------------------------------------------------------------------------
// F4 — fractional --limit floors to 0, disabling the cap
// ---------------------------------------------------------------------------

test('F4: `--limit 0.5` does not disable the cap on `inbox count` (Math.max(1, floor(n)))', () => {
  const home = tmpHome();
  const repo = makeGitRepo('f4-count');
  try {
    register(home, repo, 'primary-f4', undefined);
    register(home, repo, 'sibling-f4', undefined);
    seedPartition(home, repo, 'sibling-f4', [{ body: 'f4-a', ts: 1000 }, { body: 'f4-b', ts: 1100 }]);

    const r = cli.run(['inbox', 'read', 'primary-f4', '--limit', '0.5'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.limit, 1, 'a fractional --limit must floor to a MINIMUM of 1, never 0 (which would silently disable the cap)');
    assert.equal(r.result.meshMessages.length, 1, 'the cap must actually apply at limit=1, not be disabled');
    assert.equal(r.result.unreadTotal, 2, 'the real total must still be honestly reported');
  } finally { rm(home); rm(repo); }
});

test('F4: `--limit 0.5` does not disable the cap on `read-primary` (cmdInboxMessages\' own inboxReadLimit site)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('f4-primary');
  try {
    register(home, repo, 'primary-f4p', undefined);
    seedPartition(home, repo, 'primary-f4p', [{ body: 'own-a', ts: 1000 }, { body: 'own-b', ts: 1100 }]);

    // read-primary (doAck:true) is the wantsUnion-gated path, so the cap
    // step actually runs regardless of sibling presence — `inbox messages
    // --unread` (no --ack) does NOT set wantsUnion and never caps a
    // single-partition workspace at all, so it is not a valid probe here.
    const r = cli.run(['inbox', 'read-primary', 'primary-f4p', '--ack-as-owner', '--limit', '0.5'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.limit, 1, 'cmdInboxMessages\' own --limit parse must also floor to a minimum of 1');
    assert.equal(r.result.messages.length, 1);
  } finally { rm(home); rm(repo); }
});

test('F4 mutation check: reverting to plain Math.floor(n) reproduces the disabled-cap bug', () => {
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  const fixed1 = 'if (Number.isFinite(n) && n > 0) inboxReadLimit = Math.max(1, Math.floor(n)); // F4: a fractional --limit (e.g. 0.5) must not floor to 0 and disable the cap';
  const fixed2 = 'if (Number.isFinite(n) && n > 0) inboxCapLimit = Math.max(1, Math.floor(n)); // F4: same fix, same reasoning as inboxReadLimit above';
  assert.ok(liveBefore.includes(fixed1) && liveBefore.includes(fixed2), 'both F4 fix sites must be present verbatim');
  const buggy1 = 'if (Number.isFinite(n) && n > 0) inboxReadLimit = Math.floor(n);';
  const buggy2 = 'if (Number.isFinite(n) && n > 0) inboxCapLimit = Math.floor(n);';
  const copy = mutantKit.createCopy('anti-hall-fixwave2-f4');
  try {
    mutantKit.mutateWith(copy.devswarmPath, (before) => before.replace(fixed1, buggy1).replace(fixed2, buggy2));
    const mutatedCli = mutantKit.requireFresh(copy.devswarmPath);
    const home = tmpHome();
    const repo = makeGitRepo('f4-mutant');
    try {
      register(home, repo, 'primary-f4m', undefined);
      register(home, repo, 'sibling-f4m', undefined);
      seedPartition(home, repo, 'sibling-f4m', [{ body: 'f4m-a', ts: 1000 }, { body: 'f4m-b', ts: 1100 }]);
      const r = mutatedCli.run(['inbox', 'read', 'primary-f4m', '--limit', '0.5'], ctx(home, { cwd: repo }));
      // OLD buggy code: n=0.5 fails `n > 0`? No, 0.5 > 0 is true, so
      // inboxCapLimit = Math.floor(0.5) = 0 -- the cap becomes 0, and (per
      // F4's own description) meshAddedUnreadCount is driven to 0 too.
      assert.equal(r.result.limit, 0, 'OLD buggy floor: limit becomes 0, disabling the cap contract');
    } finally { rm(home); rm(repo); }
  } finally {
    mutantKit.discardCopy(copy);
  }
  mutantKit.assertLiveUntouched(liveBefore, assert);
});

// ---------------------------------------------------------------------------
// F5 — a null store row must not poison / crash / leak into deliveredRows
// ---------------------------------------------------------------------------

// F5's own real-world reachability note: BOTH production call sites build
// `part.messages` via `.map((r) => Object.assign({ partitionId: pid }, r))`
// (or the __srcId-tagged equivalent in cmdInboxMessages) — `Object.assign`
// silently absorbs a `null` source into `{}` rather than propagating it, so
// a literal `null` element returned by `listMessages()` is ALREADY
// sanitized into a harmless empty-ish object before `foldSiblingGapRows`
// ever sees it (verified live: injecting a null via a monkeypatched
// `listMessages` and reading through the CLI end-to-end produces
// `{partitionId:'...'}` in `part.messages`, never a bare `null`). The
// reachable corruption shape is therefore narrower than "any null in the
// store" — e.g. a sparse/holey array from a corrupted read, where
// `Array.prototype.map` preserves holes (skips invoking the callback) and a
// `for...of` walk over the result still yields `undefined` at that index.
// `foldSiblingGapRows` is tested here in ISOLATION (temporarily exported via
// a transient mutant, reverted after) so the fix is verified against its own
// real contract — `rows` containing a genuine `null`/`undefined` element —
// rather than through a CLI path that happens to sanitize it first.
function withExportedFold(fn) {
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  const anchor = 'run, parseArgs, one, many, csvList,';
  assert.ok(liveBefore.includes(anchor), 'module.exports anchor not found verbatim');
  const copy = mutantKit.createCopy('anti-hall-fixwave2-f5-export');
  try {
    mutantKit.mutate(copy.devswarmPath, anchor, anchor + '\n  foldSiblingGapRows,');
    fn(mutantKit.requireFresh(copy.devswarmPath));
  } finally {
    mutantKit.discardCopy(copy);
  }
  mutantKit.assertLiveUntouched(liveBefore, assert);
}

test('F5 RED/GREEN: foldSiblingGapRows skips a null/undefined row, never leaks it into deliveredRows, and does not throw', () => {
  withExportedFold((mutatedCli) => {
    const seenHashes = new Set();
    const rows = [
      { hash: 'h1', body: 'before-null', mtype: 'direct', sender: 'a', recipient: 'b' },
      null,
      { hash: 'h2', body: 'after-null', mtype: 'direct', sender: 'a', recipient: 'b' },
    ];
    const result = mutatedCli.foldSiblingGapRows(rows, seenHashes);
    assert.ok(!result.deliveredRows.some((r) => r === null || r === undefined), 'THE FIX: neither null nor undefined must ever appear in deliveredRows');
    assert.deepEqual(result.deliveredRows.map((r) => r.body), ['before-null'], 'the row before the null is delivered; the null poisons the window so after-null is withheld, not lost');
    assert.equal(result.gapWithheldCount, 1);

    // A sparse-array hole (Array.prototype.map preserves holes; a for...of
    // walk yields `undefined` there) is the more realistic corruption shape.
    const holeyRows = new Array(3);
    holeyRows[0] = { hash: 'h3', body: 'before-hole', mtype: 'direct', sender: 'a', recipient: 'b' };
    holeyRows[2] = { hash: 'h4', body: 'after-hole', mtype: 'direct', sender: 'a', recipient: 'b' };
    const result2 = mutatedCli.foldSiblingGapRows(holeyRows, new Set());
    assert.ok(!result2.deliveredRows.some((r) => r === null || r === undefined));
    assert.deepEqual(result2.deliveredRows.map((r) => r.body), ['before-hole']);
  });
});

test('F5 mutation check: removing the null-guard reproduces a thrown exception reading `.hash` off null', () => {
  const oldStr = '    if (!row) { // F5: corrupted row skipped, still poisons subsequent rows\n'
    + '      gapSeen = true;\n'
    + '      if (!wasGapSeen) consumedCount++; // G1: unrecoverable either way — consume it so the ack cursor can pass it forever\n'
    + '      continue;\n'
    + '    }\n';
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  assert.ok(liveBefore.includes(oldStr), 'F5 guard not found verbatim');
  const buggyStr = '';
  const anchor = 'run, parseArgs, one, many, csvList,';
  assert.ok(liveBefore.includes(anchor), 'module.exports anchor not found verbatim');
  const copy = mutantKit.createCopy('anti-hall-fixwave2-f5-nullguard');
  try {
    mutantKit.mutateWith(copy.devswarmPath, (src) => src.replace(oldStr, buggyStr).replace(anchor, anchor + '\n  foldSiblingGapRows,'));
    const mutatedCli = mutantKit.requireFresh(copy.devswarmPath);
    let threw = false;
    let thrownMessage = '';
    try {
      mutatedCli.foldSiblingGapRows([{ hash: 'h1', body: 'before-null', mtype: 'direct', sender: 'a', recipient: 'b' }, null, { hash: 'h2', body: 'after-null', mtype: 'direct', sender: 'a', recipient: 'b' }], new Set());
    } catch (e) {
      threw = true;
      thrownMessage = String((e && e.message) || e);
    }
    assert.ok(threw, 'OLD code (no null-guard): must throw reading `.hash` off the null row — it did not, mutant not reproduced');
    assert.match(thrownMessage, /cannot read propert/i);
  } finally {
    mutantKit.discardCopy(copy);
  }
  mutantKit.assertLiveUntouched(liveBefore, assert);
});

// ---------------------------------------------------------------------------
// Cap-priority ordering across MULTIPLE non-empty sources (test gap closed)
// ---------------------------------------------------------------------------

test('cap priority: own rows are kept first, then siblings in group order, when a --limit cuts across THREE non-empty sources', () => {
  const home = tmpHome();
  const repo = makeGitRepo('cap-priority');
  try {
    register(home, repo, 'primary-cp', undefined);
    register(home, repo, 'sib1-cp', undefined);
    register(home, repo, 'sib2-cp', undefined);
    seedPartition(home, repo, 'primary-cp', [{ body: 'own-1', ts: 1000 }, { body: 'own-2', ts: 1100 }]);
    seedPartition(home, repo, 'sib1-cp', [{ body: 'sib1-1', ts: 2000 }, { body: 'sib1-2', ts: 2100 }]);
    seedPartition(home, repo, 'sib2-cp', [{ body: 'sib2-1', ts: 3000 }, { body: 'sib2-2', ts: 3100 }]);

    // 6 rows total across 3 sources, --limit 3: own (2) fully kept, sib1
    // gets the remaining 1 (its FIRST row only), sib2 gets 0.
    const r = cli.run(['inbox', 'read', 'primary-cp', '--limit', '3'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.meshMessages.length, 3);
    assert.equal(r.result.truncated, true);
    assert.equal(r.result.truncatedCount, 3);
    const bodies = r.result.meshMessages.map((m) => m.body);
    assert.ok(bodies.includes('own-1') && bodies.includes('own-2'), 'both own rows must be kept (own-source priority)');
    assert.ok(bodies.includes('sib1-1'), 'sib1 must get its FIRST row (the remaining budget), not sib2');
    assert.ok(!bodies.includes('sib1-2'), 'sib1\'s SECOND row must be withheld (only 1 slot of budget remained for sib1)');
    assert.ok(!bodies.includes('sib2-1') && !bodies.includes('sib2-2'), 'sib2 gets nothing — no budget remained after own+sib1');
  } finally { rm(home); rm(repo); }
});

test('cap priority mutation check: reversing own/sibling cap order flips which source is kept', () => {
  const oldStr = 'ownKeptCount = Math.min(ownRowsTotal, remaining);\n'
    + '      remaining -= ownKeptCount;\n'
    + '      storeOnlyUnreadRows = ownRows.slice(0, ownKeptCount);\n'
    + '      for (const part of meshSiblingPartitions) {\n'
    + '        const rows = part.deliveredRows || [];\n'
    + '        const keep = Math.min(rows.length, remaining);\n'
    + '        remaining -= keep;\n'
    + '        part.deliveredCount = keep; // overwrite: post-cap kept count, what the ack step below may advance past\n'
    + '        // G1/G2 fix: the PHYSICAL row count to advance past for these `keep`\n'
    + '        // delivered rows — see foldSiblingGapRows\'s header comment\n'
    + '        // (~line 1437) and the cmdInboxMessages call site (~line 4282). When\n'
    + '        // `keep` covers the partition\'s ENTIRE deliveredRows (nothing\n'
    + '        // actually capped here), use the fold\'s own full `consumedCount` —\n'
    + '        // it also covers a TRAILING consumed-but-undelivered row (e.g. a\n'
    + '        // dedup after the last delivered row) that `consumedThrough` cannot\n'
    + '        // see. Otherwise use `consumedThrough[keep - 1]`.\n'
    + '        // NOTE: the "nothing capped for this partition" check MUST run\n'
    + '        // BEFORE the `keep <= 0` short-circuit — G1\'s exact wedge case has\n'
    + '        // `keep === 0 === rows.length` (nothing delivered AND nothing\n'
    + '        // capped, e.g. a `[hole]`-only window), and that case still needs\n'
    + '        // `part.consumedCount` (1, the hole itself), not a hard 0.\n'
    + '        const consumedThrough = Array.isArray(part.consumedThrough) ? part.consumedThrough : null;\n'
    + '        part.physicalConsumed = (keep >= rows.length && Number.isFinite(part.consumedCount))\n'
    + '          ? part.consumedCount\n'
    + '          : (keep <= 0\n'
    + '            ? 0\n'
    + '            : (consumedThrough && Number.isFinite(consumedThrough[keep - 1]) ? consumedThrough[keep - 1] : keep));\n'
    + '        if (keep) storeOnlyUnreadRows = storeOnlyUnreadRows.concat(rows.slice(0, keep));\n'
    + '      }';
  assert.ok(fs.readFileSync(DEVSWARM_PATH, 'utf8').includes(oldStr), 'cap-priority block not found verbatim');
  // Mutant: siblings get priority BEFORE own rows.
  const buggyStr = 'let __ownKeep = 0;\n'
    + '      storeOnlyUnreadRows = [];\n'
    + '      for (const part of meshSiblingPartitions) {\n'
    + '        const rows = part.deliveredRows || [];\n'
    + '        const keep = Math.min(rows.length, remaining);\n'
    + '        remaining -= keep;\n'
    + '        part.deliveredCount = keep;\n'
    + '        part.physicalConsumed = keep;\n'
    + '        if (keep) storeOnlyUnreadRows = storeOnlyUnreadRows.concat(rows.slice(0, keep));\n'
    + '      }\n'
    + '      __ownKeep = Math.min(ownRowsTotal, remaining);\n'
    + '      remaining -= __ownKeep;\n'
    + '      ownKeptCount = __ownKeep;\n'
    + '      storeOnlyUnreadRows = ownRows.slice(0, ownKeptCount).concat(storeOnlyUnreadRows);';
  withMutant(oldStr, buggyStr, (mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('cap-priority-mutant');
    try {
      register(home, repo, 'primary-cpm', undefined);
      register(home, repo, 'sib1-cpm', undefined);
      seedPartition(home, repo, 'primary-cpm', [{ body: 'own-1', ts: 1000 }, { body: 'own-2', ts: 1100 }]);
      seedPartition(home, repo, 'sib1-cpm', [{ body: 'sib1-1', ts: 2000 }, { body: 'sib1-2', ts: 2100 }]);
      const r = mutatedCli.run(['inbox', 'read', 'primary-cpm', '--limit', '3'], ctx(home, { cwd: repo }));
      const bodies = r.result.meshMessages.map((m) => m.body);
      // Mutant: sibling gets priority, so BOTH sib1 rows are kept and only
      // ONE own row survives -- own-2 is withheld instead of sib1-2.
      assert.ok(!bodies.includes('own-2'), 'MUTANT (siblings-first): own-2 is wrongly withheld instead of a sibling row');
    } finally { rm(home); rm(repo); }
  });
});

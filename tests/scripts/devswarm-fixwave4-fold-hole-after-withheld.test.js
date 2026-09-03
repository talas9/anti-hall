'use strict';
// Wave 4 (deadly-loop Round-4 Reviewer, mutation V3) — untested loss path on
// `foldSiblingGapRows`'s hole branch.
//
// PLACE IN SCOPE: intentionally a NEW file, not appended to
// tests/scripts/devswarm-fixwave3-g1-g2-g3.test.js (which already covers
// G1/G2/G3 of `foldSiblingGapRows`) — Fix Wave 4's task explicitly reserves
// that file, `tests/scripts/lib/devswarm-mutant-kit.js`, and the sibling
// fixwave2/fixwave3 files for another concurrently-running agent. This file
// touches neither; it only READS `devswarm-mutant-kit.js` (shared helper,
// safe to require from any test file) and the LIVE
// `plugins/anti-hall/scripts/devswarm.js` (read-only — see
// `devswarm-mutant-kit.js`'s own header for why every mutation here runs
// against an isolated scratch copy, never the live file on disk).
//
// THE GAP this closes: `foldSiblingGapRows` (scripts/devswarm.js ~line 1482)
// guards its hole (`if (!row) {...}`) and dedup (`if (row.hash && ...)`)
// branches with `if (!wasGapSeen) consumedCount++` — `wasGapSeen` is the
// value of `gapSeen` captured at the START of the current row, BEFORE this
// row's own processing can set it. The guard's whole point is: once a gap
// has ALREADY been triggered by an earlier row in this window, every row
// after it (hole, dedup, or otherwise) is withheld — NOTHING after the
// trigger may advance `consumedCount`, because `consumedCount` is exactly
// what an ack loop adds to a sibling partition's cursor
// (`part.cursor + physicalConsumed`, scripts/devswarm.js ~line 4295-4302 /
// ~line 4938-4940) to decide how many PHYSICAL rows it is safe to skip past.
//
// No existing test drives a window shaped `[N, F-withheld, H]` — a row that
// TRIGGERS the gap (N, delivered), followed by a genuine forwardable
// message that gets withheld BECAUSE of that gap (F), followed by a
// TRAILING hole/corrupted row (H) that arrives AFTER the withholding has
// already started. Fix Wave 3's G1 test only covers `[hole, direct]` (hole
// FIRST, nothing withheld yet) — it never exercises the hole branch's
// `!wasGapSeen` guard actually being false-guarded (H arriving AFTER F was
// already withheld). Dropping that guard on the hole branch specifically
// (the reviewer's mutation V3, `devswarm.js:1492`) lets H's consumedCount++
// fire even though F sits physically BETWEEN N and H — the ack target then
// becomes `part.cursor + 2` (N and H), which is a POSITIONAL/COUNT-based
// skip over the first 2 physical rows of the partition's natural order.
// Since F occupies physical position 1 (between N at 0 and H at 2), a
// count-based skip of 2 skips PAST F too — a real, never-delivered message
// is permanently lost (the cursor never revisits it; F is not "withheld
// forever", it is gone).
//
// MUTANTS THIS TEST IS DESIGNED TO KILL (documented here, not just in the
// report — see the task's own instruction):
//   1. THE ONE UNDER TEST: drop the `!wasGapSeen` guard on the HOLE branch
//      only (`if (!wasGapSeen) consumedCount++;` -> `consumedCount++;` inside
//      `if (!row) { ... }`) — devswarm.js:1492. Verified below with a live
//      apply-and-run (RED then GREEN), not just described.
//   2. The dedup branch's sibling guard (`if (!wasGapSeen) consumedCount++;`
//      inside `if (row.hash && seenHashes.has(row.hash))`, devswarm.js:1496)
//      has the SAME shape and the SAME hazard for a duplicate arriving after
//      a gap trigger — asserted structurally below (not applied as a live
//      mutant; the hole-branch case above already proves the mechanism, and
//      duplicating the apply-and-run machinery for the twin guard would not
//      add new signal beyond the assertion already made).
//
// APPROACH: a direct UNIT-level call into `foldSiblingGapRows` (no store, no
// registry, no `run()` dispatch — same lighter-weight pattern Fix Wave 3's
// own G2 unit test uses) via `devswarm-mutant-kit.js`'s scratch-copy export
// trick: copy `devswarm.js` to an isolated tmp file, add
// `foldSiblingGapRows` to its `module.exports`, `require()` the copy. The
// live file on disk is NEVER written — verified with a before/after
// `assertLiveUntouched` + this file's own shasum check in the task report.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DEVSWARM_PATH = path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js');
const mutantKit = require('./lib/devswarm-mutant-kit.js');

// EXPORT_ANCHOR — same anchor Fix Wave 3's G2 unit test uses to export the
// otherwise-private `foldSiblingGapRows` from a scratch copy without
// touching any other behavior.
const EXPORT_ANCHOR = 'run, parseArgs, one, many, csvList,';

// GUARD_OLD / GUARD_NEW — the exact mutation under test: removes the
// `!wasGapSeen` guard from ONLY the hole (`if (!row) {...}`) branch. Scoped
// tightly (matches the full 3-line `if (!row) { ... }` block, not a bare
// string) so this can never accidentally also match the dedup branch's
// textually-similar guard just below it.
const GUARD_OLD = "if (!row) { // F5: corrupted row skipped, still poisons subsequent rows\n"
  + "      gapSeen = true;\n"
  + "      if (!wasGapSeen) consumedCount++; // G1: unrecoverable either way — consume it so the ack cursor can pass it forever\n"
  + "      continue;\n"
  + "    }";
const GUARD_NEW = "if (!row) { // F5: corrupted row skipped, still poisons subsequent rows\n"
  + "      gapSeen = true;\n"
  + "      consumedCount++; // MUTANT (Wave 4 V3): !wasGapSeen guard dropped — over-consumes past a withheld row\n"
  + "      continue;\n"
  + "    }";

// buildWindow(): the `[N, F-withheld, H]` shape.
//   N — a native/non-forwardable row (mtype not 'direct'): DELIVERED, and it
//       is what TRIGGERS gapSeen for everything after it.
//   F — a genuine forwardable direct message: arrives AFTER the trigger, so
//       it is WITHHELD (this is the real message that must never be lost).
//   H — a trailing hole (`null`, i.e. a corrupted/unreadable row): arrives
//       AFTER F was already withheld.
function buildWindow() {
  return [
    { hash: 'native-trigger-hash', body: 'N-native-trigger', mtype: null, sender: null, recipient: null },
    { hash: 'real-forwardable-hash', body: 'F-real-withheld-message', mtype: 'direct', sender: 'alice', recipient: 'bob' },
    null, // H — trailing hole
  ];
}

function withExportedFold(fn) {
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  assert.ok(liveBefore.includes(EXPORT_ANCHOR), 'module.exports anchor not found verbatim in live devswarm.js');
  assert.ok(liveBefore.includes(GUARD_OLD), 'hole-branch !wasGapSeen guard not found verbatim at its expected shape in live devswarm.js (devswarm.js:1492 region)');
  const copy = mutantKit.createCopy('anti-hall-fixwave4-fold-hole');
  try {
    mutantKit.mutate(copy.devswarmPath, EXPORT_ANCHOR, EXPORT_ANCHOR + '\n  foldSiblingGapRows,');
    fn(mutantKit.requireFresh(copy.devswarmPath), copy);
  } finally {
    mutantKit.discardCopy(copy);
  }
  mutantKit.assertLiveUntouched(liveBefore, assert);
}

// GREEN: today's real source (guard present) — the correct, safe result.
test('GREEN: [N, F-withheld, H] — a trailing hole after a withheld row must not extend consumedCount past the withheld message', () => {
  withExportedFold((cli) => {
    const rows = buildWindow();
    const result = cli.foldSiblingGapRows(rows, new Set());

    assert.deepEqual(result.deliveredRows.map((r) => r.body), ['N-native-trigger'],
      'only N is delivered — F is withheld (real message, not lost) and H is a hole (never delivered)');
    assert.equal(result.deliveredCount, 1);
    // Only F is counted as `gapWithheldCount` — the trailing hole H is
    // caught by the earlier `if (!row)` branch (a hole is always "resolved"
    // one way or another, never reported as an ordinary withheld message),
    // so it does not add to this counter. The invariant this test actually
    // guards is `consumedCount` below, not this field.
    assert.equal(result.gapWithheldCount, 1, 'F is withheld; the trailing hole H is resolved via the hole branch, not counted here');
    // THE INVARIANT UNDER TEST: consumedCount must stop at 1 (only N, the
    // trigger row itself) — the trailing hole H must NOT also increment it,
    // because doing so would make the physical ack target skip past F.
    assert.equal(result.consumedCount, 1,
      'consumedCount must be exactly 1 (only the trigger row N) — H arrives AFTER F was already withheld and must not be separately consumed');
    assert.deepEqual(result.consumedThrough, [1]);

    // Prove the real-world consequence directly: the ack target an ack loop
    // would compute from this result (part.cursor + physicalConsumed, using
    // consumedCount as the full-ack case does — scripts/devswarm.js
    // ~line 4295-4297 / ~line 4938-4939) must land BEFORE F's physical
    // index, so F survives into the next read's window.
    const cursor = 0;
    const ackTarget = cursor + result.consumedCount;
    const fIndex = rows.findIndex((r) => r && r.body === 'F-real-withheld-message');
    assert.ok(ackTarget <= fIndex, `ack target (${ackTarget}) must not pass F's physical index (${fIndex}) — F must still be in the next read's window`);
    const nextWindow = rows.slice(ackTarget);
    assert.ok(nextWindow.some((r) => r && r.body === 'F-real-withheld-message'),
      'F must still be present in what the next read would see at this ack target — nothing lost');
  });
});

// RED: the reviewer's mutation V3 applied live (guard-removal) — reproduces
// the loss the guard exists to prevent. Same scratch copy as GREEN above
// (export + this ADDITIONAL mutation), proving this test is NOT vacuous —
// it genuinely fails without the guard and passes with it.
test('RED (mutation V3, killed): dropping the hole branch\'s !wasGapSeen guard makes the ack target skip PAST the withheld real message', () => {
  withExportedFold((_exportedOnlyCli, copy) => {
    // Compose the SECOND mutation onto the SAME scratch copy (same pattern
    // Fix Wave 3's own "G1 mutation check" test uses) so this reproduces
    // the export + guard-removal TOGETHER, not two independent copies.
    mutantKit.mutate(copy.devswarmPath, GUARD_OLD, GUARD_NEW);
    const mutatedCli = mutantKit.requireFresh(copy.devswarmPath);

    const rows = buildWindow();
    const result = mutatedCli.foldSiblingGapRows(rows, new Set());

    // The bug: H (the trailing hole) ALSO increments consumedCount now,
    // even though wasGapSeen was already true when H was processed.
    assert.equal(result.consumedCount, 2,
      'MUTANT: consumedCount incorrectly counts BOTH N and the trailing hole H, even though F sits physically between them and was already withheld');

    // THE LOSS, proven directly: the ack target this (buggy) result implies
    // now passes F's physical index — F drops out of the next read's
    // window entirely. This is exactly the shape this test exists to catch;
    // it is a genuine RED against the fixed source (see GREEN test above,
    // where the SAME assertion on consumedCount is 1, not 2).
    const cursor = 0;
    const ackTarget = cursor + result.consumedCount;
    const fIndex = rows.findIndex((r) => r && r.body === 'F-real-withheld-message');
    assert.ok(ackTarget > fIndex, `sanity: this mutant's ack target (${ackTarget}) must exceed F's index (${fIndex}) to reproduce the loss shape (if this fails, the mutant string no longer reproduces the bug)`);
    const nextWindow = rows.slice(ackTarget);
    assert.ok(!nextWindow.some((r) => r && r.body === 'F-real-withheld-message'),
      'MUTANT reproduces the loss: F is no longer present in what the next read would see at this (over-advanced) ack target — a real message is gone, not just withheld');
  });
});

// Structural note on the twin guard (dedup branch, devswarm.js:1496) — same
// shape (`if (!wasGapSeen) consumedCount++;`), same hazard if ever dropped;
// not separately live-mutated here since the mechanism (an unguarded
// consumedCount++ on a row after wasGapSeen was already true) is identical
// to the hole-branch case already proven RED/GREEN above.
test('sanity: the dedup branch (devswarm.js:1496) guards consumedCount the same way — same mechanism as the hole branch under test', () => {
  const src = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  const dedupGuard = "if (row.hash && seenHashes.has(row.hash)) { // exact-hash duplicate — never counted as withheld\n"
    + "      if (!wasGapSeen) consumedCount++; // G2: a physical row was resolved here even though nothing was delivered\n"
    + "      continue;\n"
    + "    }";
  assert.ok(src.includes(dedupGuard), 'dedup branch must carry the same !wasGapSeen guard shape as the hole branch');
});

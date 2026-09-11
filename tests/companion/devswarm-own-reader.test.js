'use strict';
// devswarm-own-reader.js — the fix for defect f061789267c1 / a77b85571dfa (P0):
// devswarm-store.js's computeSummary() sizes workspaces[id].unread from
// `total - cursorValue(id)`, where cursorValue(id) is the SHARED pair tracking
// the MIN across every live `<id>#inst-<nonce>` instance-cursor file (0.99.0's
// per-instance-cursor fix, defect 8b211241bbe9). That min-floor is correct for
// the shared pair's own cross-instance-safety contract but WRONG as a
// PER-READER display: a reader that has genuinely drained its own mail can
// still be shown a phantom backlog borrowed from a slower/stale sibling
// instance file (routinely still present — evicted only after the 7-day
// gcInstanceCursors window).
//
// These tests exercise companion/lib/devswarm-own-reader.js directly (the ONE
// shared implementation hooks/devswarm-parent-gate.js,
// hooks/devswarm-parent-inbox.js and hooks/devswarm-child-turn.js all now
// call), in-process, by monkeypatching ONLY scripts/devswarm.js's
// deriveInstanceNonce export on the cached module object (same Module-cache
// instance devswarm-own-reader.js's lazy require resolves to) — every other
// export (shortInstanceNonce, instanceCursorPath, gcInstanceCursors) stays
// REAL, so the short-nonce filenames these tests write are genuine sha1
// digests of the fixed test nonce, not fixture-only values.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const ownReader = require(path.join(ROOT, 'companion', 'lib', 'devswarm-own-reader.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ownreader-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'cursors'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function cursorsDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'cursors'); }
function writeInst(home, id, short, value, ageMs) {
  const p = path.join(cursorsDir(home), id + '#inst-' + short + '.json');
  fs.writeFileSync(p, String(value));
  if (Number.isFinite(ageMs)) {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(p, t, t);
  }
  return p;
}
function writeBaseline(home, id, value) {
  fs.writeFileSync(path.join(cursorsDir(home), id + '#base.json'), String(value));
}
const DAY = 24 * 60 * 60 * 1000;

// withPinnedNonce(fixedNonce, fn) — patches cli.deriveInstanceNonce to return
// `fixedNonce` for the duration of `fn`, restoring the original afterward
// (even on throw). Returns the REAL shortInstanceNonce(fixedNonce) so callers
// can name the instance-cursor file that identity resolves to.
function withPinnedNonce(fixedNonce, fn) {
  const orig = cli.deriveInstanceNonce;
  cli.deriveInstanceNonce = () => fixedNonce;
  try {
    return fn(cli.shortInstanceNonce(fixedNonce));
  } finally {
    cli.deriveInstanceNonce = orig;
  }
}

test('(a) live incident shape: fresh reader at 929, stale (but in-window) sibling at 859, total 930 -> fresh reader sees ~0-1 unread, not 71', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w1', 0);
    // The reader's OWN instance file (fresh, at 929) and a 3-day-old sibling's
    // file (859) — inside the 7-day eviction window, so a real deployment
    // would still have both present.
    const fresh = withPinnedNonce('reader-fresh', (short) => {
      writeInst(home, 'w1', short, 929, 0);
      return short;
    });
    writeInst(home, 'w1', 'ffffff', 859, 3 * DAY); // stale sibling, unrelated short id
    // The shared pair (what commitInstanceAck would have written): min(929,859)=859.
    const entry = { unread: 930 - 859, cursor: 859, total: 930 };
    assert.strictEqual(entry.unread, 71, 'sanity: this is the exact pre-fix phantom number from the live incident');
    const result = withPinnedNonce('reader-fresh', (short) => ownReader.ownReaderUnread(home, '/some/wt', 'w1', entry, entry.unread));
    assert.strictEqual(result, 1, 'the fresh reader (cursor 929, total 930) truly has exactly 1 unread row, not the sibling-borrowed 71');
    assert.notStrictEqual(fresh, 'ffffff', 'sanity: the two instances must be distinct files');
  } finally { rm(home); }
});

test('(b) genuinely-unread case: nothing is hidden when the reader really is behind', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w2', 0);
    withPinnedNonce('reader-behind', (short) => writeInst(home, 'w2', short, 100, 0));
    writeInst(home, 'w2', 'aaaaaa', 100, 0); // a sibling at the SAME position — shared floor is also 100
    const entry = { unread: 250 - 100, cursor: 100, total: 250 };
    const result = withPinnedNonce('reader-behind', () => ownReader.ownReaderUnread(home, '/some/wt', 'w2', entry, entry.unread));
    assert.strictEqual(result, 150, 'a reader genuinely behind must see its full real backlog, unreduced');
  } finally { rm(home); }
});

test('(c) reader with no instance file falls back to the shared cursor (delta 0), unchanged pre-fix behavior', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w3', 0);
    writeInst(home, 'w3', 'bbbbbb', 40, 0); // some OTHER instance exists, but not this reader's
    const entry = { unread: 100 - 40, cursor: 40, total: 100 };
    const result = withPinnedNonce('reader-newcomer', () => ownReader.ownReaderUnread(home, '/some/wt', 'w3', entry, entry.unread));
    assert.strictEqual(result, 60, 'a newcomer with no own instance file starts AT the floor by construction (siblingBaseCursor contract) -> delta 0, byte-identical to the pre-fix number');
  } finally { rm(home); }
});

test('(d) GC-CADENCE NON-FIX: a stale sibling inside the 7-day window still causes the phantom after GC runs — proves a cheaper GC cadence cannot be the fix', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w4', 0);
    withPinnedNonce('reader-fresh-d', (short) => writeInst(home, 'w4', short, 500, 0));
    writeInst(home, 'w4', 'cccccc', 300, 3 * DAY); // 3 days old: inside the 7-day window
    // Run the REAL gcInstanceCursors hygiene pass — even immediately, right now.
    const r = cli.gcInstanceCursors(null, home, {});
    assert.strictEqual(r.deleted, 0, 'a 3-day-old file is well inside the 7-day staleness window and must NOT be evicted by any GC cadence');
    // The shared floor (what a real commitInstanceAck would compute) is still min(500,300)=300.
    const entry = { unread: 600 - 300, cursor: 300, total: 600 };
    const rawPhantom = entry.unread;
    assert.strictEqual(rawPhantom, 300, 'sanity: the pre-fix number is still phantom-inflated after GC ran');
    // Without the own-cursor fix, the raw entry.unread (300) would still be shown.
    // WITH the fix, the reader's true position (500) is used instead:
    const result = withPinnedNonce('reader-fresh-d', () => ownReader.ownReaderUnread(home, '/some/wt', 'w4', entry, entry.unread));
    assert.strictEqual(result, 100, 'the own-cursor fix corrects the phantom regardless of GC cadence — GC eviction timing is orthogonal to this defect');
  } finally { rm(home); }
});

test('(e) two live readers at different positions each see their own correct number', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w5', 0);
    withPinnedNonce('reader-A', (short) => writeInst(home, 'w5', short, 800, 0));
    withPinnedNonce('reader-B', (short) => writeInst(home, 'w5', short, 950, 0));
    // Shared floor = min(800,950) = 800; total = 1000.
    const entry = { unread: 1000 - 800, cursor: 800, total: 1000 };
    const resultA = withPinnedNonce('reader-A', () => ownReader.ownReaderUnread(home, '/some/wt', 'w5', entry, entry.unread));
    const resultB = withPinnedNonce('reader-B', () => ownReader.ownReaderUnread(home, '/some/wt', 'w5', entry, entry.unread));
    assert.strictEqual(resultA, 200, 'reader A (cursor 800) genuinely has 200 unread');
    assert.strictEqual(resultB, 50, 'reader B (cursor 950) genuinely has only 50 unread, not the shared-floor-derived 200');
  } finally { rm(home); }
});

test('resolution failure (deriveInstanceNonce throws) fails open to the raw pre-fix number, never worse', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w6', 0);
    const orig = cli.deriveInstanceNonce;
    cli.deriveInstanceNonce = () => { throw new Error('SIMULATED: cannot derive'); };
    try {
      const entry = { unread: 55, cursor: 10, total: 65 };
      const result = ownReader.ownReaderUnread(home, '/some/wt', 'w6', entry, entry.unread);
      assert.strictEqual(result, 55, 'a derivation failure must fail open to the raw number — never crash, never regress below pre-fix behavior');
    } finally { cli.deriveInstanceNonce = orig; }
  } finally { rm(home); }
});

test('old-shape entry with no `cursor` field (pre-fix summary) leaves delta at 0 — byte-identical to legacy behavior', () => {
  const home = tmpHome();
  try {
    const entry = { unread: 42 }; // no `cursor` field at all
    const result = ownReader.ownReaderUnread(home, '/some/wt', 'w7', entry, entry.unread);
    assert.strictEqual(result, 42, 'an entry missing `cursor` (older summary shape) must be unaffected by this fix');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// P1 STALE-CACHE GUARD + AMBIGUOUS-BRANCH LIVE RESOLUTION (Critic NO-GO,
// 2026-09-11, two rounds). Round 1: when this reader's LIVE instance cursor
// has caught up to or passed what the CACHED summary's `total` ever
// recorded, the raw subtraction could floor to 0 even though real unread
// mail may exist that landed after the snapshot. Round 2 (GO-with-fix): a
// bare UNKNOWN there left the reporter's own exact shape (own==cached total)
// blocked forever on a healthy summary, so this branch now pays for ONE live
// store read to resolve it for real (see devswarm-own-reader.js's own
// header). These two tests use an UNRESOLVABLE fake worktree path
// (`/some/wt` — no real git repo, no real store) specifically so the live
// read itself CANNOT succeed, proving that fail mode still returns `null`
// (UNKNOWN), never a guessed 0. The tests proving the live read actually
// RESOLVES the ambiguity (0 for a genuinely-drained reader, the real count
// for one behind new mail) live in
// tests/companion/devswarm-summary-cursor-derivation.test.js, which already
// has the real git-repo + store infrastructure this needs.
// ---------------------------------------------------------------------------

test('(f) STALE-CACHE, live resolution UNAVAILABLE: own cursor (1500) EXCEEDS the cached total (930), no real store to check -> null, never 0', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w8', 0);
    withPinnedNonce('reader-way-ahead', (short) => writeInst(home, 'w8', short, 1500, 0));
    const entry = { unread: 71, cursor: 859, total: 930 };
    const result = withPinnedNonce('reader-way-ahead', () => ownReader.ownReaderUnread(home, '/some/wt', 'w8', entry, entry.unread));
    assert.strictEqual(result, null, 'own cursor (1500) exceeding the cached total (930), with no resolvable store to settle it live, must be UNKNOWN, not a computed 0');
  } finally { rm(home); }
});

test('(g) STALE-CACHE, live resolution UNAVAILABLE: own cursor EQUALS the cached total exactly (930 vs 930), no real store to check -> STILL null, not 0', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w9', 0);
    withPinnedNonce('reader-exact-total', (short) => writeInst(home, 'w9', short, 930, 0));
    const entry = { unread: 71, cursor: 859, total: 930 };
    const result = withPinnedNonce('reader-exact-total', () => ownReader.ownReaderUnread(home, '/some/wt', 'w9', entry, entry.unread));
    assert.strictEqual(result, null, 'own cursor equal to the cached total, with no resolvable store to settle it live, cannot be distinguished from "mail arrived after the snapshot" -> must be UNKNOWN, not 0');
  } finally { rm(home); }
});

test('(a) re-confirmed under the P1 guard: the in-window field case (own 929 < cached total 930) still computes a real number (1), not UNKNOWN', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w10', 0);
    withPinnedNonce('reader-in-window', (short) => writeInst(home, 'w10', short, 929, 0));
    const entry = { unread: 71, cursor: 859, total: 930 };
    const result = withPinnedNonce('reader-in-window', () => ownReader.ownReaderUnread(home, '/some/wt', 'w10', entry, entry.unread));
    assert.strictEqual(result, 1, 'own cursor strictly below the cached total is cache-consistent -> still computes the real number, not UNKNOWN');
  } finally { rm(home); }
});

test('ownReaderDelta exposes { delta, stale } directly, matching ownReaderUnread\'s null contract', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w11', 0);
    withPinnedNonce('reader-stale-delta', (short) => writeInst(home, 'w11', short, 930, 0));
    const entry = { unread: 71, cursor: 859, total: 930 };
    const r = withPinnedNonce('reader-stale-delta', () => ownReader.ownReaderDelta(home, '/some/wt', 'w11', entry));
    assert.strictEqual(r.stale, true);
    assert.strictEqual(r.delta, 0, 'a stale result carries no usable delta');
  } finally { rm(home); }
});

// FOUR PRE-EXISTING FAIL-OPEN PATHS (Critic requirement: must all stay
// fail-open to the raw number, never turn into `null`/UNKNOWN under this
// guard) — restated explicitly here alongside the new stale-cache tests so
// the full contract lives in one place.
test('FAIL-OPEN 1/4: no instance file yet (newcomer) -> raw number, never null', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w12', 0);
    writeInst(home, 'w12', 'dddddd', 40, 0); // some OTHER instance, not this reader's
    const entry = { unread: 60, cursor: 40, total: 100 };
    const result = withPinnedNonce('reader-no-file', () => ownReader.ownReaderUnread(home, '/some/wt', 'w12', entry, entry.unread));
    assert.strictEqual(result, 60);
  } finally { rm(home); }
});

test('FAIL-OPEN 2/4: nonce derivation throws -> raw number, never null', () => {
  const home = tmpHome();
  const orig = cli.deriveInstanceNonce;
  cli.deriveInstanceNonce = () => { throw new Error('SIMULATED'); };
  try {
    const entry = { unread: 55, cursor: 10, total: 65 };
    const result = ownReader.ownReaderUnread(home, '/some/wt', 'w13', entry, entry.unread);
    assert.strictEqual(result, 55);
  } finally { cli.deriveInstanceNonce = orig; rm(home); }
});

test('FAIL-OPEN 3/4: old-shape entry with no `cursor` field -> raw number, never null', () => {
  const home = tmpHome();
  try {
    const entry = { unread: 42 };
    const result = ownReader.ownReaderUnread(home, '/some/wt', 'w14', entry, entry.unread);
    assert.strictEqual(result, 42);
  } finally { rm(home); }
});

test('FAIL-OPEN 4/4: own cursor at or below the shared floor (own === entry.cursor) -> delta 0, raw number, never null', () => {
  const home = tmpHome();
  try {
    writeBaseline(home, 'w15', 0);
    withPinnedNonce('reader-at-floor', (short) => writeInst(home, 'w15', short, 40, 0));
    const entry = { unread: 60, cursor: 40, total: 100 };
    const result = withPinnedNonce('reader-at-floor', () => ownReader.ownReaderUnread(home, '/some/wt', 'w15', entry, entry.unread));
    assert.strictEqual(result, 60, 'a reader exactly at the shared floor has no lead to subtract -> unchanged raw number');
  } finally { rm(home); }
});

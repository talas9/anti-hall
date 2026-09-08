'use strict';
// 8b211241bbe9 ITEM 3 — "read-primary ADVANCES THE CURSOR WITHOUT RETURNING THE
// MESSAGE" (observed 3486->3487 and 3480->3485 with count:0).
//
// THIS IS A SEPARATE MECHANISM from the shared-cursor defect, and per-instance
// cursors do NOT fix it. These are CHARACTERIZATION tests: they pin the current
// arithmetic and the asymmetry between the two ack paths so the mechanism is
// proven and cannot drift unnoticed. The behavioural fix (quarantine an
// undeliverable row before the cursor passes it) ships SEPARATELY — it needs the
// suppressed ROWS, and the code currently carries only a COUNT.
//
// WHEN THE FIX LANDS: the assertion marked CHARACTERIZATION below must be
// inverted to assert the cursor does NOT pass an undelivered row.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const DEVSWARM_PATH = path.join(ROOT, 'scripts', 'devswarm.js');

test('item 3: the sibling ack target is arithmetic over physicalConsumed, not the delivered rows', () => {
  const src = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  // The mechanism, pinned to the source: the sibling path adds a COUNT to the
  // partition cursor rather than deriving the target from a row that was
  // actually returned.
  assert.ok(src.includes('const ackTarget = part.cursor + physicalConsumed;'),
    'the `inbox ack` sibling loop must still compute its target as cursor + physicalConsumed');
  assert.ok(src.includes('which can exceed'),
    'and physicalConsumed is documented as able to EXCEED deliveredCount — that gap is the defect');
});

test('item 3: physicalConsumed derives from a COUNT, so the suppressed rows are not retained', () => {
  const src = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  assert.ok(src.includes('part.physicalConsumed = Number.isFinite(part.consumedCount)'),
    'physicalConsumed comes from part.consumedCount — a number, not a row set');
  assert.ok(!src.includes('part.suppressedRows'),
    'CHARACTERIZATION: no suppressed-row set exists yet. Quarantining undelivered rows requires '
    + 'threading one out of the cap/dedup step, which is why the behavioural fix ships separately.');
});

test('item 3: the two ack paths are ASYMMETRIC — read-primary is guarded, inbox ack is not', () => {
  const src = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  // read-primary only falls back to consumedCount when nothing was tail-capped.
  assert.ok(src.includes('const physicalConsumed = (deliveredCount >= fullDeliveredCount && Number.isFinite(part.consumedCount))'),
    'read-primary guards its fallback on the un-capped case');
  // `inbox ack` takes the fallback unconditionally — the more exposed path.
  assert.ok(src.includes('const physicalConsumed = Number.isFinite(part.physicalConsumed) ? part.physicalConsumed : deliveredCount;'),
    'the `inbox ack` sibling loop takes the fallback unconditionally — this is the path to reproduce against');
});

test('item 3: the own-partition path is already delivered-derived (the contrast that proves the asymmetry)', () => {
  const src = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  assert.ok(src.includes('const totalNow = ownMaxIndex !== null ? Math.max(storeCursorVal, ownMaxIndex) : storeCursorVal;'),
    'the caller\'s OWN partition derives its target from the max index of a row actually delivered — '
    + 'structurally unable to pass an undelivered row. The sibling path does not do this, and that is the whole of item 3.');
});

test('item 3: the journal makes a zero-delivery advance mechanically detectable', () => {
  const src = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  // Until the behavioural fix lands, the instrument is what names a recurrence.
  assert.ok(src.includes('delivered: Number.isFinite(rec.delivered) ? rec.delivered : null'),
    'every cursor record carries the delivered count, so `delivered:0` on an advance is visible without re-derivation');
});

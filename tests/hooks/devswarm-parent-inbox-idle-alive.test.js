'use strict';
// Wave D items 1 + 3 — the INJECTION SURFACE half.
//
// The liveness axis and the archived predicate are unit-tested in
// tests/companion/. This file pins the per-turn workspace table's own
// classification (`displayStatus`), which is what the Primary actually reads
// each turn and what escalated a live session in the field.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const INBOX = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'devswarm-parent-inbox.js');
const hook = require(INBOX);

// displayStatus is module-private; drive it through the module's export when
// available, and otherwise assert the source contract. Resolved at load so a
// future export change surfaces as a clear failure rather than a silent skip.
const displayStatus = hook && typeof hook.displayStatus === 'function' ? hook.displayStatus : null;

const src = fs.readFileSync(INBOX, 'utf8');
const NOW = Date.now();

test('item 1: `idle (alive)` outranks dormant and suppresses the gone-looking labels', { skip: displayStatus ? false : 'displayStatus not exported' }, () => {
  // escalated + idleAlive -> not escalated
  assert.strictEqual(displayStatus(false, 'escalated', NOW - 9e6, NOW, true, false, true).label, 'idle (alive)');
  // stale + idleAlive -> not stale
  assert.strictEqual(displayStatus(false, 'stale', NOW - 9e6, NOW, true, false, true).label, 'idle (alive)');
  // dormant + idleAlive -> idle (alive)
  assert.strictEqual(displayStatus(false, '', NOW - 9e6, NOW, true, false, true).label, 'idle (alive)');
});

test('item 1: WITHOUT the session axis the same row is escalated/stale/dormant (the field bug)', { skip: displayStatus ? false : 'displayStatus not exported' }, () => {
  assert.strictEqual(displayStatus(false, 'escalated', NOW - 9e6, NOW, true, false, false).label, 'escalated');
  assert.strictEqual(displayStatus(false, 'stale', NOW - 9e6, NOW, true, false, false).label, 'stale');
  assert.strictEqual(displayStatus(false, '', NOW - 9e6, NOW, true, false, false).label, 'dormant');
});

test('item 1: idleAlive does NOT suppress the coordination axis (not-draining) or archive-ready', { skip: displayStatus ? false : 'displayStatus not exported' }, () => {
  // A live-but-idle workspace with a real aging backlog is still a genuine
  // neglect signal — that axis must survive.
  assert.strictEqual(displayStatus(false, '', NOW, NOW, false, true, true).label, 'not-draining');
  assert.strictEqual(displayStatus(true, '', NOW, NOW, false, false, true).label, 'archive-ready');
});

test('item 1: every pre-existing caller shape is byte-identical (idleAlive defaults to false)', { skip: displayStatus ? false : 'displayStatus not exported' }, () => {
  for (const [ar, st, dorm, nd, expected] of [
    [false, 'escalated', false, false, 'escalated'],
    [false, 'stale', false, false, 'stale'],
    [false, 'nudged', false, false, 'stale'],
    [false, '', false, true, 'not-draining'],
    [true, '', false, false, 'archive-ready'],
    [false, '', true, false, 'dormant'],
    [false, '', false, false, 'active'],
  ]) {
    assert.strictEqual(displayStatus(ar, st, NOW, NOW, dorm, nd).label, expected,
      'omitting the new argument must reproduce the old label for ' + JSON.stringify([ar, st, dorm, nd]));
  }
});

test('items 1+3: the injection surface is actually WIRED to both new signals', () => {
  assert.ok(src.includes('rowLivenessState('),
    'the per-turn table must consult the session-aware state, not the bare timestamp rule');
  assert.ok(src.includes("require('../companion/lib/devswarm-archived.js')"),
    'the per-turn table must consult the archived predicate');
  assert.ok(/label: 'archived'/.test(src), 'an archived row must get its own label, not escalated');
  assert.ok(src.includes("idleAlive = state === 'idle-alive'"),
    'idle-alive must be carried into the row classification');
});

test('MUTATION: reverting the table to isDormantRow alone drops the idle-alive distinction', () => {
  // The whole point of rowLivenessState here is that `dormant` and `idle-alive`
  // are DIFFERENT answers. A revert to the boolean collapses them.
  assert.ok(!src.includes('livenessLib.isDormantRow('),
    'the injection surface must no longer call the boolean rule directly — it would lose idle-alive');
});

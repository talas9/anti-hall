'use strict';
// D11-A: the sibling-watermark read (readSiblingSeenCursor) -> conditional
// unlink (removeSiblingSeenCursor) at the read-primary ack path, and the
// notAckable branch's writeSiblingSeenCursor write, used to run with NO file
// locking at all — a documented TOCTOU (scripts/devswarm.js, the header
// comment above siblingWatermarkCovered): a concurrent write for the SAME
// (callerId, siblingId) pair landing between the read and the unlink loses
// that extension when the unlink fires.
//
// Fix: both call sites now run their body via withWatermarkLock(callerId,
// siblingId, home, fn) — the SAME per-(callerId,siblingId) advisory lock
// (reusing the existing withIdLock/recovery.js acquireLock machinery, keyed
// on the watermark file's own basename convention), so the two can never
// interleave for the same pair.
//
// This test proves the LOCK ITSELF is genuinely held for the full duration
// of the wrapped callback (a nested acquisition on the SAME key, from inside
// the callback, is refused) — the mechanism the two real call sites now both
// route through — rather than asserting on a real cross-process race, which
// a single Node process cannot reproduce deterministically.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const recovery = require('../../plugins/anti-hall/companion/lib/recovery.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-d11a-wml-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

test('D11-A: watermarkLockKey mirrors the watermark file\'s own basename convention', () => {
  assert.strictEqual(cli.watermarkLockKey('caller-1', 'sibling-2'), 'caller-1.seen-sibling-2');
  assert.strictEqual(cli.watermarkLockKey(null, 'sibling-2'), null, 'an unsafe/missing callerId yields no lock key (fail-open, matches siblingSeenCursorPath)');
  assert.strictEqual(cli.watermarkLockKey('a.seen-b', 'c'), null, 'a callerId containing the separator is refused, same as watermarkSafeId/siblingSeenCursorPath');
});

test('D11-A: withWatermarkLock genuinely holds the per-(callerId,siblingId) lock for the whole callback (a nested acquisition on the SAME key is refused)', () => {
  const home = tmpHome();
  try {
    const callerId = 'caller-A';
    const siblingId = 'sibling-B';
    let nestedAcquireResult = 'not-attempted';
    const outer = cli.withWatermarkLock(callerId, siblingId, home, () => {
      // While the outer withWatermarkLock call holds the lock, a second,
      // independent acquisition attempt on the EXACT SAME key (mirroring what
      // a genuinely concurrent second process would do) must be refused —
      // this is the mechanism that makes the write-site and the
      // read+unlink-site mutually exclusive for the same pair.
      const key = cli.watermarkLockKey(callerId, siblingId);
      const release = recovery.acquireLock(key, home);
      nestedAcquireResult = typeof release === 'function' ? 'acquired' : 'busy';
      if (typeof release === 'function') { try { release(); } catch (_) {} }
      return 'outer-done';
    });
    assert.strictEqual(outer, 'outer-done', 'withWatermarkLock returns the callback\'s own return value');
    assert.strictEqual(nestedAcquireResult, 'busy', 'a nested acquisition on the SAME (callerId,siblingId) key must be refused while withWatermarkLock still holds it — proving the write site and the read+unlink site cannot interleave for the same pair');

    // After withWatermarkLock returns, the lock is released — a fresh
    // acquisition on the same key now succeeds (no permanent wedge).
    const key = cli.watermarkLockKey(callerId, siblingId);
    const release2 = recovery.acquireLock(key, home);
    assert.strictEqual(typeof release2, 'function', 'the lock is released once withWatermarkLock returns');
    try { release2(); } catch (_) {}
  } finally { rm(home); }
});

test('D11-A: withWatermarkLock does NOT serialize two DIFFERENT (callerId,siblingId) pairs against each other', () => {
  const home = tmpHome();
  try {
    let nestedResult = 'not-attempted';
    cli.withWatermarkLock('caller-A', 'sibling-B', home, () => {
      const otherKey = cli.watermarkLockKey('caller-A', 'sibling-DIFFERENT');
      const release = recovery.acquireLock(otherKey, home);
      nestedResult = typeof release === 'function' ? 'acquired' : 'busy';
      if (typeof release === 'function') { try { release(); } catch (_) {} }
    });
    assert.strictEqual(nestedResult, 'acquired', 'a DIFFERENT sibling pair must not be blocked by an unrelated pair\'s lock');
  } finally { rm(home); }
});
